import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

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
const DEFAULT_CWD = process.env.AGENT_CWD || os.homedir();
const DEFAULT_PERM = process.env.PERMISSION_MODE || 'bypassPermissions';
const VALID_PERMS = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']);
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const VALID_MODELS = new Set(['sonnet', 'opus', 'haiku']);

const STATE_DIR = process.env.STATE_DIR || path.join(os.homedir(), '.self-agent-orchestrator');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const SESSIONS_INDEX = path.join(STATE_DIR, 'sessions.json');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch { return []; }
}
function saveIndex(list) {
  fs.writeFileSync(SESSIONS_INDEX, JSON.stringify(list, null, 2));
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
  return token && activeSessions.has(token);
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

app.get('/api/sessions', (req, res) => res.json(loadIndex()));
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

app.use(express.static(path.join(__dirname, 'public')));

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

wss.on('connection', (ws) => {
  let currentSessionId = null;
  let currentCwd = DEFAULT_CWD;
  let currentPerm = DEFAULT_PERM;
  let currentModel = DEFAULT_MODEL;
  let attachedKey = null;

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

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

  send({ kind: 'hello', defaultCwd: DEFAULT_CWD, defaultPerm: DEFAULT_PERM, defaultModel: DEFAULT_MODEL, sessions: loadIndex() });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === 'load_session') {
      currentSessionId = m.sessionId || null;
      const meta = loadIndex().find(s => s.id === currentSessionId);
      if (meta) {
        currentCwd = meta.cwd || DEFAULT_CWD;
        currentPerm = meta.permissionMode || DEFAULT_PERM;
        currentModel = meta.model || DEFAULT_MODEL;
      }
      const events = currentSessionId ? loadSessionEvents(currentSessionId) : [];
      const run = currentSessionId ? attach(currentSessionId) : null;
      const active = !!run && run.status === 'running';
      send({ kind: 'session_loaded', sessionId: currentSessionId, cwd: currentCwd, permissionMode: currentPerm, model: currentModel, events, active });
      return;
    }

    if (m.type === 'new_session') {
      currentSessionId = null;
      attach(null);
      currentCwd = m.cwd || DEFAULT_CWD;
      if (m.permissionMode && VALID_PERMS.has(m.permissionMode)) currentPerm = m.permissionMode;
      if (m.model && VALID_MODELS.has(m.model)) currentModel = m.model;
      send({ kind: 'session_loaded', sessionId: null, cwd: currentCwd, permissionMode: currentPerm, model: currentModel, events: [], active: false });
      return;
    }

    if (m.type === 'set_model') {
      if (VALID_MODELS.has(m.model)) {
        currentModel = m.model;
        if (currentSessionId) upsertSessionMeta(currentSessionId, { model: currentModel });
        send({ kind: 'model_set', model: currentModel });
      }
      return;
    }

    if (m.type === 'set_cwd') {
      currentCwd = m.cwd || DEFAULT_CWD;
      if (currentSessionId) upsertSessionMeta(currentSessionId, { cwd: currentCwd });
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

      const text = String(m.text || '');
      if (!text.trim()) return;

      if (!fs.existsSync(currentCwd)) {
        send({ kind: 'error', message: `cwd does not exist: ${currentCwd}` });
        return;
      }

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
        send({ kind: 'error', message: `Failed to spawn claude: ${err.message}` });
        return;
      }

      const isNew = !currentSessionId;
      const tempKey = '__pending_' + Math.random().toString(36).slice(2, 10);
      const initialKey = currentSessionId || tempKey;
      const userEvent = { kind: 'user_message', text, timestamp: Date.now() };

      const run = {
        proc,
        status: 'running',
        cwd: currentCwd,
        perm: currentPerm,
        model: currentModel,
        promptText: text,
        sessionId: currentSessionId,
        isNew,
        bufferedEvents: [userEvent],  // for new sessions before session_id is known
        subscribers: new Set([ws]),
        completedAt: null,
      };
      activeRuns.set(initialKey, run);
      attachedKey = initialKey;

      // Immediately persist + broadcast user message
      if (currentSessionId) {
        appendSessionEvent(currentSessionId, userEvent);
        run.bufferedEvents = [];
      }
      broadcast(initialKey, userEvent);

      proc.stdin.write(text);
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
            activeRuns.delete(initialKey);
            activeRuns.set(run.sessionId, run);
            // Move any subscribers' attachedKey reference would be stale, but
            // they attached via initialKey; we need to broadcast under both keys.
            // Simpler: notify clients of the new id so their next attach uses it.
            for (const s of run.subscribers) {
              // Best-effort: refresh attach reference (not strictly needed since broadcast uses run.subscribers directly)
            }
            // Persist all buffered events with the real sessionId
            for (const e of run.bufferedEvents) appendSessionEvent(run.sessionId, e);
            run.bufferedEvents = [];
            // Update session metadata + title for new sessions
            const title = run.isNew ? run.promptText.split('\n')[0].slice(0, 60) : undefined;
            upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, model: run.model, ...(title ? { title } : {}) });
            // Inform clients about session_id assignment + updated sessions list
            broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndex() });
          }

          const normalized = normalizeEvent(evt);
          const key = run.sessionId || initialKey;
          for (const n of normalized) {
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
          upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, model: run.model });
          broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndex() });
        }
        broadcast(key, { kind: 'turn_end' });
      });

      return;
    }
  });

  ws.on('close', () => {
    // Don't kill running procs — just unsubscribe.
    if (attachedKey) {
      const run = activeRuns.get(attachedKey);
      if (run) run.subscribers.delete(ws);
    }
  });
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

server.listen(PORT, HOST, () => {
  console.log(`Self Agent Orchestrator listening on http://${HOST}:${PORT}`);
  console.log(`  claude:    ${CLAUDE_BIN}`);
  console.log(`  cwd:       ${DEFAULT_CWD}`);
  console.log(`  state:     ${STATE_DIR}`);
  console.log(`  username:  ${USERNAME}`);
  console.log(`  password:  ${PASSWORD === 'changeme' ? '(default — change in .env!)' : '(set)'}`);
});
