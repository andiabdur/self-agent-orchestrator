import fs from 'fs';
import path from 'path';
import { SESSIONS_DIR, SESSIONS_INDEX, DEFAULT_CWD } from '../config.js';

export function loadIndex() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch { return []; }
}

export function loadIndexEnriched() {
  const list = loadIndex();
  for (const s of list) {
    try {
      const stat = fs.statSync(path.join(SESSIONS_DIR, `${s.id}.jsonl`));
      s.bytes = stat.size;
      s.tokensEstimate = Math.round(stat.size / 4);
    } catch { s.bytes = 0; s.tokensEstimate = 0; }
  }
  return list;
}

export function saveIndex(list) {
  const cleaned = list.map(({ bytes, tokensEstimate, ...rest }) => rest);
  fs.writeFileSync(SESSIONS_INDEX, JSON.stringify(cleaned, null, 2));
}

export function loadSessionEvents(id) {
  const f = path.join(SESSIONS_DIR, `${id}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function appendSessionEvent(id, evt) {
  fs.appendFileSync(path.join(SESSIONS_DIR, `${id}.jsonl`), JSON.stringify(evt) + '\n');
}

export function upsertSessionMeta(id, patch) {
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
