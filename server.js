import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file manually if it exists
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        const key = trimmed.substring(0, index).trim();
        let val = trimmed.substring(index + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    });
  }
} catch (err) {
  console.warn('Failed to load .env file:', err.message);
}

const PORT = parseInt(process.env.PORT || '7000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const USERNAME = process.env.WEB_USERNAME || 'admin';
const PASSWORD = process.env.WEB_PASSWORD || 'changeme';
const isWin = process.platform === 'win32';

// Resolve CLAUDE_BIN dynamically
const rawClaudeBin = process.env.CLAUDE_BIN || '/Users/andi/.local/bin/claude';
function resolveClaudeBin() {
  if (rawClaudeBin && fs.existsSync(rawClaudeBin)) {
    return rawClaudeBin;
  }
  if (isWin) {
    if (process.env.APPDATA) {
      const globalNpmPath = path.join(process.env.APPDATA, 'npm', 'claude.cmd');
      if (fs.existsSync(globalNpmPath)) {
        return globalNpmPath;
      }
    }
    return 'claude';
  } else {
    const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'claude');
    if (fs.existsSync(userLocalBin)) {
      return userLocalBin;
    }
    if (fs.existsSync('/usr/local/bin/claude')) {
      return '/usr/local/bin/claude';
    }
    return 'claude';
  }
}
const CLAUDE_BIN = resolveClaudeBin();

// Resolve QWEN_BIN dynamically
const rawQwenBin = process.env.QWEN_BIN || '/Users/andi/.local/bin/qwen';
function resolveQwenBin() {
  if (rawQwenBin && fs.existsSync(rawQwenBin)) {
    return rawQwenBin;
  }
  if (isWin) {
    if (process.env.APPDATA) {
      const globalNpmPath = path.join(process.env.APPDATA, 'npm', 'qwen.cmd');
      if (fs.existsSync(globalNpmPath)) {
        return globalNpmPath;
      }
    }
    return 'qwen';
  } else {
    const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'qwen');
    if (fs.existsSync(userLocalBin)) {
      return userLocalBin;
    }
    if (fs.existsSync('/usr/local/bin/qwen')) {
      return '/usr/local/bin/qwen';
    }
    if (fs.existsSync('/opt/homebrew/bin/qwen')) {
      return '/opt/homebrew/bin/qwen';
    }
    return 'qwen';
  }
}
const QWEN_BIN = resolveQwenBin();

const DEFAULT_CWD = process.env.AGENT_CWD || os.homedir();
const DEFAULT_PERM = process.env.PERMISSION_MODE || 'bypassPermissions';
const VALID_PERMS = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']);
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const VALID_MODELS = new Set(['sonnet', 'opus', 'haiku']);
const DEFAULT_ENGINE = process.env.ENGINE || 'claude';
const VALID_ENGINES = new Set(['claude', 'oi', 'qwen']);
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'http://localhost:20128/v1').replace(/\/$/, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'local';
const OPENAI_DEFAULT_MODEL = process.env.OPENAI_MODEL || '';
const OI_BRIDGE = path.join(__dirname, 'oi_bridge.py');
const OI_PYTHON = process.env.OI_PYTHON || 'python3';

// ─── Multi-node ────────────────────────────────────────────────────────────────
const NODE_NAME = process.env.NODE_NAME || os.hostname();
const REMOTE_NODES = (() => {
  try {
    const raw = process.env.NODES;
    if (!raw) return [];
    const seen = new Set(['local']);
    const out = [];
    JSON.parse(raw).forEach((n, i) => {
      let id = n.id || `node-${i + 1}`;
      if (seen.has(id)) {
        const original = id;
        let suffix = 2;
        while (seen.has(id)) { id = `${original}-${suffix++}`; }
        console.warn(`[nodes] id "${original}" collides; renamed to "${id}"`);
      }
      seen.add(id);
      if (!n.url) {
        console.warn(`[nodes] node ${id} missing url — skipped`);
        return;
      }
      out.push({
        id,
        name: n.name || `Node ${i + 1}`,
        url: String(n.url),
        username: String(n.username || USERNAME),
        password: String(n.password || PASSWORD),
      });
    });
    return out;
  } catch (e) {
    console.error('[nodes] Failed to parse NODES env:', e.message);
    return [];
  }
})();
const ALL_NODES = [{ id: 'local', name: NODE_NAME }, ...REMOTE_NODES];

// ─── Open Interpreter Engine state ───────────────────────────────────────
const oiHistories = new Map(); // sessionId -> OI messages[]

async function fetchOIModels() {
  try {
    const res = await fetch(`${OPENAI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map(m => ({ id: m.id, name: m.id }));
  } catch {
    return [];
  }
}

// ─── Open Interpreter Engine ──────────────────────────────────────────────────
async function sendPromptOI(ws, text, savedImages, currentSessionId, currentModel, currentCwd) {
  const isExisting = !!(currentSessionId && currentSessionId.startsWith('oi_'));
  const sessionId = isExisting ? currentSessionId : 'oi_' + randomBytes(12).toString('hex');

  const history = oiHistories.get(sessionId) || [];

  let promptText = text;
  if (savedImages && savedImages.length > 0) {
    const paths = savedImages.map(s => `- ${s.path}`).join('\n');
    promptText = text && text.trim()
      ? `${text}\n\nAttached images:\n${paths}`
      : `Please examine these images:\n${paths}`;
  }

  const userEvent = {
    kind: 'user_message', text, timestamp: Date.now(),
    ...(savedImages && savedImages.length > 0 ? {
      images: savedImages.map(s => ({ filename: s.filename, name: s.name, mime: s.mime, thumbData: s.thumbData })),
    } : {}),
  };

  const run = {
    proc: null, status: 'running', cwd: currentCwd, perm: 'oi',
    model: currentModel, promptText: text, sessionId,
    bufferedEvents: [], subscribers: new Set([ws]), completedAt: null,
  };
  activeRuns.set(sessionId, run);
  broadcast(sessionId, { kind: 'turn_start' });

  appendSessionEvent(sessionId, userEvent);
  broadcast(sessionId, userEvent);

  if (!isExisting) {
    const title = text.split('\n')[0].slice(0, 60);
    upsertSessionMeta(sessionId, { cwd: currentCwd, permissionMode: DEFAULT_PERM, engine: 'oi', model: currentModel || OPENAI_DEFAULT_MODEL, title });
    broadcast(sessionId, { kind: 'session_persisted', sessionId, sessions: loadIndexEnriched() });
  }

  const config = JSON.stringify({
    prompt: promptText,
    model: currentModel || OPENAI_DEFAULT_MODEL,
    api_base: OPENAI_BASE_URL,
    api_key: OPENAI_API_KEY,
    cwd: currentCwd,
    history,
  });

  let proc;
  try {
    proc = spawn(OI_PYTHON, [OI_BRIDGE], {
      cwd: currentCwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin,
    });
    run.proc = proc;
  } catch (err) {
    run.status = 'done';
    broadcast(sessionId, { kind: 'error', message: `Failed to spawn OI: ${err.message}` });
    broadcast(sessionId, { kind: 'turn_end' });
    return { key: sessionId, sessionId };
  }

  proc.stdin.write(config + '\n');
  proc.stdin.end();

  let stderrBuf = '';
  let lineBuf = '';
  let assistantBuf = '';
  let codeBuf = '';
  let inCode = false;
  let finalAssistantText = '';

  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.stdout.on('data', chunk => {
    lineBuf += chunk.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === '__error__') {
        broadcast(sessionId, { kind: 'error', message: evt.content || 'OI error' });
        return;
      }

      if (evt.type === '__history__') {
        if (Array.isArray(evt.messages)) oiHistories.set(sessionId, evt.messages);
        return;
      }

      // Translate OI chunk format → our event format
      if (evt.type === 'message' && evt.role === 'assistant') {
        if (evt.start) { assistantBuf = ''; return; }
        if (evt.content) {
          assistantBuf += evt.content;
          broadcast(sessionId, { kind: 'assistant_delta', text: evt.content });
          return;
        }
        if (evt.end) {
          finalAssistantText += assistantBuf;
          return;
        }
      }

      if (evt.type === 'code') {
        if (evt.start) { codeBuf = ''; inCode = true; return; }
        if (evt.content) { codeBuf += evt.content; return; }
        if (evt.end) {
          inCode = false;
          const lang = evt.format || 'bash';
          broadcast(sessionId, { kind: 'tool_use', name: lang, input: codeBuf });
          return;
        }
      }

      if (evt.type === 'console') {
        if (evt.start || !evt.content) return;
        if (evt.format === 'active_line') return; // skip line highlights
        broadcast(sessionId, { kind: 'tool_result', name: 'console', output: String(evt.content) });
      }
    }
  });

  await new Promise(resolve => proc.on('close', resolve));

  if (finalAssistantText) {
    appendSessionEvent(sessionId, { kind: 'assistant_text', text: finalAssistantText });
  }
  const completeEvt = { kind: 'turn_complete' };
  appendSessionEvent(sessionId, completeEvt);
  broadcast(sessionId, completeEvt);

  run.status = 'done';
  run.completedAt = Date.now();
  broadcast(sessionId, { kind: 'turn_end' });

  return { key: sessionId, sessionId };
}

const STATE_DIR = process.env.STATE_DIR || path.join(os.homedir(), '.self-agent-orchestrator');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const SESSIONS_INDEX = path.join(STATE_DIR, 'sessions.json');
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Image upload helpers ──────────────────────────────────────
const IMAGE_MIME_TO_EXT = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MAX_IMAGES_PER_TURN = 4;

function saveUploadedImage(img) {
  const mime = String(img?.mime || '').toLowerCase();
  const ext = IMAGE_MIME_TO_EXT[mime];
  if (!ext) return null;
  const dataStr = String(img?.fullData || img?.data || '').replace(/^data:image\/[a-z+]+;base64,/i, '');
  if (!dataStr) return null;
  let buf;
  try { buf = Buffer.from(dataStr, 'base64'); } catch { return null; }
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  try { fs.writeFileSync(filePath, buf); } catch { return null; }
  return {
    filename,
    path: filePath,
    name: String(img.name || '').slice(0, 100) || filename,
    thumbData: typeof img.thumbData === 'string' ? img.thumbData.slice(0, 200_000) : null,
    bytes: buf.length,
    mime,
  };
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch { return []; }
}
// Like loadIndex() but enriched with per-session disk weight, so the UI can
// flag heavy sessions where `--resume` will burn a lot of input tokens.
function loadIndexEnriched() {
  const list = loadIndex();
  for (const s of list) {
    try {
      const stat = fs.statSync(path.join(SESSIONS_DIR, `${s.id}.jsonl`));
      s.bytes = stat.size;
      // Crude token estimate (1 token ≈ 4 chars). Good enough for "heavy" UI hints.
      s.tokensEstimate = Math.round(stat.size / 4);
    } catch { s.bytes = 0; s.tokensEstimate = 0; }
  }
  return list;
}
function saveIndex(list) {
  // Don't persist transient/computed fields back to disk.
  const cleaned = list.map(({ bytes, tokensEstimate, ...rest }) => rest);
  fs.writeFileSync(SESSIONS_INDEX, JSON.stringify(cleaned, null, 2));
}
function loadSessionEvents(id) {
  const f = path.join(SESSIONS_DIR, `${id}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
function appendSessionEvent(id, evt) {
  fs.appendFileSync(path.join(SESSIONS_DIR, `${id}.jsonl`), JSON.stringify(evt) + '\n');
}
function upsertSessionMeta(id, patch) {
  const list = loadIndex();
  const i = list.findIndex(s => s.id === id);
  if (i >= 0) {
    list[i] = { ...list[i], ...patch, last_used_at: Date.now() };
  } else {
    list.unshift({ id, title: patch.title || 'Untitled', cwd: patch.cwd || DEFAULT_CWD, created_at: Date.now(), last_used_at: Date.now() });
  }
  list.sort((a, b) => b.last_used_at - a.last_used_at);
  saveIndex(list);
}

const app = express();
app.use(express.json());

const activeSessions = new Set();

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session_token=([^;]+)/);
  if (match) return match[1];
  
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) return token;
    } catch {}
  }
  return null;
}

function isAuthenticated(req) {
  const token = getSessionToken(req);
  if (token && activeSessions.has(token)) return true;
  // Basic auth fallback for server-to-server (node proxy) connections
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0 && decoded.slice(0, idx) === USERNAME && decoded.slice(idx + 1) === PASSWORD) return true;
    } catch {}
  }
  return false;
}

app.use((req, res, next) => {
  const publicPaths = new Set([
    '/login.html',
    '/api/login',
    '/api/auth/check',
    '/manifest.webmanifest',
    '/icon-192.png',
    '/icon-512.png',
    '/icon.svg',
    '/sw.js'
  ]);

  if (publicPaths.has(req.path)) {
    return next();
  }

  if (isAuthenticated(req)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  res.redirect('/login.html');
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }
  if (username === USERNAME && password === PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    activeSessions.add(token);
    res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Username atau password salah' });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    activeSessions.delete(token);
  }
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.get('/api/sessions', (req, res) => res.json(loadIndexEnriched()));
app.get('/api/sessions/:id/events', (req, res) => res.json(loadSessionEvents(req.params.id)));
app.delete('/api/sessions/:id', (req, res) => {
  const list = loadIndex().filter(s => s.id !== req.params.id);
  saveIndex(list);
  try { fs.unlinkSync(path.join(SESSIONS_DIR, `${req.params.id}.jsonl`)); } catch {}
  res.json({ ok: true });
});
app.patch('/api/sessions/:id', (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'title required' });
  const list = loadIndex();
  const i = list.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  list[i].title = title;
  saveIndex(list);
  res.json({ ok: true, sessions: list });
});

app.get('/api/sessions/search', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const lower = q.toLowerCase();
  const list = loadIndex();
  const results = [];
  for (const s of list) {
    const f = path.join(SESSIONS_DIR, `${s.id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    const snippets = [];
    let hitCount = 0;
    for (const line of lines) {
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.kind !== 'user_message' && evt.kind !== 'assistant_text') continue;
      const text = String(evt.text || '');
      const ltext = text.toLowerCase();
      let idx = ltext.indexOf(lower);
      while (idx !== -1) {
        hitCount++;
        if (snippets.length < 3) {
          const start = Math.max(0, idx - 80);
          const end = Math.min(text.length, idx + lower.length + 80);
          let snippet = text.slice(start, end).replace(/\n+/g, ' ');
          if (start > 0) snippet = '…' + snippet;
          if (end < text.length) snippet = snippet + '…';
          snippets.push(snippet.replace(
            new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
            m => `\x00${m}\x00`
          ));
        }
        idx = ltext.indexOf(lower, idx + 1);
      }
    }
    if (hitCount > 0) {
      results.push({ id: s.id, title: s.title, cwd: s.cwd, last_used_at: s.last_used_at, snippets, hitCount });
    }
  }
  results.sort((a, b) => b.hitCount - a.hitCount);
  res.json(results.slice(0, 20));
});

app.get('/api/dirs', (req, res) => {
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

app.get('/api/files', (req, res) => {
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
  } catch { return res.status(400).json({ error: err.message }); }
  res.json({ path: target, parent: path.dirname(target) === target ? null : path.dirname(target), entries });
});

app.get('/api/download', (req, res) => {
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
    // Inline image display — no download, proper MIME
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

app.post('/api/mkdir', (req, res) => {
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

app.post('/api/file', (req, res) => {
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

app.post('/api/rename', (req, res) => {
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

app.get('/api/nodes', (req, res) => {
  res.json(ALL_NODES.map(({ id, name }) => ({ id, name })));
});

app.get('/api/file', (req, res) => {
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
  // Confine reads to the user's home directory — prevents reading system files
  // even if an authenticated user crafts a malicious path.
  const BASE = path.resolve(os.homedir());
  let filePath;
  try { filePath = path.resolve(rawPath); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  // Resolve symlinks before containment check to prevent traversal via symlinks
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

app.put('/api/file', (req, res) => {
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

// Serve uploaded images (used for full-resolution view; chat list uses embedded thumbnails)
app.get('/api/uploads/:filename', (req, res) => {
  const safe = String(req.params.filename || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safe || safe.startsWith('.') || safe.includes('..')) return res.status(400).end();
  const filePath = path.join(UPLOAD_DIR, safe);
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) return res.status(400).end();
  fs.access(filePath, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).send('Not found');
    res.sendFile(filePath, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  // For HTML and SW: always revalidate (no stale shell when we ship updates).
  // Other assets (icons, manifest) can be cached normally.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url ? req.url.split('?')[0] : '';
  if (pathname !== '/ws' || !isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function normalizeEvent(evt) {
  if (evt.type === 'system' && evt.subtype === 'init') {
    return [{ kind: 'turn_start', session_id: evt.session_id, cwd: evt.cwd, model: evt.model }];
  }
  if (evt.type === 'assistant' && evt.message?.content) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type === 'text') {
        out.push({ kind: 'assistant_text', text: block.text });
      } else if (block.type === 'tool_use') {
        out.push({ kind: 'tool_start', id: block.id, name: block.name, input: block.input });
      } else if (block.type === 'thinking') {
        out.push({ kind: 'thinking', text: block.thinking || '' });
      }
    }
    return out;
  }
  if (evt.type === 'user' && evt.message?.content) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type === 'tool_result') {
        let content = block.content;
        if (Array.isArray(content)) {
          content = content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
        }
        out.push({ kind: 'tool_result', tool_use_id: block.tool_use_id, content: String(content || ''), is_error: !!block.is_error });
      }
    }
    return out;
  }
  if (evt.type === 'result') {
    return [{
      kind: 'turn_complete',
      cost_usd: evt.total_cost_usd,
      duration_ms: evt.duration_ms,
      num_turns: evt.num_turns,
      is_error: !!evt.is_error,
      session_id: evt.session_id,
    }];
  }
  return [];
}

// ── Active runs registry ──────────────────────────────────
// Per-session state that survives WS disconnects.
// key: sessionId (or temp id while session_id not yet known)
const activeRuns = new Map();

function broadcast(key, msg) {
  const run = activeRuns.get(key);
  if (!run) return;
  const data = JSON.stringify(msg);
  for (const ws of run.subscribers) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch {}
    }
  }
}

// GC: remove completed runs >5 min after completion
setInterval(() => {
  const now = Date.now();
  for (const [k, run] of activeRuns) {
    if (run.status === 'done' && run.completedAt && (now - run.completedAt) > 5 * 60 * 1000) {
      activeRuns.delete(k);
    }
  }
}, 60_000).unref();

// ─── Engine implementations ──────────────────────────────────────────────

async function sendPromptClaude(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, attachedKey, isNew, onSessionId) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', currentPerm);
  if (currentPerm === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
  args.push('--model', currentModel);
  if (currentSessionId) args.push('--resume', currentSessionId);

  let proc;
  try {
    proc = spawn(CLAUDE_BIN, args, {
      cwd: currentCwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin,
      shell: isWin,
    });
  } catch (err) {
    return { error: `Failed to spawn claude: ${err.message}` };
  }

  const tempKey = '__pending_' + Math.random().toString(36).slice(2, 10);
  const initialKey = currentSessionId || tempKey;

  const userEvent = {
    kind: 'user_message',
    text,
    timestamp: Date.now(),
    ...(savedImages.length > 0 ? {
      images: savedImages.map(s => ({
        filename: s.filename, name: s.name, mime: s.mime, thumbData: s.thumbData,
      })),
    } : {}),
  };

  let promptForClaude = text;
  if (savedImages.length > 0) {
    const paths = savedImages.map(s => `- ${s.path}`).join('\n');
    promptForClaude = text.trim()
      ? `${text}\n\n---\nGambar terlampir (gunakan Read tool untuk melihatnya):\n${paths}`
      : `Tolong lihat gambar berikut menggunakan Read tool dan jelaskan:\n${paths}`;
  }

  const run = {
    proc, status: 'running', cwd: currentCwd, perm: currentPerm,
    model: currentModel, promptText: text, sessionId: currentSessionId, isNew,
    bufferedEvents: [userEvent], subscribers: new Set([ws]), completedAt: null,
  };
  activeRuns.set(initialKey, run);

  if (currentSessionId) {
    appendSessionEvent(currentSessionId, userEvent);
    run.bufferedEvents = [];
  }
  broadcast(initialKey, userEvent);

  proc.stdin.write(promptForClaude);
  proc.stdin.end();

  let stderrBuf = '';
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { console.error('parse fail:', line.slice(0, 200)); continue; }

      // First time we see session_id: re-key the activeRuns map
      if (evt.session_id && !run.sessionId) {
        run.sessionId = evt.session_id;
        if (onSessionId) onSessionId(evt.session_id);
        activeRuns.delete(initialKey);
        activeRuns.set(run.sessionId, run);
        for (const e of run.bufferedEvents) appendSessionEvent(run.sessionId, e);
        run.bufferedEvents = [];
        const title = run.isNew ? run.promptText.split('\n')[0].slice(0, 60) : undefined;
        upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: 'claude', model: run.model, ...(title ? { title } : {}) });
        broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() });
      }

      const normalized = normalizeEvent(evt);
      const key = run.sessionId || initialKey;
      for (const n of normalized) {
        if (n.kind === 'turn_complete' && typeof n.cost_usd === 'number' && run.sessionId) {
          const prev = (loadIndex().find(s => s.id === run.sessionId)?.totalCostUsd) || 0;
          upsertSessionMeta(run.sessionId, { totalCostUsd: prev + n.cost_usd });
        }
        if (run.sessionId) appendSessionEvent(run.sessionId, n);
        else run.bufferedEvents.push(n);
        broadcast(key, n);
      }
    }
  });

  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.on('error', err => {
    broadcast(run.sessionId || initialKey, { kind: 'error', message: `claude process error: ${err.message}` });
  });

  proc.on('exit', (code) => {
    run.status = 'done';
    run.completedAt = Date.now();
    const key = run.sessionId || initialKey;
    if (code !== 0 && code !== null) {
      broadcast(key, { kind: 'error', message: `claude exited with code ${code}${stderrBuf ? ': ' + stderrBuf.slice(0, 500) : ''}` });
    }
    if (run.sessionId) {
      upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: 'claude', model: run.model });
      broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() });
    }
    broadcast(key, { kind: 'turn_end' });
  });

  return { key: initialKey, sessionId: currentSessionId };
}

async function sendPromptQwen(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, attachedKey, isNew, onSessionId) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', currentPerm);
  if (currentPerm === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
  if (currentModel) args.push('--model', currentModel);
  if (currentSessionId) args.push('--resume', currentSessionId);

  let proc;
  try {
    proc = spawn(QWEN_BIN, args, {
      cwd: currentCwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin,
      shell: isWin,
    });
  } catch (err) {
    return { error: `Failed to spawn qwen: ${err.message}` };
  }

  const tempKey = '__pending_qwen_' + Math.random().toString(36).slice(2, 10);
  const initialKey = currentSessionId || tempKey;

  const userEvent = {
    kind: 'user_message',
    text,
    timestamp: Date.now(),
    ...(savedImages.length > 0 ? {
      images: savedImages.map(s => ({
        filename: s.filename, name: s.name, mime: s.mime, thumbData: s.thumbData,
      })),
    } : {}),
  };

  let promptForQwen = text;
  if (savedImages.length > 0) {
    const paths = savedImages.map(s => `- ${s.path}`).join('\n');
    promptForQwen = text.trim()
      ? `${text}\n\n---\nGambar terlampir (gunakan Read tool untuk melihatnya):\n${paths}`
      : `Tolong lihat gambar berikut menggunakan Read tool dan jelaskan:\n${paths}`;
  }

  const run = {
    proc, status: 'running', cwd: currentCwd, perm: currentPerm,
    model: currentModel, promptText: text, sessionId: currentSessionId, isNew,
    bufferedEvents: [userEvent], subscribers: new Set([ws]), completedAt: null,
  };
  activeRuns.set(initialKey, run);

  if (currentSessionId) {
    appendSessionEvent(currentSessionId, userEvent);
    run.bufferedEvents = [];
  }
  broadcast(initialKey, userEvent);

  proc.stdin.write(promptForQwen);
  proc.stdin.end();

  let stderrBuf = '';
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { console.error('parse fail qwen:', line.slice(0, 200)); continue; }

      // First time we see session_id: re-key the activeRuns map
      if (evt.session_id && !run.sessionId) {
        run.sessionId = evt.session_id;
        if (onSessionId) onSessionId(evt.session_id);
        activeRuns.delete(initialKey);
        activeRuns.set(run.sessionId, run);
        for (const e of run.bufferedEvents) appendSessionEvent(run.sessionId, e);
        run.bufferedEvents = [];
        const title = run.isNew ? run.promptText.split('\n')[0].slice(0, 60) : undefined;
        upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: 'qwen', model: run.model, ...(title ? { title } : {}) });
        broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() });
      }

      const normalized = normalizeEvent(evt);
      const key = run.sessionId || initialKey;
      for (const n of normalized) {
        if (n.kind === 'turn_complete' && typeof n.cost_usd === 'number' && run.sessionId) {
          const prev = (loadIndex().find(s => s.id === run.sessionId)?.totalCostUsd) || 0;
          upsertSessionMeta(run.sessionId, { totalCostUsd: prev + n.cost_usd });
        }
        if (run.sessionId) appendSessionEvent(run.sessionId, n);
        else run.bufferedEvents.push(n);
        broadcast(key, n);
      }
    }
  });

  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.on('error', err => {
    broadcast(run.sessionId || initialKey, { kind: 'error', message: `qwen process error: ${err.message}` });
  });

  proc.on('exit', (code) => {
    run.status = 'done';
    run.completedAt = Date.now();
    const key = run.sessionId || initialKey;
    if (code !== 0 && code !== null) {
      broadcast(key, { kind: 'error', message: `qwen exited with code ${code}${stderrBuf ? ': ' + stderrBuf.slice(0, 500) : ''}` });
    }
    if (run.sessionId) {
      upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: 'qwen', model: run.model });
      broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() });
    }
    broadcast(key, { kind: 'turn_end' });
  });

  return { key: initialKey, sessionId: currentSessionId };
}

wss.on('connection', (ws) => {
  let currentSessionId = null;
  let currentCwd = DEFAULT_CWD;
  let currentPerm = DEFAULT_PERM;
  let currentModel = DEFAULT_MODEL;
  let currentEngine = DEFAULT_ENGINE;
  let attachedKey = null;

  // Multi-node proxy state
  let proxyWs = null;
  let currentNodeId = 'local';

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  function buildHello() {
    return {
      kind: 'hello',
      defaultCwd: DEFAULT_CWD,
      defaultPerm: DEFAULT_PERM,
      defaultModel: DEFAULT_MODEL,
      defaultEngine: DEFAULT_ENGINE,
      sessions: loadIndexEnriched(),
      nodes: ALL_NODES.map(({ id, name }) => ({ id, name })),
      nodeId: 'local',
      nodeName: NODE_NAME,
    };
  }

  function closeProxy() {
    if (proxyWs) {
      proxyWs.removeAllListeners();
      proxyWs.close();
      proxyWs = null;
    }
  }

  function connectToNode(nodeId) {
    const nodeConfig = REMOTE_NODES.find(n => n.id === nodeId);
    if (!nodeConfig) { send({ kind: 'error', message: `Unknown node: ${nodeId}` }); return; }

    closeProxy();
    send({ kind: 'node_connecting', nodeId, name: nodeConfig.name });

    const wsUrl = nodeConfig.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    const auth = Buffer.from(`${nodeConfig.username}:${nodeConfig.password}`).toString('base64');

    let pws;
    try {
      pws = new WebSocket(wsUrl, { headers: { Authorization: `Basic ${auth}` } });
    } catch (err) {
      send({ kind: 'error', message: `Cannot connect to ${nodeConfig.name}: ${err.message}` });
      return;
    }

    pws.on('open', () => {
      proxyWs = pws;
      currentNodeId = nodeId;
      send({ kind: 'node_set', nodeId, name: nodeConfig.name });
    });

    pws.on('message', (data) => {
      if (ws.readyState !== ws.OPEN) return;
      // Intercept hello from remote: inject full node list so client sidebar stays intact
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.kind === 'hello') {
          parsed.nodes = ALL_NODES.map(({ id, name }) => ({ id, name }));
          parsed.nodeId = nodeId;
          parsed.nodeName = nodeConfig.name;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {}
      ws.send(data.toString());
    });

    pws.on('close', () => {
      if (proxyWs !== pws) return;
      proxyWs = null;
      currentNodeId = 'local';
      send({ kind: 'error', message: `Disconnected from ${nodeConfig.name}` });
      send({ kind: 'node_set', nodeId: 'local', name: NODE_NAME });
      send(buildHello());
    });

    pws.on('error', (err) => {
      if (proxyWs === pws) { proxyWs = null; currentNodeId = 'local'; }
      send({ kind: 'error', message: `${nodeConfig.name}: ${err.message}` });
    });
  }

  function attach(key) {
    if (attachedKey === key) return activeRuns.get(key);
    if (attachedKey) {
      const prev = activeRuns.get(attachedKey);
      if (prev) prev.subscribers.delete(ws);
    }
    attachedKey = key;
    const run = key ? activeRuns.get(key) : null;
    if (run) run.subscribers.add(ws);
    return run;
  }

  send(buildHello());

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    // Node switching — always handled locally
    if (m.type === 'set_node') {
      if (!m.nodeId || m.nodeId === 'local') {
        closeProxy();
        currentNodeId = 'local';
        send({ kind: 'node_set', nodeId: 'local', name: NODE_NAME });
        send(buildHello());
      } else {
        connectToNode(m.nodeId);
      }
      return;
    }

    // In proxy mode: forward everything else to the remote node
    if (currentNodeId !== 'local' && proxyWs) {
      if (proxyWs.readyState === WebSocket.OPEN) {
        proxyWs.send(raw.toString());
      } else {
        send({ kind: 'error', message: 'Not connected to remote node' });
      }
      return;
    }

    if (m.type === 'load_session') {
      currentSessionId = m.sessionId || null;
      const meta = loadIndex().find(s => s.id === currentSessionId);
      if (meta) {
        currentCwd = meta.cwd || DEFAULT_CWD;
        currentPerm = meta.permissionMode || DEFAULT_PERM;
        currentModel = meta.model || DEFAULT_MODEL;
        if (meta.engine && VALID_ENGINES.has(meta.engine)) {
          currentEngine = meta.engine;
        } else if (currentSessionId) {
          // Fallback for sessions created before engine field was added
          currentEngine = currentSessionId.startsWith('oi_') ? 'oi' : 'claude';
        }
      }
      const events = currentSessionId ? loadSessionEvents(currentSessionId) : [];
      const run = currentSessionId ? attach(currentSessionId) : null;
      const active = !!run && run.status === 'running';
      send({ kind: 'session_loaded', sessionId: currentSessionId, cwd: currentCwd, permissionMode: currentPerm, model: currentModel, engine: currentEngine, events, active });
      return;
    }

    if (m.type === 'new_session') {
      currentSessionId = null;
      attach(null);
      currentCwd = m.cwd || DEFAULT_CWD;
      if (m.permissionMode && VALID_PERMS.has(m.permissionMode)) currentPerm = m.permissionMode;
      const modelOk = VALID_MODELS.has(m.model) || (['oi', 'qwen'].includes(currentEngine) && typeof m.model === 'string' && m.model.length > 0);
      if (modelOk) currentModel = m.model;
      send({ kind: 'session_loaded', sessionId: null, cwd: currentCwd, permissionMode: currentPerm, model: currentModel, engine: currentEngine, events: [], active: false });
      return;
    }

    if (m.type === 'set_engine') {
      if (VALID_ENGINES.has(m.engine)) {
        currentEngine = m.engine;
        if (m.engine === 'oi') {
          fetchOIModels().then(models => {
            send({ kind: 'oi_models', models, defaultModel: OPENAI_DEFAULT_MODEL });
          }).catch(() => {});
        }
        send({ kind: 'engine_set', engine: currentEngine });
      }
      return;
    }

    if (m.type === 'set_model') {
      const modelOk = VALID_MODELS.has(m.model) || (['oi', 'qwen'].includes(currentEngine) && typeof m.model === 'string' && m.model.length > 0);
      if (modelOk) {
        currentModel = m.model;
        if (currentSessionId) upsertSessionMeta(currentSessionId, { model: currentModel });
        send({ kind: 'model_set', model: currentModel });
      }
      return;
    }

    if (m.type === 'set_cwd') {
      currentCwd = m.cwd || DEFAULT_CWD;
      if (currentSessionId) {
        currentSessionId = null;
        send({ kind: 'session_cleared', message: 'Direktori berubah — session sebelumnya dilepas. Chat baru akan dibuat di direktori baru.' });
      }
      send({ kind: 'cwd_set', cwd: currentCwd });
      return;
    }

    if (m.type === 'set_permission') {
      if (VALID_PERMS.has(m.permissionMode)) {
        currentPerm = m.permissionMode;
        if (currentSessionId) upsertSessionMeta(currentSessionId, { permissionMode: currentPerm });
        send({ kind: 'permission_set', permissionMode: currentPerm });
      }
      return;
    }

    if (m.type === 'abort') {
      const key = currentSessionId || attachedKey;
      const run = key ? activeRuns.get(key) : null;
      const proc = run?.proc;
      if (proc && run.status === 'running') {
        console.log(`[abort] killing pid=${proc.pid} (session ${key})`);
        broadcast(key, { kind: 'aborting' });
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
        setTimeout(() => {
          if (proc.exitCode === null && !proc.signalCode) {
            console.log(`[abort] escalating to SIGKILL for pid=${proc.pid}`);
            try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
          }
        }, 2000);
      }
      return;
    }

    if (m.type === 'prompt') {
      // Reject if there's already a running turn for this session
      const existing = currentSessionId ? activeRuns.get(currentSessionId) : null;
      if (existing && existing.status === 'running') {
        send({ kind: 'error', message: 'A turn is already running for this session' });
        return;
      }

      // Guard: if the session's stored CWD doesn't match current CWD, clear session
      // to avoid claude failing with "No conversation found".
      if (currentSessionId) {
        const meta = loadIndex().find(s => s.id === currentSessionId);
        if (meta && meta.cwd !== currentCwd) {
          currentSessionId = null;
          send({ kind: 'session_cleared', message: 'Session sebelumnya dibuat di direktori berbeda. Membuat chat baru.' });
        }
      }

      const text = String(m.text || '');
      const incomingImages = Array.isArray(m.images) ? m.images.slice(0, MAX_IMAGES_PER_TURN) : [];
      if (!text.trim() && incomingImages.length === 0) return;

      if (!fs.existsSync(currentCwd)) {
        send({ kind: 'error', message: `cwd does not exist: ${currentCwd}` });
        return;
      }

      // Save uploaded images to UPLOAD_DIR; collect refs for prompt + event.
      const savedImages = [];
      for (const img of incomingImages) {
        const saved = saveUploadedImage(img);
        if (saved) savedImages.push(saved);
      }
      if (incomingImages.length > 0 && savedImages.length === 0) {
        send({ kind: 'error', message: 'No valid images attached (check format / size — max 10MB each, PNG/JPG/WebP/GIF).' });
        return;
      }

      const isNew = !currentSessionId;

      if (currentEngine === 'oi') {
        const result = await sendPromptOI(ws, text, savedImages, currentSessionId, currentModel, currentCwd);
        if (result?.error) { send({ kind: 'error', message: result.error }); return; }
        if (result?.key) attachedKey = result.key;
        if (result?.sessionId) currentSessionId = result.sessionId;
      } else if (currentEngine === 'qwen') {
        const result = await sendPromptQwen(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, attachedKey, isNew, (sid) => { currentSessionId = sid; });
        if (result?.error) { send({ kind: 'error', message: result.error }); return; }
        if (result?.key) attachedKey = result.key;
        if (result?.sessionId) currentSessionId = result.sessionId;
      } else {
        const result = await sendPromptClaude(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, attachedKey, isNew, (sid) => { currentSessionId = sid; });
        if (result?.error) { send({ kind: 'error', message: result.error }); return; }
        if (result?.key) attachedKey = result.key;
        if (result?.sessionId) currentSessionId = result.sessionId;
      }
      return;
    }
  });

  ws.on('close', () => {
    closeProxy();
    // Don't kill running procs — just unsubscribe.
    if (attachedKey) {
      const run = activeRuns.get(attachedKey);
      if (run) run.subscribers.delete(ws);
    }
  });
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, HOST, () => {
  console.log(`Self Agent Orchestrator listening on http://${HOST}:${PORT}`);
  console.log(`  claude:    ${CLAUDE_BIN}`);
  console.log(`  cwd:       ${DEFAULT_CWD}`);
  console.log(`  state:     ${STATE_DIR}`);
  console.log(`  username:  ${USERNAME}`);
  console.log(`  password:  ${PASSWORD === 'changeme' ? '(default — change in .env!)' : '(set)'}`);
  if (REMOTE_NODES.length > 0) {
    console.log(`  nodes:     ${ALL_NODES.map(n => n.name).join(', ')}`);
  }
});
