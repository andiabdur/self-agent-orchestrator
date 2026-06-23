import express from 'express';
import { USERNAME, PASSWORD } from '../config.js';
import { activeSessions, isAuthenticated, getSessionToken } from '../services/authService.js';

const router = express.Router();

router.post('/api/login', (req, res) => {
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

export default router;
