# Plan: Tambah Engine Codex (OpenAI) — Refactor Parser Per-Engine

> **Status:** PLAN ONLY — jangan eksekusi dari dokumen ini selain sebagai panduan.
> **Audience:** model/engineer yang akan meng-eksekusi. Ikuti urutan langkah persis.
> **Tujuan:** Menambah engine ketiga `codex` di samping `claude` dan `qwen`, dengan
> parser event yang **terpisah** antara format Claude/Qwen (stream-json gaya Anthropic)
> dan format Codex (event-stream gaya OpenAI). UI tetap rapi & seragam.

---

## 0. Latar Belakang Teknis (baca dulu)

### Kenapa perlu refactor
Saat ini `src/services/engineService.js` punya **satu** fungsi global `normalizeEvent(evt)`
yang hanya mengerti skema event Claude:

```
type: 'system'    + subtype 'init'   → turn_start
type: 'assistant' + message.content[] (block: text | tool_use | thinking)
type: 'user'      + tool_result
type: 'result'    + usage/cost       → turn_complete
```

Qwen "menumpang" parser ini karena Qwen CLI **sengaja meniru** skema stream-json Claude.
Codex **tidak** — Codex memakai event-stream sendiri (`thread.started`, `turn.started`,
`item.started/completed`, `turn.completed`). Jadi `normalizeEvent` yang monolitik tidak
bisa dipakai ulang untuk Codex.

### Strategi
Ubah `normalizeEvent` dari **fungsi global** menjadi **method milik tiap engine**
(`engine.normalize`). Claude & Qwen tetap memakai normalizer yang sama (sebut
`normalizeClaudeEvent`). Codex memakai normalizer baru (`normalizeCodexEvent`) yang
memetakan event Codex → **vocabulary event internal yang sudah ada** sehingga UI tidak
perlu tahu engine mana yang dipakai.

### Kontrak event internal (TARGET output normalizer — JANGAN diubah)
Semua normalizer **wajib** menghasilkan event dengan `kind` dari daftar ini saja. UI
(`public/index.html`) sudah menangani persis kind-kind ini:

| `kind`           | field penting                                                             | dipakai UI untuk |
|------------------|---------------------------------------------------------------------------|------------------|
| `turn_start`     | `session_id`, `cwd`, `model`                                              | tandai mulai turn, simpan session aktif |
| `assistant_text` | `text`                                                                     | render bubble teks asisten |
| `thinking`       | `text`                                                                     | render blok reasoning |
| `tool_start`     | `id`, `name`, `input`                                                      | render kartu tool (mulai) |
| `tool_result`    | `tool_use_id`, `content` (string), `is_error` (bool)                       | isi hasil kartu tool |
| `turn_complete`  | `cost_usd`, `duration_ms`, `num_turns`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `is_error`, `session_id` | kartu ringkasan turn |

> **Aturan emas:** Codex normalizer **hanya** boleh meng-output `kind` di atas. Jangan
> bikin `kind` baru. Jika sebuah event Codex tidak punya padanan, kembalikan `[]`
> (di-drop), sama seperti `normalizeEvent` sekarang mengembalikan `[]` untuk event tak
> dikenal.

### Referensi skema event Codex (`codex exec --json`)
Satu objek JSON per baris (JSONL) ke stdout. Event yang relevan:

- `{"type":"thread.started","thread_id":"<uuid>"}` → **sumber session_id**.
- `{"type":"turn.started"}` → mulai turn.
- `{"type":"item.started", "item":{...}}` dan `{"type":"item.completed","item":{...}}`
  dengan `item.type` salah satu:
  - `agent_message` → `item.text` = teks asisten final (muncul di `item.completed`).
  - `reasoning` → `item.text` = ringkasan reasoning (jika diaktifkan).
  - `command_execution` → `item.command`, `item.aggregated_output`, `item.exit_code`,
    `item.status` (`in_progress`|`completed`|`failed`).
  - `file_change` → `item.changes[]` (`{path, kind: add|delete|update}`).
  - `mcp_tool_call` → `item.server`, `item.tool`, `item.arguments`, `item.result`,
    `item.error`, `item.status`.
  - Semua item punya `item.id` konsisten antar `started`/`completed`.
- `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}}`
- `{"type":"turn.failed","error":{"message":"..."}}`
- `{"type":"error","message":"..."}` (top-level)

> Catatan: Codex **tidak** mengirim `cost_usd`. Hanya token. `turn_complete.cost_usd`
> harus di-set `undefined`/`0` untuk Codex (lihat Langkah 3). Field schema bisa berubah
> antar versi Codex — perlakukan field opsional sebagai mungkin-absen.

---

## 1. Daftar File yang Disentuh

| File | Perubahan |
|------|-----------|
| `src/config.js` | resolusi `CODEX_BIN`, daftar `VALID_ENGINES`, daftar model Codex (opsional) |
| `src/services/engineService.js` | refactor `normalizeEvent` → per-engine; tambah `CODEX_ENGINE`; tambah `sendPromptCodex` |
| `src/websockets/agentWs.js` | dispatch engine `codex`; izinkan model Codex di validasi |
| `public/index.html` | tombol engine Codex di popover + settings, badge, daftar model, handler `engine_set` |
| `.env.example` | dokumentasikan `CODEX_BIN` |
| `README.md` | sebutkan engine Codex (opsional) |

**Tidak perlu menyentuh:** `sessionStore.js`, `gitService.js`, `routes/*`, `termWs.js`.
Lifecycle run, persistence, broadcast, GC — semua reuse lewat `runEngine`.

---

## 2. Langkah Backend — `src/config.js`

### 2.1 Tambah resolver `CODEX_BIN`
Tepat **setelah** blok `resolveQwenBin()` / `export const QWEN_BIN`, tambahkan pola
identik untuk Codex (tiru persis gaya `resolveQwenBin`):

```js
// Resolve CODEX_BIN dynamically
const rawCodexBin = process.env.CODEX_BIN || path.join(os.homedir(), '.local', 'bin', 'codex');
function resolveCodexBin() {
  if (rawCodexBin && fs.existsSync(rawCodexBin)) return rawCodexBin;
  if (isWin) {
    if (process.env.APPDATA) {
      const p = path.join(process.env.APPDATA, 'npm', 'codex.cmd');
      if (fs.existsSync(p)) return p;
    }
    return 'codex';
  }
  const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'codex');
  if (fs.existsSync(userLocalBin)) return userLocalBin;
  if (fs.existsSync('/usr/local/bin/codex')) return '/usr/local/bin/codex';
  if (fs.existsSync('/opt/homebrew/bin/codex')) return '/opt/homebrew/bin/codex';
  return 'codex';
}
export const CODEX_BIN = resolveCodexBin();
```

### 2.2 Daftarkan engine
Ubah baris:
```js
export const VALID_ENGINES = new Set(['claude', 'qwen']);
```
menjadi:
```js
export const VALID_ENGINES = new Set(['claude', 'qwen', 'codex']);
```

### 2.3 (Opsional) Daftar model Codex untuk backend
Tambahkan konstanta agar bisa dipakai validasi/hello jika diinginkan:
```js
export const CODEX_MODELS = [
  { id: 'gpt-5-codex',  label: 'GPT-5 Codex' },
  { id: 'gpt-5',        label: 'GPT-5' },
  { id: 'o4-mini',      label: 'o4-mini' },
];
```
> Daftar model **tidak wajib** divalidasi ketat (lihat catatan validasi di Langkah 4).
> Sesuaikan id model dengan yang benar-benar didukung versi Codex yang terpasang —
> verifikasi via `codex --help` / dokumentasi saat eksekusi.

---

## 3. Langkah Backend — `src/services/engineService.js` (inti)

### 3.1 Pisahkan normalizer Claude
Ganti **nama** fungsi `normalizeEvent` menjadi `normalizeClaudeEvent`. **Isi tidak
berubah.** (Ini fungsi yang sekarang ada di sekitar baris 50–80.)

```js
function normalizeClaudeEvent(evt) {
  // ... isi PERSIS seperti normalizeEvent yang sekarang, tidak diubah ...
}
```

### 3.2 Tulis normalizer Codex baru
Tambahkan fungsi baru di bawahnya. Fungsi ini menerima satu event Codex (`evt`) dan
mengembalikan array event internal (kontrak di Bagian 0).

```js
// Codex (OpenAI) memakai event-stream sendiri. Kita map ke vocabulary internal yang
// sama dengan Claude/Qwen agar UI tidak perlu tahu engine mana.
//
// Untuk command_execution & mcp_tool_call kita pakai dua event: tool_start (saat
// item.started) dan tool_result (saat item.completed), memakai item.id sebagai
// id/tool_use_id supaya UI memasangkannya seperti pasangan tool_use/tool_result Claude.
function normalizeCodexEvent(evt) {
  switch (evt.type) {
    case 'thread.started':
      // session_id ditangani di processLine via evt.session_id (lihat 3.4);
      // emit turn_start agar UI menandai awal turn.
      return [{ kind: 'turn_start', session_id: evt.thread_id }];

    case 'turn.started':
      return []; // tidak ada padanan; turn_start sudah dari thread.started

    case 'item.started': {
      const it = evt.item || {};
      if (it.type === 'command_execution') {
        return [{ kind: 'tool_start', id: it.id, name: 'shell',
                  input: { command: it.command } }];
      }
      if (it.type === 'mcp_tool_call') {
        return [{ kind: 'tool_start', id: it.id, name: `${it.server}:${it.tool}`,
                  input: it.arguments }];
      }
      return []; // agent_message/reasoning/file_change hanya dipakai saat completed
    }

    case 'item.completed': {
      const it = evt.item || {};
      if (it.type === 'agent_message') {
        return [{ kind: 'assistant_text', text: it.text || '' }];
      }
      if (it.type === 'reasoning') {
        return [{ kind: 'thinking', text: it.text || '' }];
      }
      if (it.type === 'command_execution') {
        return [{ kind: 'tool_result', tool_use_id: it.id,
                  content: String(it.aggregated_output || ''),
                  is_error: it.status === 'failed' || (it.exit_code && it.exit_code !== 0) }];
      }
      if (it.type === 'mcp_tool_call') {
        const body = it.error ? String(it.error)
                              : (typeof it.result === 'string' ? it.result : JSON.stringify(it.result ?? ''));
        return [{ kind: 'tool_result', tool_use_id: it.id, content: body,
                  is_error: !!it.error || it.status === 'failed' }];
      }
      if (it.type === 'file_change') {
        // Tidak ada item.started untuk file_change → emit tool_start + tool_result
        // sekaligus agar UI tetap menampilkan kartu.
        const summary = (it.changes || [])
          .map(c => `${c.kind}: ${c.path}`).join('\n');
        return [
          { kind: 'tool_start',  id: it.id, name: 'apply_patch', input: { changes: it.changes } },
          { kind: 'tool_result', tool_use_id: it.id, content: summary, is_error: false },
        ];
      }
      return [];
    }

    case 'turn.completed': {
      const u = evt.usage || {};
      return [{
        kind: 'turn_complete',
        cost_usd: undefined,            // Codex tidak mengirim cost
        duration_ms: undefined,
        num_turns: undefined,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cached_input_tokens,
        cache_creation_tokens: undefined,
        is_error: false,
      }];
    }

    case 'turn.failed':
      return [{ kind: 'turn_complete', is_error: true,
                cost_usd: undefined }];

    case 'error':
      // biar konsisten dgn jalur error lain, lempar sebagai tool-less error text
      return [{ kind: 'assistant_text', text: `⚠️ Codex error: ${evt.message || 'unknown'}` }];

    default:
      return [];
  }
}
```

> **Keputusan desain yang harus dipatuhi eksekutor:**
> - `name: 'shell'` untuk command_execution dan `name: 'apply_patch'` untuk file_change
>   dipilih agar kartu tool di UI terbaca natural (mirip tool Claude). Boleh disesuaikan
>   tapi jangan kosongkan `name`.
> - `is_error` pada tool_result HARUS boolean.
> - `content` pada tool_result HARUS string (jangan kirim objek mentah).

### 3.3 Pasang normalizer ke objek engine
Pada definisi `CLAUDE_ENGINE` dan `QWEN_ENGINE`, tambahkan field `normalize`:

```js
const CLAUDE_ENGINE = {
  name: 'claude',
  bin: CLAUDE_BIN,
  keyPrefix: '__pending_',
  logParseErrors: true,
  normalize: normalizeClaudeEvent,   // ← tambah
  buildArgs(perm, model, sessionId) { /* tidak berubah */ },
};

const QWEN_ENGINE = {
  name: 'qwen',
  bin: QWEN_BIN,
  keyPrefix: '__pending_qwen_',
  logParseErrors: false,
  normalize: normalizeClaudeEvent,   // ← reuse normalizer Claude
  buildArgs(perm, model, sessionId) { /* tidak berubah */ },
};
```

Tambahkan import `CODEX_BIN` di baris atas:
```js
import { isWin, CLAUDE_BIN, QWEN_BIN, CODEX_BIN } from '../config.js';
```

### 3.4 Definisikan `CODEX_ENGINE`
Codex butuh dua hal khusus: (a) `buildArgs` berbeda, (b) session_id datang dari field
`thread_id`, bukan `session_id`. Untuk (b), normalizer sudah memetakan ke `turn_start`,
tapi mekanisme penemuan session di `runEngine` membaca `evt.session_id` (lihat 3.6).

```js
const CODEX_ENGINE = {
  name: 'codex',
  bin: CODEX_BIN,
  keyPrefix: '__pending_codex_',
  logParseErrors: true,
  normalize: normalizeCodexEvent,
  // Codex CLI: `codex exec --json [--model M] "<prompt>"`
  // resume: `codex exec resume <SESSION_ID> --json "<prompt>"`
  buildArgs(perm, model, sessionId) {
    const args = ['exec', '--json'];
    // Pemetaan permission → sandbox Codex.
    // bypassPermissions → full akses; selain itu workspace-write.
    if (perm === 'bypassPermissions') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('-c', 'approval_policy="never"');
      args.push('-c', 'sandbox_mode="workspace-write"');
    }
    if (model && model !== 'default') args.push('--model', model);
    if (sessionId) {
      // resume berada SETELAH 'exec': bentuknya `codex exec resume <id> --json ...`
      // Jadi sisipkan subcommand resume di awal args alih-alih flag --resume.
      return ['exec', 'resume', sessionId, '--json',
              ...(model && model !== 'default' ? ['--model', model] : []),
              ...(perm === 'bypassPermissions'
                  ? ['--dangerously-bypass-approvals-and-sandbox']
                  : ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"'])];
    }
    return args;
  },
};
```

> **PENTING soal flag:** flag sandbox/approval & subcommand `resume` Codex **berubah
> antar versi**. Saat eksekusi, jalankan `codex exec --help` dan `codex exec resume --help`
> di mesin target, lalu sesuaikan. Yang pasti & stabil: `codex exec --json` dan
> `--model`. Verifikasi sisanya sebelum commit.

### 3.5 Ganti pemanggilan normalizer di `runEngine`
Di dalam `processLine`, ganti:
```js
const normalized = normalizeEvent(evt);
```
menjadi:
```js
const normalized = engine.normalize(evt);
```

### 3.6 Tangani session_id Codex (`thread_id`)
Blok penemuan session di `processLine` saat ini berbunyi:
```js
if (evt.session_id && !run.sessionId) { ... }
```
Codex mengirim `thread_id` di `thread.started`, bukan `session_id`. Buat agar blok itu
juga menangkap `thread_id`. Ubah baris pertama menjadi:
```js
const incomingSessionId = evt.session_id || evt.thread_id;
if (incomingSessionId && !run.sessionId) {
  run.sessionId = incomingSessionId;
  if (onSessionId) onSessionId(incomingSessionId);
  activeRuns.delete(initialKey);
  activeRuns.set(run.sessionId, run);
  // ... sisa blok TIDAK berubah, hanya ganti evt.session_id → incomingSessionId ...
}
```
> Validasi format session id (`/^[a-zA-Z0-9_.-]+$/`) di awal `runEngine` sudah cocok
> dengan UUID Codex (mengandung `-`). Tidak perlu diubah.

### 3.7 Ekspor `sendPromptCodex`
Tambahkan di bawah `sendPromptQwen`:
```js
export function sendPromptCodex(ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId) {
  return runEngine(CODEX_ENGINE, ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId);
}
```

> **Catatan gambar:** jalur `savedImages` saat ini menyisipkan path file ke prompt teks
> ("gunakan Read tool"). Codex tidak punya Read tool yang sama. Untuk versi pertama,
> biarkan apa adanya (Codex akan dapat path sebagai teks). Penanganan gambar Codex
> yang benar di luar scope refactor ini — catat sebagai follow-up.

---

## 4. Langkah Backend — `src/websockets/agentWs.js`

### 4.1 Import sender Codex
```js
import { activeRuns, sendPromptClaude, sendPromptQwen, sendPromptCodex, broadcast } from '../services/engineService.js';
```

### 4.2 Dispatch engine `codex`
Pada handler `m.type === 'prompt'`, struktur sekarang `if (currentEngine === 'qwen') {...} else {...}`.
Ubah menjadi tiga cabang:
```js
let result;
if (currentEngine === 'qwen') {
  result = await sendPromptQwen(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, (sid) => { currentSessionId = sid; });
} else if (currentEngine === 'codex') {
  result = await sendPromptCodex(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, (sid) => { currentSessionId = sid; });
} else {
  result = await sendPromptClaude(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, (sid) => { currentSessionId = sid; });
}
if (result?.error) { send({ kind: 'error', message: result.error }); return; }
if (result?.key) attachedKey = result.key;
if (result?.sessionId) currentSessionId = result.sessionId;
```

### 4.3 Validasi model untuk Codex
Ada beberapa tempat memakai pola:
```js
const modelOk = VALID_MODELS.has(m.model) || (currentEngine === 'qwen' && typeof m.model === 'string' && m.model.length > 0);
```
`VALID_MODELS` hanya berisi model Claude. Untuk Codex, model bebas (string non-kosong),
sama seperti Qwen. Buat helper kecil di atas `wss.on('connection')` atau inline:
```js
function modelAllowed(engine, model) {
  if (VALID_MODELS.has(model)) return true;
  if ((engine === 'qwen' || engine === 'codex') && typeof model === 'string' && model.length > 0) return true;
  return false;
}
```
Lalu ganti tiap `const modelOk = ...` menjadi `const modelOk = modelAllowed(currentEngine, m.model);`.
Lokasi: handler `new_session`, `set_model`. (Cari semua kemunculan pola `modelOk`.)

> Tidak ada perubahan lain di `agentWs.js`. `load_session` sudah membaca `meta.engine`
> via `VALID_ENGINES` yang kini memuat `codex`, jadi resume engine Codex otomatis jalan.

---

## 5. Langkah Frontend — `public/index.html`

Target: Codex tampil sebagai pilihan engine ketiga, badge & popover rapi, daftar model
GPT muncul. Semua event masuk lewat `kind` internal yang sudah dirender — **tidak ada
perubahan logika render** yang diperlukan.

### 5.1 Warna badge Codex (CSS, dekat baris ~1702)
Setelah:
```css
.engine-badge.claude { border-color: var(--accent); color: var(--accent); }
.engine-badge.qwen { border-color: #3b82f6; color: #3b82f6; }
```
tambah:
```css
.engine-badge.codex { border-color: #10a37f; color: #10a37f; } /* OpenAI green */
```

### 5.2 Tombol engine di popover (HTML, dekat baris ~1761)
Setelah tombol `data-engine="qwen"`:
```html
<button class="popover-opt" data-engine="codex" type="button">
  <span class="opt-dot"></span>Codex
</button>
```

### 5.3 Opsi di settings select (HTML, dekat baris ~1915)
Setelah `<option value="qwen">Qwen Code</option>`:
```html
<option value="codex">Codex</option>
```

### 5.4 Daftar model Codex — definisikan sekali, pakai ulang
Cari fungsi `buildPopoverModels()` (≈ baris 4614) dan handler `case 'engine_set'`
(≈ baris 2392). Keduanya hard-code daftar model Qwen. Untuk Codex, tambahkan daftar
model dan cabang baru.

Tambahkan helper dekat `claudeModelOptionsHtml` (≈ baris 4834):
```js
const CODEX_MODELS_UI = [
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { id: 'gpt-5',       label: 'GPT-5' },
  { id: 'o4-mini',     label: 'o4-mini' },
];
function codexModelOptionsHtml(selected) {
  return CODEX_MODELS_UI.map(m =>
    `<option value="${m.id}"${m.id === selected ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('');
}
```

### 5.5 `case 'engine_set'` — tambah cabang codex (≈ baris 2392)
Setelah blok `else if (m.engine === 'qwen') { ... }` tambah:
```js
} else if (m.engine === 'codex') {
  els.modelSelect.innerHTML = codexModelOptionsHtml(state.model || 'gpt-5-codex');
  if (state.model && els.modelSelect.querySelector(`option[value="${CSS.escape(state.model)}"]`)) {
    els.modelSelect.value = state.model;
  } else {
    els.modelSelect.value = 'gpt-5-codex';
  }
  state.model = els.modelSelect.value;
  send({ type: 'set_model', model: state.model });
}
```

### 5.6 `buildPopoverModels()` — tambah cabang codex (≈ baris 4614)
Setelah blok `else if (state.engine === 'qwen') { ... }` tambah cabang yang membangun
tombol dari `CODEX_MODELS_UI` (tiru persis pola loop Qwen, ganti sumber array):
```js
} else if (state.engine === 'codex') {
  for (const m of CODEX_MODELS_UI) {
    const btn = document.createElement('button');
    btn.className = 'popover-opt' + (state.model === m.id ? ' active' : '');
    btn.type = 'button';
    btn.dataset.model = m.id;
    const dot = document.createElement('span');
    dot.className = 'opt-dot';
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(m.label));
    btn.addEventListener('click', () => {
      state.model = m.id;
      els.modelSelect.value = m.id;
      send({ type: 'set_model', model: m.id });
      updateEngineBadge(state.engine, m.id);
      closePopover();
    });
    sec.appendChild(btn);
  }
}
```

### 5.7 `updateEngineBadge()` — label & model (≈ baris 4839)
Ubah penentuan label:
```js
if (label) {
  if (engine === 'qwen') label.textContent = 'Qwen Code';
  else if (engine === 'codex') label.textContent = 'Codex';
  else label.textContent = 'Claude Code';
}
if (modelSpan) {
  if (engine === 'claude') {
    modelSpan.textContent = claudeModelLabel(model);
  } else if (engine === 'codex') {
    const found = CODEX_MODELS_UI.find(x => x.id === model);
    modelSpan.textContent = found ? found.label : (model || '');
  } else {
    modelSpan.textContent = model === 'default' ? 'default' : (model || '');
  }
}
```

### 5.8 `loadSession()` — pilih model options sesuai engine (≈ baris 3817)
Saat ini: `els.modelSelect.innerHTML = claudeModelOptionsHtml(...)` tanpa cek engine.
Bungkus jadi kondisional:
```js
if (state.engine === 'codex') {
  els.modelSelect.innerHTML = codexModelOptionsHtml(state.model || 'gpt-5-codex');
} else if (state.engine === 'qwen') {
  // (biarkan logika qwen yang sudah ada, atau samakan polanya)
} else {
  els.modelSelect.innerHTML = claudeModelOptionsHtml(state.model || 'sonnet');
}
```
> Periksa juga blok serupa di sekitar baris 2279 (handler `hello`) dan terapkan pola
> kondisional yang sama bila engine default bisa berupa codex.

---

## 6. Langkah Konfigurasi & Dokumen

### 6.1 `.env.example`
Tambahkan baris:
```
# Path ke Codex CLI (opsional; auto-resolve bila kosong)
CODEX_BIN=
```

### 6.2 `README.md` (opsional)
Sebut Codex pada bagian engine yang didukung.

---

## 7. Urutan Eksekusi yang Disarankan

1. **Backend dulu, end-to-end, sebelum sentuh UI.**
   1. `config.js`: `CODEX_BIN`, `VALID_ENGINES`, (opsional) `CODEX_MODELS`.
   2. `engineService.js`: rename normalizer, tambah `normalizeCodexEvent`, pasang
      `normalize` ke tiap engine, `CODEX_ENGINE`, `engine.normalize(evt)`,
      `thread_id` handling, `sendPromptCodex`.
   3. `agentWs.js`: import + dispatch + `modelAllowed`.
2. **Uji backend tanpa UI** (lihat Bagian 8). Pastikan event mengalir benar.
3. **Frontend** (`index.html`): badge, popover, settings, model list, handler.
4. **Konfig & docs.**

> Rasionalnya: parser adalah 80% risiko. Validasi event Codex → kontrak internal lebih
> dulu; UI hanya konsumen pasif dari `kind` yang sudah terbukti benar.

---

## 8. Strategi Verifikasi (WAJIB sebelum tandai selesai)

### 8.1 Prasyarat
- Codex CLI terpasang & login: cek `codex --version`, `which codex`.
- Set `CODEX_BIN` di `.env` bila path non-standar.

### 8.2 Rekam skema event nyata (jangan percaya dokumen ini buta)
Jalankan dan SIMPAN output untuk memverifikasi nama field:
```bash
cd <repo-yang-aman>
codex exec --json "buat file hello.txt berisi 'hi' lalu jalankan: ls -la" | tee /tmp/codex-events.jsonl
```
Bandingkan field aktual (`thread_id`, `item.type`, `item.text`, `usage.*`, `turn.completed`)
dengan asumsi di Bagian 0/3. **Jika berbeda, sesuaikan `normalizeCodexEvent`** — dokumen
ini adirujuk dari dokumentasi publik dan bisa meleset antar versi.

### 8.3 Uji integrasi via UI
1. `npm start` (atau `./start.sh`).
2. Buka UI, pilih engine **Codex**, pilih model.
3. Kirim prompt yang memicu: teks + perintah shell + perubahan file, mis.
   "buat file `demo.txt` isi 'halo', lalu `cat demo.txt`".
4. **Cek tiap kind tampil benar:**
   - bubble teks asisten (`agent_message` → `assistant_text`),
   - kartu tool shell dengan output (`command_execution` → tool_start/result),
   - kartu perubahan file (`file_change` → apply_patch),
   - ringkasan turn dengan token (`turn.completed` → turn_complete).
5. **Resume:** kirim prompt lanjutan di session yang sama → pastikan `codex exec resume`
   dipakai dan konteks nyambung.
6. **Persistence:** reload halaman, buka session Codex dari sidebar → event ter-replay,
   badge menunjukkan "Codex", engine ter-restore (`meta.engine === 'codex'`).
7. **Abort:** mulai turn panjang lalu Stop → proses Codex mati (cek tidak ada proses
   `codex` nyangkut: `ps aux | grep codex`).

### 8.4 Regresi
- Jalankan satu turn **Claude** dan satu turn **Qwen** → pastikan tidak rusak oleh
  refactor normalizer (keduanya kini lewat `engine.normalize`).

---

## 9. Risiko & Catatan untuk Eksekutor

| Risiko | Mitigasi |
|--------|----------|
| Skema event Codex beda antar versi | Rekam `codex-events.jsonl` (8.2) sebelum finalisasi parser |
| Flag sandbox/approval/resume berubah | `codex exec --help`, `codex exec resume --help` di mesin target |
| Codex tidak kirim `cost_usd` | `turn_complete.cost_usd = undefined`; `totalCostUsd` tidak bertambah (OK) |
| Reasoning hanya muncul bila diaktifkan | Tidak fatal; `thinking` kosong → di-drop di UI |
| Gambar (savedImages) | Versi pertama: path disisipkan ke prompt (sama seperti sekarang); follow-up terpisah |
| `apply_patch`/`file_change` tanpa item.started | Sudah ditangani: emit tool_start+tool_result sekaligus (3.2) |
| Validasi model menolak id GPT | `modelAllowed()` mengizinkan string bebas untuk codex (4.3) |

---

## 10. Definition of Done

- [ ] Pilih engine "Codex" di UI → kirim prompt → balasan teks, kartu tool shell,
      perubahan file, dan ringkasan token tampil rapi.
- [ ] Resume session Codex berfungsi (konteks nyambung, pakai `exec resume`).
- [ ] Reload + buka session Codex → replay benar, badge & engine ter-restore.
- [ ] Abort mematikan proses Codex tanpa sisa.
- [ ] Turn Claude & Qwen tetap normal (tidak ada regresi dari refactor normalizer).
- [ ] `normalizeCodexEvent` hanya meng-output `kind` dari kontrak Bagian 0.
- [ ] Tidak ada `kind` baru ditambahkan; tidak ada perubahan logika render UI.

---

### Lampiran: Referensi
- Codex `exec --json` event cheatsheet: https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/
- Codex app-server schema (sumber kebenaran per versi): `codex app-server generate-json-schema`
- Codex CLI reference (flags): https://developers.openai.com/codex/cli/reference
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
