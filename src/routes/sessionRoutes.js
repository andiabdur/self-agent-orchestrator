import express from 'express';
import fs from 'fs';
import path from 'path';
import { SESSIONS_DIR } from '../config.js';
import { loadIndexEnriched, loadSessionEvents, loadIndex, saveIndex } from '../services/sessionStore.js';
import { isAuthenticated } from '../services/authService.js';
import { activeRuns, broadcast } from '../services/engineService.js';

const router = express.Router();

// Generate AI summary async inside the route
function buildSessionSummary(sessionId) {
  const f = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(f)) return '';
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return ''; }
  const lines = raw.split('\n').filter(Boolean);
  const userMsgs = [];
  for (const line of lines) {
    if (userMsgs.length >= 5) break;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.kind === 'user_message' && evt.text) {
      userMsgs.push(evt.text.trim());
    }
  }
  if (!userMsgs.length) return '';
  const combined = userMsgs.join(' | ');
  return combined.length > 200 ? combined.slice(0, 197) + '...' : combined;
}

router.get('/api/sessions', (req, res) => res.json(loadIndexEnriched()));

router.get('/api/active-runs', (req, res) => {
  const sessions = loadIndex();
  const runs = [];
  for (const [key, run] of activeRuns) {
    if (run.status !== 'running') continue;
    const meta = sessions.find(s => s.id === run.sessionId) || {};
        const sid = run.sessionId || key;
    runs.push({
      sessionId: sid,
      title: meta.title || 'Untitled',
      engine: meta.engine || 'claude',
      model: run.model || meta.model || 'unknown',
      cwd: run.cwd,
      startedAt: meta.last_used_at || Date.now(),
      inputTokens: run.inputTokens || 0,
      outputTokens: run.outputTokens || 0,
      summary: run.sessionId ? buildSessionSummary(run.sessionId) : run.promptText?.slice(0, 200) || '',
    });
  }
  res.json(runs);
});

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
  // Multi-word AND search: every term must appear somewhere in the session.
  const terms = [...new Set(q.toLowerCase().split(/\s+/).filter(t => t.length >= 2))];
  if (!terms.length) return res.json([]);
  const highlightRe = new RegExp(
    terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'
  );
  const MAX_SNIPPETS = 5;
  const list = loadIndex();
  const results = [];
  for (const s of list) {
    const f = path.join(SESSIONS_DIR, `${s.id}.jsonl`);
    if (!fs.existsSync(f)) continue;
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    const found = new Set();
    const snippets = [];
    let hitCount = 0;
    for (const line of lines) {
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.kind !== 'user_message' && evt.kind !== 'assistant_text') continue;
      const text = String(evt.text || '');
      const ltext = text.toLowerCase();
      for (const term of terms) {
        let idx = ltext.indexOf(term);
        if (idx !== -1) found.add(term);
        while (idx !== -1) {
          hitCount++;
          if (snippets.length < MAX_SNIPPETS) {
            const start = Math.max(0, idx - 80);
            const end = Math.min(text.length, idx + term.length + 80);
            let snippet = text.slice(start, end).replace(/\n+/g, ' ');
            if (start > 0) snippet = '…' + snippet;
            if (end < text.length) snippet = snippet + '…';
            snippets.push(snippet.replace(highlightRe, m => `\x00${m}\x00`));
          }
          idx = ltext.indexOf(term, idx + 1);
        }
      }
    }
    if (found.size === terms.length) {
      results.push({ id: s.id, title: s.title, cwd: s.cwd, last_used_at: s.last_used_at, snippets, hitCount });
    }
  }
  // Newest conversation first — recency beats hit count for finding your way back.
  results.sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0));
  res.json(results.slice(0, 50));
});

export default router;
