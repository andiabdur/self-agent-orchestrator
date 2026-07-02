import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ALL_NODES, UPLOAD_DIR } from '../config.js';
import { isAuthenticated } from '../services/authService.js';

const router = express.Router();

router.get('/api/nodes', (req, res) => {
  res.json(ALL_NODES.map(({ id, name }) => ({ id, name })));
});

router.get('/api/dirs', (req, res) => {
  let target;
  try {
    target = path.resolve(req.query.path ? String(req.query.path) : os.homedir());
  } catch { return res.status(400).json({ error: 'invalid path' }); }
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true })
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        try { return fs.statSync(path.join(target, e.name)).isDirectory(); } catch { return false; }
      })
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ path: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries });
});

router.get('/api/files', (req, res) => {
  let target;
  try { target = path.resolve(req.query.path ? String(req.query.path) : os.homedir()); } catch { return res.status(400).json({ error: 'invalid path' }); }
  const showHidden = req.query.hidden === '1';
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true }).filter(e => showHidden || !e.name.startsWith('.')).map(e => {
      try {
        const full = path.join(target, e.name);
        const stat = fs.statSync(full);
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          ext: e.isFile() ? path.extname(e.name).toLowerCase() : '',
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) { return res.status(400).json({ error: err.message }); }
  res.json({ path: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries });
});

router.get('/api/download', (req, res) => {
  const rawPath = req.query.path ? String(req.query.path) : null;
  if (!rawPath) return res.status(400).json({ error: 'path required' });
  const BASE = path.resolve(os.homedir());
  let filePath;
  try { filePath = path.resolve(rawPath); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  let realPath, realBase;
  try { realBase = fs.realpathSync(BASE); realPath = fs.realpathSync(filePath); } catch { return res.status(404).json({ error: 'File not found' }); }
  if (!realPath.startsWith(realBase + path.sep)) return res.status(403).json({ error: 'Access denied' });
  if (!fs.existsSync(realPath) || fs.statSync(realPath).isDirectory()) return res.status(404).json({ error: 'File not found' });
  const ext = path.extname(realPath).toLowerCase();
  const IMG_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg']);
  const name = path.basename(realPath);
  if (IMG_EXTS.has(ext) && res.req?.query?.inline !== undefined) {
    const mime = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml' }[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(realPath);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(realPath);
  }
});

router.post('/api/mkdir', (req, res) => {
  const rawParent = req.body?.path ? String(req.body.path) : null;
  const name = req.body?.name ? String(req.body.name).trim() : null;
  if (!rawParent || !name) return res.status(400).json({ error: 'path and name required' });
  if (/[/\\<>:"|?*]/.test(name) || name === '.' || name === '..' || name.length > 255) {
    return res.status(400).json({ error: 'Invalid folder name' });
  }
  let parent;
  try { parent = path.resolve(rawParent); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  const newPath = path.join(parent, name);
  if (!newPath.startsWith(parent + path.sep)) return res.status(400).json({ error: 'Invalid path' });
  try {
    fs.mkdirSync(newPath);
    res.json({ ok: true, path: newPath });
  } catch (err) {
    if (err.code === 'EEXIST') return res.status(400).json({ error: 'Folder already exists' });
    return res.status(400).json({ error: err.message });
  }
});

router.post('/api/file', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const rawParent = req.body?.path ? String(req.body.path) : null;
  const name = req.body?.name ? String(req.body.name).trim() : null;
  if (!rawParent || !name) return res.status(400).json({ error: 'path and name required' });
  if (/[/\\<>:"|?*]/.test(name) || name === '.' || name === '..' || name.length > 255) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  const BASE = path.resolve(os.homedir());
  let parent;
  try { parent = path.resolve(rawParent); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  if (!parent.startsWith(BASE + path.sep) && parent !== BASE) {
    return res.status(400).json({ error: 'Access denied' });
  }
  const newPath = path.join(parent, name);
  if (!newPath.startsWith(parent + path.sep)) return res.status(400).json({ error: 'Invalid path' });
  try {
    if (!fs.existsSync(parent)) return res.status(400).json({ error: 'Parent directory does not exist' });
    if (fs.existsSync(newPath)) return res.status(400).json({ error: 'File already exists' });
    fs.writeFileSync(newPath, '');
    res.json({ ok: true, path: newPath });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/api/rename', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const from = req.body?.from ? String(req.body.from) : null;
  const to = req.body?.to ? String(req.body.to) : null;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const fromPath = path.resolve(from);
    const toPath = path.resolve(to);
    const BASE = path.resolve(os.homedir());
    if (!fromPath.startsWith(BASE + path.sep) || !toPath.startsWith(BASE + path.sep)) {
      return res.status(400).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(fromPath)) return res.status(404).json({ error: 'Source not found' });
    if (fs.existsSync(toPath)) return res.status(400).json({ error: 'Target already exists' });
    const toParent = path.dirname(toPath);
    const toParentStat = fs.statSync(toParent);
    if (!toParentStat.isDirectory()) return res.status(400).json({ error: 'Target parent is not a directory' });
    fs.renameSync(fromPath, toPath);
    res.json({ ok: true, from: fromPath, to: toPath });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    return res.status(400).json({ error: err.message });
  }
});

router.get('/api/file', (req, res) => {
  const rawPath = req.query.path ? String(req.query.path) : null;
  if (!rawPath) return res.status(400).json({ error: 'path required' });
  const VIEWABLE = new Set([
    '.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.toml',
    '.sh', '.bash', '.zsh', '.env', '.ini', '.cfg', '.conf',
    '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
    '.css', '.scss', '.less', '.html', '.xml', '.svg',
    '.tf', '.hcl', '.dockerfile', '.dbignore', '.gitignore',
    '.properties', '.plist', '.gradle', '.makefile', '.lock', '.log',
    '.sql', '.graphql', '.proto', '.pl', '.pm', '.lua',
    '.ps1', '.bat', '.cmd',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  ]);
  const BASE = path.resolve(os.homedir());
  let filePath;
  try { filePath = path.resolve(rawPath); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  let realPath, realBase;
  try {
    realBase = fs.realpathSync(BASE);
    realPath = fs.realpathSync(filePath);
  } catch { return res.status(404).json({ error: 'File not found' }); }
  if (!realPath.startsWith(realBase + path.sep)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const ext = path.extname(realPath).toLowerCase();
  if (!VIEWABLE.has(ext)) return res.status(400).json({ error: 'File type not supported for viewing' });
  const MAX_BYTES = 1024 * 1024;
  try {
    const stat = fs.statSync(realPath);
    if (stat.size > MAX_BYTES) return res.status(400).json({ error: 'File too large to view (max 1 MB)' });
    const content = fs.readFileSync(realPath, 'utf8');
    res.json({ content, ext, name: path.basename(realPath) });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    return res.status(400).json({ error: err.message });
  }
});

router.put('/api/file', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const rawPath = req.body?.path ? String(req.body.path) : null;
  const content = req.body?.content;
  if (!rawPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  const BASE = path.resolve(os.homedir());
  let filePath;
  try { filePath = path.resolve(rawPath); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  let realPath, realBase;
  try {
    realBase = fs.realpathSync(BASE);
    realPath = fs.realpathSync(filePath);
  } catch { return res.status(404).json({ error: 'File not found' }); }
  if (!realPath.startsWith(realBase + path.sep)) return res.status(403).json({ error: 'Access denied' });
  const MAX_BYTES = 4 * 1024 * 1024; // 4 MB write limit
  if (Buffer.byteLength(String(content)) > MAX_BYTES) return res.status(400).json({ error: 'Content too large (max 4 MB)' });
  try {
    fs.writeFileSync(realPath, String(content), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/api/uploads/:filename', (req, res) => {
  const safe = String(req.params.filename || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe || safe.startsWith('.') || safe.includes('..')) return res.status(400).end();
  const filePath = path.join(UPLOAD_DIR, safe);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) return res.status(400).end();
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).send('Not found');
    res.sendFile(filePath, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });
});

export default router;
