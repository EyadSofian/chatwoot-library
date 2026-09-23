import express from 'express';
import multer from 'multer';
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(appRoot, 'storage', 'uploads'));
const LIBRARY_FILE = path.resolve(process.env.LIBRARY_FILE || path.join(appRoot, 'storage', 'library.json'));
const PACKAGES_FILE = path.resolve(process.env.PACKAGES_FILE || path.join(path.dirname(LIBRARY_FILE), 'packages.json'));
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const JSON_UPLOAD_MAX_MB = Number(process.env.JSON_UPLOAD_MAX_MB || 15);
const LIBRARY_PIN = process.env.LIBRARY_PIN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CHATWOOT_URL = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '';
const PRIVATE_LIBRARY_EMAIL = String(
  process.env.PRIVATE_LIBRARY_EMAIL || 'ahmed.farouk@engosoft.com'
).trim().toLowerCase();
const PRIVATE_LIBRARY_PIN = String(process.env.PRIVATE_LIBRARY_PIN || '');
const app = express();

// Express 4 does not forward rejected promises from async handlers to the error
// middleware, so a thrown httpError would crash the process instead of returning JSON.
for (const method of ['get', 'post', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    if (!handlers.length) return register(routePath);
    return register(routePath, ...handlers.map((handler) => (req, res, next) => {
      try {
        const result = handler(req, res, next);
        if (result && typeof result.catch === 'function') result.catch(next);
      } catch (error) {
        next(error);
      }
    }));
  };
}

const allowedExtensions = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg',
  '.mp4', '.webm', '.mov',
  '.mp3', '.wav', '.m4a', '.ogg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip'
]);

const typeByExtension = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio'
};

function assetType(filename) {
  return typeByExtension[path.extname(filename).toLowerCase()] || 'file';
}

function decodeMulterFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function cleanName(value) {
  const ext = path.extname(value).toLowerCase();
  const base = path.basename(value, ext)
    .normalize('NFKD')
    .replace(/[^\w\u0600-\u06FF-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'media';
  return `${base}${ext}`;
}

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function ensureStorage() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(path.dirname(LIBRARY_FILE), { recursive: true });
  await fs.mkdir(path.dirname(PACKAGES_FILE), { recursive: true });
  for (const file of [LIBRARY_FILE, PACKAGES_FILE]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '[]', 'utf8');
    }
  }
}

async function readJsonArray(file) {
  await ensureStorage();
  const raw = await fs.readFile(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readLibrary() {
  return readJsonArray(LIBRARY_FILE);
}

async function writeLibrary(items) {
  await fs.writeFile(LIBRARY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

async function readPackages() {
  return readJsonArray(PACKAGES_FILE);
}

async function writePackages(packages) {
  await fs.writeFile(PACKAGES_FILE, JSON.stringify(packages, null, 2), 'utf8');
}

async function removeAssetsFromPackages(assetIds) {
  const idSet = new Set(assetIds);
  if (!idSet.size) return;
  const packages = await readPackages();
  let changed = false;
  const next = packages.map((pkg) => {
    const kept = (pkg.assetIds || []).filter((id) => !idSet.has(id));
    if (kept.length === (pkg.assetIds || []).length) return pkg;
    changed = true;
    return { ...pkg, assetIds: kept, updatedAt: new Date().toISOString() };
  });
  if (changed) await writePackages(next);
}

// Case-insensitive, separator-insensitive and Arabic-letter-variant-insensitive text
// so "CFM", "cfm-2024" and "C.F.M" style queries all hit the same items.
function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0629/g, '\u0647')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function searchTokens(query) {
  return normalizeSearchText(query).split(' ').filter(Boolean);
}

function matchesSearch(tokens, fields) {
  if (!tokens.length) return true;
  const haystack = normalizeSearchText(fields.flat().filter(Boolean).join(' '));
  const compact = haystack.replace(/ /g, '');
  return tokens.every((token) => haystack.includes(token) || compact.includes(token));
}

async function findAsset(id) {
  const items = await readLibrary();
  return items.find((item) => item.id === id);
}

async function findAssetByFileName(fileName) {
  const items = await readLibrary();
  return items.find((item) => item.fileName === fileName);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requestScope(req) {
  const scope = String(
    req.headers['x-library-scope'] || req.query.scope || req.body?.scope || 'shared'
  ).trim().toLowerCase();
  return scope === 'private' ? 'private' : 'shared';
}

function isPrivateAsset(item) {
  return item?.visibility === 'private';
}

function hasPrivateAccess(req) {
  if (!PRIVATE_LIBRARY_PIN) return false;
  const email = normalizeEmail(req.headers['x-agent-email']);
  const pin = String(req.headers['x-private-library-pin'] || '');
  return safeEqual(email, PRIVATE_LIBRARY_EMAIL) && safeEqual(pin, PRIVATE_LIBRARY_PIN);
}

function requireScopeAccess(req, res, next) {
  if (requestScope(req) !== 'private') return next();
  if (!PRIVATE_LIBRARY_PIN) {
    return res.status(503).json({ error: 'Private library is not configured' });
  }
  if (!hasPrivateAccess(req)) {
    return res.status(403).json({ error: 'Private library access denied' });
  }
  return next();
}

function canAccessAsset(req, item) {
  if (!isPrivateAsset(item)) return true;
  return hasPrivateAccess(req)
    && normalizeEmail(item.ownerEmail) === PRIVATE_LIBRARY_EMAIL;
}

function privateShareToken(item) {
  const secret = PRIVATE_LIBRARY_PIN || CHATWOOT_API_TOKEN || LIBRARY_PIN || 'chatwoot-library';
  return crypto
    .createHmac('sha256', secret)
    .update(`${item.id}:${item.fileName}:${item.ownerEmail || ''}`)
    .digest('hex')
    .slice(0, 32);
}

function publicAssetUrl(item, req) {
  if (!isPrivateAsset(item)) {
    return `${getBaseUrl(req)}/media/${encodeURIComponent(item.fileName)}`;
  }
  return `${getBaseUrl(req)}/share/${encodeURIComponent(item.id)}/${privateShareToken(item)}/${encodeURIComponent(item.fileName)}`;
}

function assetResponse(item, req) {
  const isPrivate = isPrivateAsset(item);
  return {
    ...item,
    isPublic: !isPrivate,
    canShareLink: true,
    url: publicAssetUrl(item, req),
    contentUrl: isPrivate
      ? `${getBaseUrl(req)}/api/assets/${encodeURIComponent(item.id)}/content`
      : `${getBaseUrl(req)}/media/${encodeURIComponent(item.fileName)}`
  };
}

function chatwootBaseUrl(req) {
  const url = String(req.body.chatwootUrl || CHATWOOT_URL || '').replace(/\/$/, '');
  if (!url) {
    const referer = req.headers.referer || '';
    const match = String(referer).match(/^https?:\/\/[^/]+/);
    return match ? match[0] : '';
  }
  return url;
}

function resolveAccountId(req) {
  return String(req.body.accountId || CHATWOOT_ACCOUNT_ID || '').trim();
}

function assertChatwootConfig(req) {
  const baseUrl = chatwootBaseUrl(req);
  const accountId = resolveAccountId(req);
  const conversationId = String(req.body.conversationId || '').trim();

  if (!CHATWOOT_API_TOKEN) {
    const error = new Error('Missing CHATWOOT_API_TOKEN environment variable');
    error.status = 500;
    throw error;
  }

  if (!baseUrl) {
    const error = new Error('Missing CHATWOOT_URL environment variable');
    error.status = 400;
    throw error;
  }

  if (!accountId || !conversationId) {
    const error = new Error('Missing Chatwoot accountId or conversationId');
    error.status = 400;
    throw error;
  }

  if (req.body.canReply === false) {
    const error = new Error('Chatwoot says this conversation cannot receive normal replies now');
    error.status = 409;
    throw error;
  }

  return { baseUrl, accountId, conversationId };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isPrivatePackage(pkg) {
  return pkg?.visibility === 'private';
}

function packageInScope(pkg, scope) {
  return scope === 'private'
    ? isPrivatePackage(pkg) && normalizeEmail(pkg.ownerEmail) === PRIVATE_LIBRARY_EMAIL
    : !isPrivatePackage(pkg);
}

function canAccessPackage(req, pkg) {
  if (!isPrivatePackage(pkg)) return true;
  return hasPrivateAccess(req)
    && normalizeEmail(pkg.ownerEmail) === PRIVATE_LIBRARY_EMAIL;
}

async function findAccessiblePackage(req, id) {
  const packages = await readPackages();
  const pkg = packages.find((candidate) => candidate.id === String(id || '').trim());
  if (!pkg || !canAccessPackage(req, pkg)) throw httpError(404, 'Package not found');
  return pkg;
}

function packageResponse(pkg, assetsById, req) {
  const assets = (pkg.assetIds || [])
    .map((id) => assetsById.get(id))
    .filter((item) => item && canAccessAsset(req, item));
  return {
    ...pkg,
    assetIds: assets.map((item) => item.id),
    count: assets.length,
    totalBytes: assets.reduce((sum, item) => sum + Number(item.size || 0), 0),
    assets: assets.map((item) => assetResponse(item, req))
  };
}

// Validates asset ids for a package. Shared packages may only hold shared assets so
// a private file can never leak to agents outside the private library.
async function validatePackageAssetIds(req, rawIds, visibility) {
  if (!Array.isArray(rawIds)) throw httpError(400, 'assetIds must be an array');
  const ids = [...new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length > 200) throw httpError(400, 'A package can contain up to 200 files');
  const items = await readLibrary();
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || !canAccessAsset(req, item)) throw httpError(404, 'Asset not found');
    if (visibility === 'shared' && isPrivateAsset(item)) {
      throw httpError(400, 'Shared packages cannot contain private files');
    }
  }
  return ids;
}

function parsePackageName(value) {
  const name = String(value || '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Package name is required');
  return name;
}

function parseTagList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 20);
  }
  return parseTags(value);
}

async function requestedAssets(req) {
  if (req.body.packageId) {
    const pkg = await findAccessiblePackage(req, req.body.packageId);
    const items = await readLibrary();
    const byId = new Map(items.map((item) => [item.id, item]));
    const assets = (pkg.assetIds || [])
      .map((id) => byId.get(id))
      .filter((item) => item && canAccessAsset(req, item));
    if (!assets.length) throw httpError(400, 'Package has no files');
    return { assets, pkg };
  }

  const ids = Array.isArray(req.body.assetIds)
    ? req.body.assetIds
    : [req.body.assetId];
  const cleanIds = ids.map((id) => String(id || '').trim()).filter(Boolean);
  if (!cleanIds.length) {
    const error = new Error('Missing assetId or assetIds');
    error.status = 400;
    throw error;
  }

  const idSet = new Set(cleanIds);
  const items = await readLibrary();
  const found = items.filter((item) => idSet.has(item.id));
  if (found.length !== idSet.size) {
    const error = new Error('Asset not found');
    error.status = 404;
    throw error;
  }
  if (found.some((item) => !canAccessAsset(req, item))) {
    const error = new Error('Asset not found');
    error.status = 404;
    throw error;
  }

  const order = new Map(cleanIds.map((id, index) => [id, index]));
  return { assets: found.sort((a, b) => order.get(a.id) - order.get(b.id)), pkg: null };
}

function parseTags(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function makeStoredFilename(originalName) {
  const safeOriginal = cleanName(originalName);
  const ext = path.extname(safeOriginal);
  const base = path.basename(safeOriginal, ext);
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return `${base}-${suffix}${ext}`;
}

function createAssetItem(file, extra = {}) {
  const now = extra.now || new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    originalName: file.originalName,
    fileName: file.fileName,
    title: String(extra.title || '').trim() || file.originalName,
    type: assetType(file.fileName),
    mimeType: file.mimeType,
    size: file.size,
    tags: extra.tags || [],
    notes: extra.notes || '',
    visibility: extra.visibility === 'private' ? 'private' : 'shared',
    ownerEmail: extra.visibility === 'private' ? normalizeEmail(extra.ownerEmail) : null,
    createdAt: now,
    updatedAt: now
  };
}

function parseBase64Payload(value) {
  const input = String(value || '');
  const commaIndex = input.indexOf(',');
  const base64 = commaIndex >= 0 ? input.slice(commaIndex + 1) : input;
  return Buffer.from(base64, 'base64');
}

function requirePin(req, res, next) {
  if (!LIBRARY_PIN) return next();
  const provided = req.headers['x-library-pin'] || req.query.pin;
  if (provided === LIBRARY_PIN) return next();
  return res.status(401).json({ error: 'Invalid library PIN' });
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureStorage();
      cb(null, UPLOAD_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_req, file, cb) => {
    cb(null, makeStoredFilename(decodeMulterFilename(file.originalname)));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: 50
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(decodeMulterFilename(file.originalname)).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      cb(new Error(`Unsupported file type: ${ext}`));
      return;
    }
    cb(null, true);
  }
});

function uploadAssetFiles(req, res, next) {
  const startedAt = Date.now();
  const contentLength = req.headers['content-length'] || 'unknown';
  console.log(`[upload:start] content-length=${contentLength}`);

  upload.array('files', 50)(req, res, (error) => {
    if (error) {
      const status = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      error.status = status;
      console.error(`[upload:error] ${error.name || 'Error'} ${error.code || ''} ${error.message}`);
      return next(error);
    }

    const files = req.files || [];
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    console.log(`[upload:received] files=${files.length} bytes=${totalBytes} ms=${Date.now() - startedAt}`);
    next();
  });
}

app.use('/api/assets/base64', express.json({ limit: `${JSON_UPLOAD_MAX_MB + 2}mb` }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(appRoot, 'public')));

app.get('/media/:fileName', async (req, res) => {
  const item = await findAssetByFileName(req.params.fileName);
  if (!item || isPrivateAsset(item)) {
    return res.status(404).json({ error: 'Asset not found' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  return res.sendFile(path.join(UPLOAD_DIR, item.fileName));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'chatwoot-library-app' });
});

app.get('/api/config', (_req, res) => {
  res.json({
    maxFileMb: MAX_FILE_MB,
    jsonUploadMaxMb: JSON_UPLOAD_MAX_MB,
    pinRequired: Boolean(LIBRARY_PIN),
    allowedExtensions: Array.from(allowedExtensions).sort(),
    privateLibrary: {
      email: PRIVATE_LIBRARY_EMAIL,
      configured: Boolean(PRIVATE_LIBRARY_PIN)
    }
  });
});

app.get('/api/assets', requirePin, requireScopeAccess, async (req, res) => {
  const [items, packages] = await Promise.all([readLibrary(), readPackages()]);
  const scope = requestScope(req);
  const tokens = searchTokens(req.query.q);
  const type = String(req.query.type || 'all');
  const tag = String(req.query.tag || '').trim().toLowerCase();
  const packageId = String(req.query.packageId || '').trim();

  const packagesByAsset = new Map();
  for (const pkg of packages.filter((candidate) => packageInScope(candidate, scope))) {
    for (const id of pkg.assetIds || []) {
      if (!packagesByAsset.has(id)) packagesByAsset.set(id, []);
      packagesByAsset.get(id).push({ id: pkg.id, name: pkg.name });
    }
  }

  const filtered = items
    .filter((item) => scope === 'private'
      ? isPrivateAsset(item) && normalizeEmail(item.ownerEmail) === PRIVATE_LIBRARY_EMAIL
      : !isPrivateAsset(item))
    .filter((item) => type === 'all' || item.type === type)
    .filter((item) => !tag || item.tags?.some((itemTag) => itemTag.toLowerCase() === tag))
    .filter((item) => !packageId
      || (packagesByAsset.get(item.id) || []).some((pkg) => pkg.id === packageId))
    .filter((item) => matchesSearch(tokens, [
      item.originalName,
      item.title,
      item.notes,
      item.tags || [],
      (packagesByAsset.get(item.id) || []).map((pkg) => pkg.name)
    ]))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    items: filtered.map((item) => ({
      ...assetResponse(item, req),
      packages: packagesByAsset.get(item.id) || []
    }))
  });
});

app.get('/api/storage', requirePin, requireScopeAccess, async (req, res) => {
  const scope = requestScope(req);
  const allItems = await readLibrary();
  const items = allItems.filter((item) => scope === 'private'
    ? isPrivateAsset(item) && normalizeEmail(item.ownerEmail) === PRIVATE_LIBRARY_EMAIL
    : !isPrivateAsset(item));
  const totalBytes = items.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const byType = items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + Number(item.size || 0);
    return acc;
  }, {});
  res.json({ totalBytes, count: items.length, byType, baseUrl: getBaseUrl(req) });
});

app.post('/api/assets', requirePin, requireScopeAccess, uploadAssetFiles, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files were uploaded' });

  const items = await readLibrary();
  const now = new Date().toISOString();
  const tags = parseTags(req.body.tags);
  const notes = String(req.body.notes || '').trim();
  const visibility = requestScope(req);

  const created = files.map((file) => createAssetItem({
    originalName: decodeMulterFilename(file.originalname),
    fileName: file.filename,
    mimeType: file.mimetype,
    size: file.size
  }, {
    title: req.body.title,
    tags,
    notes,
    visibility,
    ownerEmail: visibility === 'private' ? PRIVATE_LIBRARY_EMAIL : null,
    now
  }));

  await writeLibrary([...created, ...items]);
  console.log(`[upload:saved] files=${created.length} libraryCount=${created.length + items.length}`);
  res.json({
    created: created.map((item) => assetResponse(item, req))
  });
});

app.post('/api/assets/base64', requirePin, requireScopeAccess, async (req, res) => {
  const startedAt = Date.now();
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'No files were uploaded' });
  if (files.length > 10) return res.status(400).json({ error: 'Base64 fallback supports up to 10 files per upload' });

  await ensureStorage();
  const items = await readLibrary();
  const now = new Date().toISOString();
  const tags = parseTags(req.body.tags);
  const notes = String(req.body.notes || '').trim();
  const visibility = requestScope(req);
  const created = [];

  for (const file of files) {
    const originalName = String(file.name || 'media').trim();
    const ext = path.extname(originalName).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      return res.status(400).json({ error: `Unsupported file type: ${ext || originalName}` });
    }

    const buffer = parseBase64Payload(file.data);
    const maxBytes = JSON_UPLOAD_MAX_MB * 1024 * 1024;
    if (!buffer.length) return res.status(400).json({ error: `${originalName} is empty` });
    if (buffer.length > maxBytes) {
      return res.status(413).json({ error: `${originalName} is too large for fallback upload (${JSON_UPLOAD_MAX_MB} MB max)` });
    }

    const fileName = makeStoredFilename(originalName);
    await fs.writeFile(path.join(UPLOAD_DIR, fileName), buffer);
    created.push(createAssetItem({
      originalName,
      fileName,
      mimeType: String(file.mimeType || 'application/octet-stream'),
      size: buffer.length
    }, {
      title: req.body.title,
      tags,
      notes,
      visibility,
      ownerEmail: visibility === 'private' ? PRIVATE_LIBRARY_EMAIL : null,
      now
    }));
  }

  await writeLibrary([...created, ...items]);
  console.log(`[upload:base64:saved] files=${created.length} bytes=${created.reduce((sum, item) => sum + item.size, 0)} ms=${Date.now() - startedAt}`);
  res.json({
    created: created.map((item) => assetResponse(item, req))
  });
});

app.patch('/api/assets/:id', requirePin, async (req, res) => {
  const items = await readLibrary();
  const index = items.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Asset not found' });
  if (!canAccessAsset(req, items[index])) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  items[index] = {
    ...items[index],
    title: typeof req.body.title === 'string' ? req.body.title.trim() : items[index].title,
    notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : items[index].notes,
    tags: Array.isArray(req.body.tags) ? req.body.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : items[index].tags,
    updatedAt: new Date().toISOString()
  };

  await writeLibrary(items);
  res.json({ item: items[index] });
});

app.delete('/api/assets/:id', requirePin, async (req, res) => {
  const items = await readLibrary();
  const item = items.find((candidate) => candidate.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Asset not found' });
  if (!canAccessAsset(req, item)) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  const nextItems = items.filter((candidate) => candidate.id !== req.params.id);
  await writeLibrary(nextItems);
  await fs.rm(path.join(UPLOAD_DIR, item.fileName), { force: true });
  await removeAssetsFromPackages([item.id]);
  res.json({ ok: true });
});

app.delete('/api/assets', requirePin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const idSet = new Set(ids);
  const items = await readLibrary();
  const toDelete = items.filter((item) => idSet.has(item.id) && canAccessAsset(req, item));
  const deletedIds = new Set(toDelete.map((item) => item.id));
  const keep = items.filter((item) => !deletedIds.has(item.id));
  await writeLibrary(keep);
  await Promise.all(toDelete.map((item) => fs.rm(path.join(UPLOAD_DIR, item.fileName), { force: true })));
  await removeAssetsFromPackages([...deletedIds]);
  res.json({ deleted: toDelete.length });
});

app.get('/api/packages', requirePin, requireScopeAccess, async (req, res) => {
  const scope = requestScope(req);
  const tokens = searchTokens(req.query.q);
  const [packages, items] = await Promise.all([readPackages(), readLibrary()]);
  const assetsById = new Map(items.map((item) => [item.id, item]));

  const filtered = packages
    .filter((pkg) => packageInScope(pkg, scope))
    .filter((pkg) => matchesSearch(tokens, [pkg.name, pkg.description, pkg.tags || []]))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  res.json({ packages: filtered.map((pkg) => packageResponse(pkg, assetsById, req)) });
});

app.get('/api/packages/:id', requirePin, async (req, res) => {
  const pkg = await findAccessiblePackage(req, req.params.id);
  const items = await readLibrary();
  res.json({ package: packageResponse(pkg, new Map(items.map((item) => [item.id, item])), req) });
});

app.post('/api/packages', requirePin, requireScopeAccess, async (req, res) => {
  const visibility = requestScope(req);
  const name = parsePackageName(req.body.name);
  const assetIds = await validatePackageAssetIds(req, req.body.assetIds || [], visibility);
  const packages = await readPackages();
  const normalizedName = normalizeSearchText(name);
  if (packages.some((pkg) => packageInScope(pkg, visibility) && normalizeSearchText(pkg.name) === normalizedName)) {
    throw httpError(409, 'A package with this name already exists');
  }

  const now = new Date().toISOString();
  const pkg = {
    id: crypto.randomUUID(),
    name,
    description: String(req.body.description || '').trim().slice(0, 1000),
    tags: parseTagList(req.body.tags),
    assetIds,
    visibility,
    ownerEmail: visibility === 'private' ? PRIVATE_LIBRARY_EMAIL : null,
    createdAt: now,
    updatedAt: now
  };

  await writePackages([pkg, ...packages]);
  const items = await readLibrary();
  res.status(201).json({ package: packageResponse(pkg, new Map(items.map((item) => [item.id, item])), req) });
});

app.patch('/api/packages/:id', requirePin, async (req, res) => {
  const current = await findAccessiblePackage(req, req.params.id);
  const visibility = isPrivatePackage(current) ? 'private' : 'shared';
  const next = { ...current };

  if (req.body.name !== undefined) {
    next.name = parsePackageName(req.body.name);
    const normalizedName = normalizeSearchText(next.name);
    const packages = await readPackages();
    if (packages.some((pkg) => pkg.id !== current.id
      && packageInScope(pkg, visibility)
      && normalizeSearchText(pkg.name) === normalizedName)) {
      throw httpError(409, 'A package with this name already exists');
    }
  }
  if (typeof req.body.description === 'string') {
    next.description = req.body.description.trim().slice(0, 1000);
  }
  if (req.body.tags !== undefined) next.tags = parseTagList(req.body.tags);

  let assetIds = current.assetIds || [];
  if (req.body.assetIds !== undefined) assetIds = req.body.assetIds;
  if (Array.isArray(req.body.addAssetIds)) assetIds = [...assetIds, ...req.body.addAssetIds];
  if (Array.isArray(req.body.removeAssetIds)) {
    const remove = new Set(req.body.removeAssetIds.map(String));
    assetIds = assetIds.filter((id) => !remove.has(id));
  }
  // Drop ids of files deleted since the package was saved before validating the rest.
  const existing = new Set((await readLibrary()).map((item) => item.id));
  const staleIds = new Set((current.assetIds || []).filter((id) => !existing.has(id)));
  next.assetIds = await validatePackageAssetIds(
    req,
    assetIds.filter((id) => !staleIds.has(id)),
    visibility
  );
  next.updatedAt = new Date().toISOString();

  const packages = await readPackages();
  await writePackages(packages.map((pkg) => (pkg.id === next.id ? next : pkg)));
  const items = await readLibrary();
  res.json({ package: packageResponse(next, new Map(items.map((item) => [item.id, item])), req) });
});

app.delete('/api/packages/:id', requirePin, async (req, res) => {
  const pkg = await findAccessiblePackage(req, req.params.id);
  const packages = await readPackages();
  await writePackages(packages.filter((candidate) => candidate.id !== pkg.id));
  res.json({ ok: true });
});

app.get('/api/assets/:id/content', requirePin, async (req, res) => {
  const asset = await findAsset(req.params.id);
  if (!asset || !isPrivateAsset(asset) || !canAccessAsset(req, asset)) {
    return res.status(404).json({ error: 'Asset not found' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.type(asset.mimeType || 'application/octet-stream');
  return res.sendFile(path.join(UPLOAD_DIR, asset.fileName));
});

app.get('/share/:id/:token/:fileName', async (req, res) => {
  const asset = await findAsset(req.params.id);
  if (
    !asset
    || asset.fileName !== req.params.fileName
    || !isPrivateAsset(asset)
    || !safeEqual(req.params.token, privateShareToken(asset))
  ) {
    return res.status(404).json({ error: 'Asset not found' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  return res.sendFile(path.join(UPLOAD_DIR, asset.fileName));
});

app.post('/api/chatwoot/send-link', requirePin, async (req, res) => {
  const { baseUrl, accountId, conversationId } = assertChatwootConfig(req);
  const { assets, pkg } = await requestedAssets(req);
  const message = String(req.body.message || '').trim();
  const links = assets
    .map((asset) => `${asset.title || asset.originalName}\n${publicAssetUrl(asset, req)}`)
    .join('\n\n');
  const content = message || (pkg ? `${pkg.name}\n\n${links}` : links);

  const response = await axios.post(
    `${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    {
      content,
      message_type: 'outgoing',
      private: false,
      content_type: 'text',
      content_attributes: {}
    },
    {
      headers: {
        api_access_token: CHATWOOT_API_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  res.json({ ok: true, mode: 'link', count: assets.length, packageId: pkg?.id || null, messageId: response.data?.id || null });
});

app.post('/api/chatwoot/send-attachment', requirePin, async (req, res) => {
  const { baseUrl, accountId, conversationId } = assertChatwootConfig(req);
  const { assets, pkg } = await requestedAssets(req);

  const form = new FormData();
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  form.append('content', String(req.body.content || '').trim() || (pkg ? pkg.name : ''));

  for (const asset of assets) {
    const filePath = path.join(UPLOAD_DIR, asset.fileName);
    await fs.access(filePath);
    form.append('attachments[]', createReadStream(filePath), {
      filename: asset.originalName || asset.fileName,
      contentType: asset.mimeType || 'application/octet-stream',
      knownLength: asset.size || undefined
    });
  }

  const response = await axios.post(
    `${baseUrl}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        api_access_token: CHATWOOT_API_TOKEN
      },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  res.json({ ok: true, mode: 'attachment', count: assets.length, packageId: pkg?.id || null, messageId: response.data?.id || null });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 400).json({ error: error.message || 'Request failed' });
});

await ensureStorage();

app.listen(PORT, () => {
  console.log(`Chatwoot Library running on port ${PORT}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
});
