import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  SESSIONS_DIR,
  SESSIONS_INDEX,
  DEFAULT_CWD,
  SESSION_SUMMARY_BASE_URL,
  SESSION_SUMMARY_API_KEY,
  SESSION_SUMMARY_MODEL,
} from '../config.js';

const SUMMARY_SOURCE_CHARS = 10000;
const SUMMARY_MAX_CHARS = 800;
const TITLE_MAX_CHARS = 60;
const SUMMARY_CACHE_VERSION = 'summary-v2-content-only-10000';
const TITLE_CACHE_VERSION = 'title-v2-10000';

export function loadIndex() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_INDEX, 'utf8')); } catch { return []; }
}

function sessionText(id, maxChars = SUMMARY_MAX_CHARS) {
  const f = path.join(SESSIONS_DIR, `${id}.jsonl`);
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString('utf8');
    const parts = [];
    let length = 0;
    for (const line of text.split('\n')) {
      if (length >= maxChars) break;
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const value = evt.text || evt.content || evt.message || '';
      if (typeof value === 'string' && value.trim()) {
        const cleaned = value.trim().replace(/\s+/g, ' ');
        parts.push(cleaned);
        length += cleaned.length + 1;
      }
    }
    return parts.join(' ').replace(/\s+/g, ' ').slice(0, maxChars);
  } catch { return ''; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

function contentHash(source, version) {
  return crypto.createHash('sha256').update(`${version}\n${source}`).digest('hex').slice(0, 24);
}

function cachedSummaryState(s, sourceHash) {
  const text = typeof s.chatSummary === 'string' ? s.chatSummary.trim().slice(0, SUMMARY_MAX_CHARS) : '';
  if (!text) return { text: '', fresh: false, stale: false, source: '' };
  const fresh = s.chatSummaryHash === sourceHash;
  return { text, fresh, stale: !fresh, source: fresh ? 'ai' : 'stale-cache' };
}

function cachedTitleState(s, sourceHash) {
  const title = String(s.title || '').trim();
  if (s.titleManual) return { text: title || 'Untitled', fresh: true, stale: false, source: 'manual' };

  const autoTitle = typeof s.autoTitle === 'string' ? s.autoTitle.trim().slice(0, TITLE_MAX_CHARS) : '';
  if (autoTitle) {
    const fresh = s.autoTitleHash === sourceHash;
    return { text: autoTitle, fresh, stale: !fresh, source: fresh ? 'ai' : 'stale-auto' };
  }
  if (title && title !== 'Untitled') return { text: title, fresh: false, stale: false, source: 'stored' };
  return { text: title || 'Untitled', fresh: false, stale: false, source: 'fallback' };
}

function shouldAutoTitle(s, sourceHash) {
  if (s.titleManual) return false;
  const title = String(s.title || '').trim();
  if (!title || title === 'Untitled') return true;
  return s.autoTitleHash !== sourceHash;
}

function summaryUrl() {
  return SESSION_SUMMARY_BASE_URL.replace(/\/+$/, '') + '/messages';
}

function extractResponseText(data) {
  if (typeof data?.content === 'string') return data.content;
  if (Array.isArray(data?.content)) {
    return data.content.map(block => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    }).join(' ');
  }
  if (typeof data?.completion === 'string') return data.completion;
  if (typeof data?.message === 'string') return data.message;
  return '';
}

async function callSummaryModel(system, content, maxTokens = 300) {
  if (!SESSION_SUMMARY_API_KEY || !content.trim() || typeof fetch !== 'function') return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(summaryUrl(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': SESSION_SUMMARY_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SESSION_SUMMARY_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return extractResponseText(data).replace(/\s+/g, ' ').trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSummary(source) {
  const text = await callSummaryModel(
    'Tulis deskripsi sesi untuk preview sidebar aplikasi developer. Fokus hanya pada isi pekerjaan, topik teknis, keputusan, progres, dan hasil dalam sesi. Jangan menyebut pengguna, penanya, asisten, atau frasa seperti "pengguna meminta", "user bertanya", "saya", atau "mereka". Gunakan narasi deskriptif yang to the point, padat, natural, dan informatif dalam Bahasa Indonesia. Maksimal 800 karakter. Tanpa markdown, bullet panjang, atau pembuka seperti "Berikut ringkasannya".',
    `Buat deskripsi konten dari sesi berikut:\n\n${source}`,
    300,
  );
  return text.slice(0, SUMMARY_MAX_CHARS);
}

async function generateTitle(source) {
  const text = await callSummaryModel(
    'Buat judul sesi chat untuk sidebar aplikasi developer. Fokus pada topik/pekerjaan utama, bukan pada siapa yang meminta. Jawab hanya judulnya saja. Bahasa Indonesia boleh campur istilah teknis. 3 sampai 8 kata, maksimal 60 karakter. Tanpa tanda kutip, tanpa titik, tanpa markdown.',
    `Buat judul pendek dari isi sesi berikut:\n\n${source}`,
    80,
  );
  return text.replace(/^[-–—\s"']+|[-–—\s"'.]+$/g, '').slice(0, TITLE_MAX_CHARS);
}

function addStats(enriched, id) {
  try {
    const stat = fs.statSync(path.join(SESSIONS_DIR, `${id}.jsonl`));
    enriched.bytes = stat.size;
    enriched.tokensEstimate = Math.round(stat.size / 4);
  } catch { enriched.bytes = 0; enriched.tokensEstimate = 0; }
}

function applyPreviewState(enriched, source, summaryState, titleState) {
  enriched.chatPreview = summaryState.text || source.slice(0, SUMMARY_MAX_CHARS);
  enriched.chatPreviewSource = summaryState.source || (source ? 'fallback' : 'empty');
  enriched.chatSummaryStale = !!summaryState.stale;
  enriched.titleSource = titleState.source;
  enriched.titleEdited = titleState.source === 'manual';
  enriched.titleStale = !!titleState.stale;
  if (titleState.text) enriched.title = titleState.text;
}

function enrichSession(s) {
  const enriched = { ...s };
  const source = sessionText(s.id, SUMMARY_SOURCE_CHARS);
  const summaryHash = source ? contentHash(source, SUMMARY_CACHE_VERSION) : '';
  const titleHash = source ? contentHash(source, TITLE_CACHE_VERSION) : '';
  const summaryState = cachedSummaryState(s, summaryHash);
  const titleState = cachedTitleState(s, titleHash);
  addStats(enriched, s.id);
  applyPreviewState(enriched, source, summaryState, titleState);
  return enriched;
}

async function enrichSessionWithSummary(s) {
  const enriched = { ...s };
  const source = sessionText(s.id, SUMMARY_SOURCE_CHARS);
  const summaryHash = source ? contentHash(source, SUMMARY_CACHE_VERSION) : '';
  const titleHash = source ? contentHash(source, TITLE_CACHE_VERSION) : '';
  addStats(enriched, s.id);

  let changed = false;
  let summaryState = cachedSummaryState(s, summaryHash);
  let titleState = cachedTitleState(s, titleHash);
  const now = Date.now();
  const summaryBackoffUntil = (s.chatSummaryErrorAt || 0) + 5 * 60 * 1000;
  const titleBackoffUntil = (s.autoTitleErrorAt || 0) + 5 * 60 * 1000;

  if (source && SESSION_SUMMARY_API_KEY) {
    const jobs = [];
    if (!summaryState.fresh && now > summaryBackoffUntil) jobs.push(['summary', generateSummary(source)]);
    if (!titleState.fresh && shouldAutoTitle(s, titleHash) && now > titleBackoffUntil) jobs.push(['title', generateTitle(source)]);

    const results = await Promise.allSettled(jobs.map(([, job]) => job));
    for (let i = 0; i < results.length; i++) {
      const [kind] = jobs[i];
      const result = results[i];
      if (kind === 'summary') {
        if (result.status === 'fulfilled' && result.value) {
          s.chatSummary = result.value;
          s.chatSummaryHash = summaryHash;
          s.chatSummaryUpdatedAt = Date.now();
          delete s.chatSummaryError;
          delete s.chatSummaryErrorAt;
          summaryState = cachedSummaryState(s, summaryHash);
        } else if (result.status === 'rejected') {
          s.chatSummaryError = result.reason?.message || String(result.reason || 'summary failed');
          s.chatSummaryErrorAt = Date.now();
        }
        changed = true;
      } else if (kind === 'title') {
        if (result.status === 'fulfilled' && result.value) {
          s.autoTitle = result.value;
          s.autoTitleHash = titleHash;
          s.autoTitleUpdatedAt = Date.now();
          s.title = result.value;
          delete s.autoTitleError;
          delete s.autoTitleErrorAt;
          titleState = cachedTitleState(s, titleHash);
        } else if (result.status === 'rejected') {
          s.autoTitleError = result.reason?.message || String(result.reason || 'title failed');
          s.autoTitleErrorAt = Date.now();
        }
        changed = true;
      }
    }
  }

  applyPreviewState(enriched, source, summaryState, titleState);
  if (s.chatSummaryError) enriched.chatSummaryError = s.chatSummaryError;
  if (s.autoTitleError) enriched.autoTitleError = s.autoTitleError;
  return { session: enriched, changed };
}

export function loadIndexEnriched({ offset = 0, limit = null } = {}) {
  const list = loadIndex();
  const start = Math.max(0, Number(offset) || 0);
  const end = limit == null ? undefined : start + Math.max(0, Number(limit) || 0);
  return list.slice(start, end).map(enrichSession);
}

export async function loadIndexPage(offset = 0, limit = 10) {
  const list = loadIndex();
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(100, Math.max(1, Number(limit) || 10));
  const page = list.slice(start, start + size);
  const enriched = await Promise.all(page.map(s => enrichSessionWithSummary(s)));
  if (enriched.some(r => r.changed)) saveIndex(list);
  const sessions = enriched.map(r => r.session);
  return {
    sessions,
    offset: start,
    limit: size,
    total: list.length,
    hasMore: start + sessions.length < list.length,
  };
}

export function getSessionMetaEnriched(id) {
  const meta = loadIndex().find(s => s.id === id);
  return meta ? enrichSession(meta) : null;
}

export function saveIndex(list) {
  const cleaned = list.map(({ bytes, tokensEstimate, chatPreview, ...rest }) => rest);
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
