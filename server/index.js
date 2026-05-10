import express from 'express';
import multer from 'multer';
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
const LIBRARY_PIN = process.env.LIBRARY_PIN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
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

function parseTags(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
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
    const safeOriginal = cleanName(file.originalname);
    const ext = path.extname(safeOriginal);
    const base = path.basename(safeOriginal, ext);
    const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    cb(null, `${base}-${suffix}${ext}`);
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

app.post('/api/assets', requirePin, upload.array('files', 50), async (req, res) => {
  const files = req.files || [];
  const items = await readLibrary();
  const now = new Date().toISOString();
  const tags = parseTags(req.body.tags);
  const notes = String(req.body.notes || '').trim();

  const created = files.map((file) => {
    const id = crypto.randomUUID();
    return {
      id,
      originalName: file.originalname,
      fileName: file.filename,
      title: String(req.body.title || '').trim() || file.originalname,
      type: assetType(file.filename),
      mimeType: file.mimetype,
      size: file.size,
      tags,
      notes,
      createdAt: now,
      updatedAt: now
    };
  });

  await writeLibrary([...created, ...items]);
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

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Request failed' });
});

await ensureStorage();

app.listen(PORT, () => {
  console.log(`Chatwoot Library running on port ${PORT}`);
  console.log(`Upload dir: ${UPLOAD_DIR}`);
});
