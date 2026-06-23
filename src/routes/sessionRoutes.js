import express from 'express';
import fs from 'fs';
import path from 'path';
import { SESSIONS_DIR } from '../config.js';
import { loadIndexEnriched, loadSessionEvents, loadIndex, saveIndex } from '../services/sessionStore.js';
import { isAuthenticated } from '../services/authService.js';

const router = express.Router();

router.get('/api/sessions', (req, res) => res.json(loadIndexEnriched()));

router.get('/api/sessions/:id/events', (req, res) => res.json(loadSessionEvents(req.params.id)));

router.delete('/api/sessions/:id', (req, res) => {
  const list = loadIndex().filter(s => s.id !== req.params.id);
  saveIndex(list);
  try { fs.unlinkSync(path.join(SESSIONS_DIR, `${req.params.id}.jsonl`)); } catch {}
  res.json({ ok: true });
});

router.patch('/api/sessions/:id', (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ error: 'title required' });
  const list = loadIndex();
  const i = list.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  list[i].title = title;
  saveIndex(list);
  res.json({ ok: true, sessions: list });
});

router.get('/api/sessions/search', (req, res) => {
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

export default router;
