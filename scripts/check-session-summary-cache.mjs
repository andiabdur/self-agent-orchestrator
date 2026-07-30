import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sao-session-cache-'));
const sessionsDir = path.join(stateDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

process.env.STATE_DIR = stateDir;
process.env.SESSION_SUMMARY_API_KEY = 'test-key';
process.env.SESSION_SUMMARY_BASE_URL = 'http://summary.test/v1';
process.env.SESSION_SUMMARY_MODEL = 'test-summary-model';

function writeEvents(id, messages) {
  fs.writeFileSync(
    path.join(sessionsDir, `${id}.jsonl`),
    messages.map(text => JSON.stringify({ kind: 'user_message', text })).join('\n') + '\n',
  );
}

writeEvents('stale-session', [
  'Investigasi bug cache summary sidebar. Fallback raw transcript tidak boleh mengganti summary AI lama yang masih lebih berguna.',
]);
writeEvents('partial-session', [
  'Implementasi generation summary dan title harus independent. Kalau title gagal timeout, summary yang berhasil tetap disimpan.',
]);

const now = Date.now();
fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify([
  {
    id: 'stale-session',
    title: 'Judul AI Lama',
    autoTitle: 'Judul AI Lama',
    autoTitleHash: 'old-title-hash',
    chatSummary: 'Summary AI lama yang harus tetap tampil saat cache stale dan generator sedang backoff.',
    chatSummaryHash: 'old-summary-hash',
    chatSummaryError: 'This operation was aborted',
    chatSummaryErrorAt: now,
    cwd: '/tmp/project',
    created_at: now - 1000,
    last_used_at: now,
  },
  {
    id: 'partial-session',
    title: 'Untitled',
    chatSummaryHash: 'old-summary-hash',
    autoTitleHash: 'old-title-hash',
    cwd: '/tmp/project',
    created_at: now - 2000,
    last_used_at: now - 1,
  },
], null, 2));

let fetchCalls = 0;
global.fetch = async (_url, options = {}) => {
  fetchCalls++;
  const body = JSON.parse(options.body || '{}');
  if (String(body.system || '').includes('deskripsi sesi')) {
    return {
      ok: true,
      async json() {
        return { content: [{ type: 'text', text: 'Summary AI baru yang sukses disimpan walau title gagal.' }] };
      },
    };
  }
  throw new Error('title generator timeout');
};

const { loadIndexPage, loadIndex } = await import('../src/services/sessionStore.js');

const page = await loadIndexPage(0, 2);
const stale = page.sessions.find(s => s.id === 'stale-session');
const partial = page.sessions.find(s => s.id === 'partial-session');

assert.equal(stale.chatPreview, 'Summary AI lama yang harus tetap tampil saat cache stale dan generator sedang backoff.');
assert.equal(stale.chatPreviewSource, 'stale-cache');
assert.equal(stale.chatSummaryStale, true);
assert.equal(stale.titleSource, 'stale-auto');

assert.equal(partial.chatPreview, 'Summary AI baru yang sukses disimpan walau title gagal.');
assert.equal(partial.chatPreviewSource, 'ai');
assert.equal(partial.chatSummaryStale, false);
assert.equal(partial.title, 'Untitled');
assert.equal(partial.titleSource, 'fallback');
assert.equal(partial.autoTitleError, 'title generator timeout');

const savedPartial = loadIndex().find(s => s.id === 'partial-session');
assert.equal(savedPartial.chatSummary, 'Summary AI baru yang sukses disimpan walau title gagal.');
assert.ok(savedPartial.chatSummaryHash);
assert.equal(savedPartial.chatSummaryError, undefined);
assert.equal(savedPartial.autoTitleError, 'title generator timeout');

assert.equal(fetchCalls, 3, 'stale summary in backoff should not regenerate, but stale titles can retry independently');

console.log('session summary cache checks passed');
