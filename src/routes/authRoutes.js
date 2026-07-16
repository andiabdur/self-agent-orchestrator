import express from 'express';
import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { USERNAME, PASSWORD } from '../config.js';
import { activeSessions, isAuthenticated, getSessionToken } from '../services/authService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const RESTART_SCRIPT = path.join(ROOT_DIR, 'restart.sh');

const router = express.Router();

router.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }
  if (username === USERNAME && password === PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.add(token);
    res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Username atau password salah' });
});

router.post('/api/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    activeSessions.delete(token);
  }
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

router.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

router.post('/api/restart', (req, res) => {
  res.json({ ok: true });
  const child = spawn('/bin/bash', [RESTART_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT_DIR,
  });
  child.unref();
  setTimeout(() => process.exit(0), 300);
});

export default router;
