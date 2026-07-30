import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { DEFAULT_CWD } from '../config.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const termWss = new WebSocketServer({ noServer: true });

let ptyLib = null;
let ptyLoadError = null;

function loadPty() {
  if (ptyLib || ptyLoadError) return ptyLib;
  try {
    if (process.platform !== 'win32') {
      const plat = `${process.platform}-${process.arch}`;
      const helper = path.join(ROOT_DIR, 'node_modules', 'node-pty', 'prebuilds', plat, 'spawn-helper');
      try { if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755); } catch {}
    }
    ptyLib = require('node-pty');
  } catch (err) {
    ptyLoadError = err;
    console.warn('[term] node-pty unavailable, terminal disabled:', err.message);
  }
  return ptyLib;
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

termWss.on('connection', (ws, req) => {
  const pty = loadPty();
  if (!pty) {
    try { ws.send(JSON.stringify({ t: 'o', d: '\r\n\x1b[31mTerminal unavailable: node-pty failed to load.\x1b[0m\r\n' })); } catch {}
    ws.close();
    return;
  }

  let requestCwd = DEFAULT_CWD;
  try {
    if (req && req.url) {
      const url = new URL(req.url, 'http://localhost');
      const queryCwd = url.searchParams.get('cwd');
      if (queryCwd) {
        // Resolve ~ to HOME if necessary
        const resolvedCwd = queryCwd.startsWith('~/')
             ? path.join(process.env.HOME || process.env.USERPROFILE || '', queryCwd.slice(2))
             : (queryCwd === '~' ? (process.env.HOME || process.env.USERPROFILE || '') : queryCwd);
        if (fs.existsSync(resolvedCwd) && fs.statSync(resolvedCwd).isDirectory()) {
          requestCwd = resolvedCwd;
        }
      }
    }
  } catch (err) {
    console.warn('[term] Failed to parse cwd from request:', err.message);
  }

  let term;
  try {
    term = pty.spawn(defaultShell(), [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: requestCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    try { ws.send(JSON.stringify({ t: 'o', d: `\r\n\x1b[31mFailed to start shell: ${err.message}\x1b[0m\r\n` })); } catch {}
    ws.close();
    return;
  }

  const sendOut = (d) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'o', d })); };
  term.onData(sendOut);
  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'x', code: exitCode }));
    try { ws.close(); } catch {}
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      term.write(msg.d);
    } else if (msg.t === 'r' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      try { term.resize(Math.max(1, msg.cols), Math.max(1, msg.rows)); } catch {}
    }
  });

  ws.on('close', () => { try { term.kill(); } catch {} });
  ws.on('error', () => { try { term.kill(); } catch {} });
});
