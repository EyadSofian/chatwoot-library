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
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const JSON_UPLOAD_MAX_MB = Number(process.env.JSON_UPLOAD_MAX_MB || 15);
const LIBRARY_PIN = process.env.LIBRARY_PIN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CHATWOOT_URL = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '';
const app = express();

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
  try {
    await fs.access(LIBRARY_FILE);
  } catch {
    await fs.writeFile(LIBRARY_FILE, '[]', 'utf8');
  }
}

async function readLibrary() {
  await ensureStorage();
  const raw = await fs.readFile(LIBRARY_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeLibrary(items) {
  await fs.writeFile(LIBRARY_FILE, JSON.stringify(items, null, 2), 'utf8');
}

async function findAsset(id) {
  const items = await readLibrary();
  return items.find((item) => item.id === id);
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
    cb(null, makeStoredFilename(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: 50
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
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
app.use('/media', express.static(UPLOAD_DIR, {
  etag: true,
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'chatwoot-library-app' });
});

app.get('/api/config', (_req, res) => {
  res.json({
    maxFileMb: MAX_FILE_MB,
    jsonUploadMaxMb: JSON_UPLOAD_MAX_MB,
    pinRequired: Boolean(LIBRARY_PIN),
    allowedExtensions: Array.from(allowedExtensions).sort()
  });
});

app.get('/api/assets', requirePin, async (req, res) => {
  const items = await readLibrary();
  const q = String(req.query.q || '').trim().toLowerCase();
  const type = String(req.query.type || 'all');
  const tag = String(req.query.tag || '').trim().toLowerCase();

  const filtered = items
    .filter((item) => type === 'all' || item.type === type)
    .filter((item) => !tag || item.tags?.some((itemTag) => itemTag.toLowerCase() === tag))
    .filter((item) => {
      if (!q) return true;
      return [
        item.originalName,
        item.title,
        item.notes,
        ...(item.tags || [])
      ].join(' ').toLowerCase().includes(q);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const baseUrl = getBaseUrl(req);
  res.json({
    items: filtered.map((item) => ({
      ...item,
      url: `${baseUrl}/media/${encodeURIComponent(item.fileName)}`
    }))
  });
});

app.get('/api/storage', requirePin, async (req, res) => {
  const items = await readLibrary();
  const totalBytes = items.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const byType = items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + Number(item.size || 0);
    return acc;
  }, {});
  res.json({ totalBytes, count: items.length, byType, baseUrl: getBaseUrl(req) });
});

app.post('/api/assets', requirePin, uploadAssetFiles, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files were uploaded' });

  const items = await readLibrary();
  const now = new Date().toISOString();
  const tags = parseTags(req.body.tags);
  const notes = String(req.body.notes || '').trim();

  const created = files.map((file) => createAssetItem({
    originalName: file.originalname,
    fileName: file.filename,
    mimeType: file.mimetype,
    size: file.size
  }, {
    title: req.body.title,
    tags,
    notes,
    now
  }));

  await writeLibrary([...created, ...items]);
  console.log(`[upload:saved] files=${created.length} libraryCount=${created.length + items.length}`);
  const baseUrl = getBaseUrl(req);
  res.json({
    created: created.map((item) => ({
      ...item,
      url: `${baseUrl}/media/${encodeURIComponent(item.fileName)}`
    }))
  });
});

app.post('/api/assets/base64', requirePin, async (req, res) => {
  const startedAt = Date.now();
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'No files were uploaded' });
  if (files.length > 10) return res.status(400).json({ error: 'Base64 fallback supports up to 10 files per upload' });

  await ensureStorage();
  const items = await readLibrary();
  const now = new Date().toISOString();
  const tags = parseTags(req.body.tags);
  const notes = String(req.body.notes || '').trim();
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
      now
    }));
  }

  await writeLibrary([...created, ...items]);
  console.log(`[upload:base64:saved] files=${created.length} bytes=${created.reduce((sum, item) => sum + item.size, 0)} ms=${Date.now() - startedAt}`);
  const baseUrl = getBaseUrl(req);
  res.json({
    created: created.map((item) => ({
      ...item,
      url: `${baseUrl}/media/${encodeURIComponent(item.fileName)}`
    }))
  });
});

app.patch('/api/assets/:id', requirePin, async (req, res) => {
  const items = await readLibrary();
  const index = items.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Asset not found' });

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

  const nextItems = items.filter((candidate) => candidate.id !== req.params.id);
  await writeLibrary(nextItems);
  await fs.rm(path.join(UPLOAD_DIR, item.fileName), { force: true });
  res.json({ ok: true });
});

app.delete('/api/assets', requirePin, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const idSet = new Set(ids);
  const items = await readLibrary();
  const toDelete = items.filter((item) => idSet.has(item.id));
  const keep = items.filter((item) => !idSet.has(item.id));
  await writeLibrary(keep);
  await Promise.all(toDelete.map((item) => fs.rm(path.join(UPLOAD_DIR, item.fileName), { force: true })));
  res.json({ deleted: toDelete.length });
});

app.post('/api/chatwoot/send-link', requirePin, async (req, res) => {
  const { baseUrl, accountId, conversationId } = assertChatwootConfig(req);
  const asset = await findAsset(String(req.body.assetId || ''));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const publicUrl = `${getBaseUrl(req)}/media/${encodeURIComponent(asset.fileName)}`;
  const message = String(req.body.message || '').trim();
  const content = message || `${asset.title || asset.originalName}\n${publicUrl}`;

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

  res.json({ ok: true, mode: 'link', messageId: response.data?.id || null });
});

app.post('/api/chatwoot/send-attachment', requirePin, async (req, res) => {
  const { baseUrl, accountId, conversationId } = assertChatwootConfig(req);
  const asset = await findAsset(String(req.body.assetId || ''));
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const filePath = path.join(UPLOAD_DIR, asset.fileName);
  await fs.access(filePath);

  const form = new FormData();
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  form.append('content', String(req.body.content || '').trim());
  form.append('attachments[]', createReadStream(filePath), {
    filename: asset.originalName || asset.fileName,
    contentType: asset.mimeType || 'application/octet-stream',
    knownLength: asset.size || undefined
  });

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

  res.json({ ok: true, mode: 'attachment', messageId: response.data?.id || null });
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
