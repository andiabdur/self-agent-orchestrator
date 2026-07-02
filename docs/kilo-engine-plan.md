# Plan: Tambah Engine Kilo Code — Engine Keempat (Parser Per-Engine)

> **Status:** PLAN ONLY — jangan eksekusi dari dokumen ini selain sebagai panduan.
> **Audience:** model/engineer yang akan meng-eksekusi. Ikuti urutan langkah persis.
> **Konteks:** Engine Codex sudah ter-merge (commit `414a22e`). Pola parser per-engine
> sudah mapan: `engine.normalize(evt)` di `runEngine`, tiap engine punya `buildArgs` &
> `normalize` sendiri. Plan ini menambah engine **keempat** `kilo` mengikuti pola itu
> **persis**. Bila ragu, tiru implementasi `codex` yang sudah ada sebagai template.

---

## 0. Latar Belakang Teknis (baca dulu)

### Kenapa Kilo butuh normalizer baru
Tiap engine memetakan output CLI-nya ke **kontrak event internal** (lihat tabel di §0.3)
yang dirender UI. Tiga engine yang ada:

| Engine | Format CLI | Normalizer |
|--------|-----------|-----------|
| `claude` | stream-json gaya Anthropic (`type: assistant/user/result`) | `normalizeClaudeEvent` |
| `qwen` | meniru stream-json Claude | `normalizeClaudeEvent` (reuse) |
| `codex` | event-stream OpenAI (`thread.started`, `item.completed`, `turn.completed`) | `normalizeCodexEvent` |

**Kilo** memakai arsitektur event yang **berbeda dari ketiganya** — turunan OpenCode.
Event bus-nya (terverifikasi dari log `kilo run --print-logs`):
```
session.created, session.updated, session.status,
session.turn.open, session.turn.close, session.diff,
message.updated, message.part.updated, message.part.delta,
command.executed, permission.asked, question.asked
```
Jadi Kilo **wajib** punya `normalizeKiloEvent` sendiri. Tidak bisa reuse.

### CLI Kilo (terverifikasi via `kilo run --help`, versi 7.3.46)
```
kilo run "<message>" [options]
  --auto                          auto-approve semua permission (WAJIB untuk non-interaktif)
  --dangerously-skip-permissions  auto-approve yang tidak explicitly denied
  --format json                   raw JSON events (default: "default")  ← WAJIB
  -m, --model  provider/model     pilih model (mis. anthropic/claude-sonnet-4)
  --dir <path>                    direktori kerja
  -s, --session <id>              lanjutkan session tertentu (resume)
  -c, --continue                  lanjutkan session terakhir
  --fork                          fork session saat continue
  --variant <effort>              reasoning effort (high/max/minimal)
  --thinking                      tampilkan blok thinking
  -f, --file <path>               lampirkan file (relevan untuk gambar!)
  --title <text>                  judul session
```
> Prompt adalah **positional argument**, BUKAN stdin. Ini beda dari Claude/Qwen/Codex
> yang menulis prompt via `proc.stdin`. Lihat §3.5 (penanganan khusus stdin).

### 0.3 Kontrak event internal (TARGET output normalizer — JANGAN diubah)
Semua normalizer hanya boleh meng-output `kind` berikut. UI sudah menanganinya:

| `kind`           | field penting | dipakai UI untuk |
|------------------|---------------|------------------|
| `turn_start`     | `session_id`, `cwd`, `model` | tandai mulai turn |
| `assistant_text` | `text` | bubble teks asisten (blok penuh) |
| `assistant_delta`| `text` | streaming teks inkremental |
| `thinking`       | `text` | blok reasoning |
| `tool_start`     | `id`, `name`, `input` | kartu tool (mulai) |
| `tool_result`    | `tool_use_id`, `content` (string), `is_error` (bool) | isi hasil kartu tool |
| `turn_complete`  | `cost_usd`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `is_error`, `session_id` | kartu ringkasan turn |

> **Aturan emas:** `normalizeKiloEvent` HANYA boleh meng-output `kind` di atas. Jangan
> bikin `kind` baru. Event Kilo yang tak punya padanan → kembalikan `[]` (di-drop).
> UI tidak boleh diubah logikanya.

> **Catatan `assistant_delta`:** UI sudah punya handler `assistant_delta` (streaming).
> Kilo mengirim `message.part.delta` untuk teks inkremental — ini peluang bagus untuk
> streaming halus. Tapi **mulai dari yang sederhana**: pakai `message.part.updated`/
> `message.updated` (blok final) → `assistant_text`. Delta adalah peningkatan opsional
> (lihat §3.4, "Opsi B").

---

## 1. ⚠️ LANGKAH WAJIB PERTAMA: Rekam Schema Event Asli

**Schema field-level `--format json` TIDAK terdokumentasi resmi** dan saat plan ini
dibuat, percobaan merekam di mesin dev menghasilkan output kosong (kemungkinan model
autonomous belum terkonfigurasi penuh / butuh login provider). **Jangan tulis parser
berdasarkan tebakan.** Lakukan ini lebih dulu:

```bash
# 1. Pastikan kilo bisa jalan & model terkonfigurasi
kilo --version                    # harus jalan (terverifikasi: 7.3.46)
which kilo                         # terverifikasi: /opt/homebrew/bin/kilo

# 2. Pastikan ada model & auth (kilo pakai ~/.local/share/kilo/auth.json)
#    Jika 'kilo run' menggantung tanpa output, model/provider belum siap.
#    Konfigurasi via UI interaktif sekali: `kilo` lalu set model & login provider.

# 3. REKAM event nyata di direktori AMAN (bukan repo):
mkdir -p /tmp/kilo-probe && cd /tmp/kilo-probe
kilo run "buat file hello.txt berisi 'hi', lalu jalankan: ls -la" \
  --auto --format json --dir /tmp/kilo-probe | tee /tmp/kilo-events.jsonl

# 4. Pelajari struktur: cari nama event & field
cat /tmp/kilo-events.jsonl | python3 -m json.tool 2>/dev/null | head -100
#    atau per-baris jika JSONL:
head -20 /tmp/kilo-events.jsonl
```

**Yang harus dicatat dari rekaman:**
1. Apakah output JSONL (satu objek per baris) atau lainnya? → `runEngine` mem-parse
   per-baris `\n`. Jika Kilo mengeluarkan pretty-printed JSON multi-baris, parser
   per-baris akan gagal → butuh penyesuaian (lihat §3.6, Risiko).
2. Nama field session id: kemungkinan `sessionID` / `session.id` di event
   `session.created`/`session.updated`.
3. Bentuk teks asisten: event `message.part.updated` dengan `part.type === 'text'` dan
   `part.text` (pola OpenCode), atau `message.updated`.
4. Bentuk tool/command: `part.type === 'tool'` (dengan `state.status`, `state.input`,
   `state.output`) atau event `command.executed`.
5. Token & cost saat `session.turn.close` / `message.updated` (assistant `info.tokens`,
   `info.cost`).

> **Mapping di §3.4 ditulis berdasarkan konvensi OpenCode (induk arsitektur Kilo).**
> Sesuaikan nama field persis dengan hasil rekaman. Jika berbeda jauh, mapping tetap
> sama secara konsep — hanya nama field yang berubah.

---

## 2. Daftar File yang Disentuh

| File | Perubahan |
|------|-----------|
| `src/config.js` | resolusi `KILO_BIN`, `VALID_ENGINES` + `'kilo'`, daftar `KILO_MODELS` |
| `src/services/engineService.js` | `normalizeKiloEvent`, `KILO_ENGINE`, `sendPromptKilo`, penanganan prompt-as-arg |
| `src/websockets/agentWs.js` | import + dispatch `kilo`, izinkan model Kilo di `modelAllowed` |
| `public/index.html` | tombol engine Kilo, badge, daftar model, handler `engine_set`, popover, loadSession |
| `.env.example` | dokumentasikan `KILO_BIN` |
| `README.md` | sebutkan engine Kilo (opsional) |

**Tidak disentuh:** `sessionStore.js`, `gitService.js`, `routes/*`, `termWs.js`.

---

## 3. Backend — Detail

### 3.1 `src/config.js` — `KILO_BIN`
Setelah blok `resolveCodexBin()` / `export const CODEX_BIN`, tambahkan pola identik
(tiru `resolveCodexBin` persis, ganti 'codex' → 'kilo'):

```js
// Resolve KILO_BIN dynamically
const rawKiloBin = process.env.KILO_BIN || path.join(os.homedir(), '.local', 'bin', 'kilo');
function resolveKiloBin() {
  if (rawKiloBin && fs.existsSync(rawKiloBin)) return rawKiloBin;
  if (isWin) {
    if (process.env.APPDATA) {
      const p = path.join(process.env.APPDATA, 'npm', 'kilo.cmd');
      if (fs.existsSync(p)) return p;
    }
    return 'kilo';
  }
  const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'kilo');
  if (fs.existsSync(userLocalBin)) return userLocalBin;
  if (fs.existsSync('/usr/local/bin/kilo')) return '/usr/local/bin/kilo';
  if (fs.existsSync('/opt/homebrew/bin/kilo')) return '/opt/homebrew/bin/kilo'; // ← terverifikasi ada di sini
  return 'kilo';
}
export const KILO_BIN = resolveKiloBin();
```

### 3.2 `src/config.js` — daftar engine & model
```js
export const VALID_ENGINES = new Set(['claude', 'qwen', 'codex', 'kilo']);

// Model Kilo memakai format provider/model. Sesuaikan dgn provider yang
// terkonfigurasi di mesin target (cek `kilo run --help` / UI kilo).
export const KILO_MODELS = [
  { id: 'anthropic/claude-sonnet-4',  label: 'Claude Sonnet 4 (Kilo)' },
  { id: 'anthropic/claude-opus-4',    label: 'Claude Opus 4 (Kilo)' },
  { id: 'openai/gpt-5',               label: 'GPT-5 (Kilo)' },
];
```
> Id model di atas **placeholder** — verifikasi format & ketersediaan via rekaman/CLI
> Kilo di mesin target. Kilo mendukung "500+ model"; daftar UI cukup beberapa populer +
> izinkan input bebas (lihat §4.3).

### 3.3 `src/services/engineService.js` — import
Tambah `KILO_BIN`:
```js
import { isWin, CLAUDE_BIN, QWEN_BIN, CODEX_BIN, KILO_BIN } from '../config.js';
```

### 3.4 `normalizeKiloEvent` — parser baru
Tambahkan setelah `normalizeCodexEvent`. **Sesuaikan nama field dengan hasil rekaman §1.**
Versi di bawah memakai konvensi OpenCode (induk Kilo) sebagai titik awal:

```js
// Kilo Code (arsitektur OpenCode) memakai event bus: session.*, message.part.updated,
// session.turn.open/close, command.executed, dll. Kita map ke vocabulary internal
// yang sama agar UI tidak perlu tahu engine mana.
//
// Untuk part bertipe 'tool', state-nya berubah (pending → running → completed). Kita
// emit tool_start saat pertama terlihat dan tool_result saat completed, memakai part.id
// / callID sebagai id agar UI memasangkannya. Gunakan Set di scope run untuk dedup
// (lihat catatan di bawah).
function normalizeKiloEvent(evt) {
  const type = evt.type;

  // ── Session lifecycle ──────────────────────────────────────────────
  if (type === 'session.created' || type === 'session.updated') {
    // session_id ditangani di processLine (lihat §3.5); emit turn_start sekali.
    const sid = evt.properties?.info?.id || evt.properties?.sessionID || evt.sessionID;
    return [{ kind: 'turn_start', session_id: sid }];
  }
  if (type === 'session.turn.open') {
    return []; // turn_start sudah dari session.created/updated
  }

  // ── Streaming / message parts ──────────────────────────────────────
  if (type === 'message.part.updated' || type === 'message.part.delta') {
    const part = evt.properties?.part || evt.part || {};
    if (part.type === 'text') {
      // Opsi A (sederhana, MULAI DARI SINI): kirim blok teks penuh.
      // Kilo mengirim part.text yang makin panjang tiap update — untuk versi awal,
      // andalkan message.updated final (di bawah) dan DROP delta agar tidak dobel.
      return []; // ← lihat Opsi B untuk streaming
    }
    if (part.type === 'reasoning') {
      return part.text ? [{ kind: 'thinking', text: part.text }] : [];
    }
    if (part.type === 'tool') {
      const st = part.state || {};
      const id = part.callID || part.id;
      if (st.status === 'completed' || st.status === 'error') {
        const out = typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? '');
        return [{ kind: 'tool_result', tool_use_id: id, content: String(out),
                  is_error: st.status === 'error' }];
      }
      if (st.status === 'running' || st.status === 'pending') {
        return [{ kind: 'tool_start', id, name: part.tool || 'tool', input: st.input || {} }];
      }
      return [];
    }
    return []; // step-start, snapshot, dll → drop
  }

  // ── Pesan asisten final (blok) ─────────────────────────────────────
  if (type === 'message.updated') {
    const info = evt.properties?.info || {};
    if (info.role === 'assistant' && Array.isArray(info.parts)) {
      const out = [];
      for (const p of info.parts) {
        if (p.type === 'text' && p.text) out.push({ kind: 'assistant_text', text: p.text });
      }
      return out;
    }
    return [];
  }

  // ── Turn selesai → ringkasan token/cost ────────────────────────────
  if (type === 'session.turn.close') {
    const props = evt.properties || {};
    const tok = props.tokens || props.usage || {};
    return [{
      kind: 'turn_complete',
      cost_usd: typeof props.cost === 'number' ? props.cost : undefined,
      duration_ms: undefined,
      input_tokens: tok.input,
      output_tokens: tok.output,
      cache_read_tokens: tok.cache?.read ?? tok.cacheRead,
      cache_creation_tokens: tok.cache?.write ?? tok.cacheWrite,
      is_error: false,
    }];
  }

  // ── Error ──────────────────────────────────────────────────────────
  if (type === 'session.error' || type === 'error') {
    const msg = evt.properties?.error?.message || evt.message || 'unknown';
    return [{ kind: 'assistant_text', text: `⚠️ Kilo error: ${msg}` }];
  }

  return []; // session.status, session.diff, permission.asked, dll → drop
}
```

> **PENTING — dedup tool_start:** Kilo memancarkan `message.part.updated` berkali-kali
> untuk part tool yang sama (pending→running→completed). Mapping di atas akan meng-emit
> banyak `tool_start` (tiap update saat status running). UI mungkin menampilkan kartu
> dobel. **Mitigasi (pilih satu saat eksekusi):**
> - (a) Lacak `Set` id tool yang sudah di-`tool_start` di objek `run` (mis.
>   `run._kiloToolStarted`), emit `tool_start` hanya sekali per id. Perlu akses `run`
>   di normalizer → ubah signature `engine.normalize(evt, run)` (lihat §3.5).
> - (b) Hanya emit `tool_start` saat `status === 'pending'` dan `tool_result` saat
>   `completed`/`error`. Lebih simpel, andal jika Kilo selalu mengirim status `pending`
>   sekali. **Verifikasi dari rekaman §1.**
>
> Rekomendasi: mulai dengan (b); jika rekaman menunjukkan tidak ada status `pending`
> diskrit, pakai (a).

### 3.5 `KILO_ENGINE` + penanganan prompt-as-argument
Kilo menerima prompt sebagai **positional arg**, bukan stdin. `runEngine` saat ini selalu
menulis `proc.stdin.write(prompt)`. Dua pendekatan:

**Pendekatan disarankan (paling sedikit perubahan):** tambahkan field opsional
`promptViaArg` pada engine. Di `buildArgs`, Kilo menyisipkan prompt ke args; di
`runEngine`, jika `engine.promptViaArg` true, **jangan** tulis stdin (atau tutup stdin
kosong).

```js
const KILO_ENGINE = {
  name: 'kilo',
  bin: KILO_BIN,
  keyPrefix: '__pending_kilo_',
  logParseErrors: true,
  normalize: normalizeKiloEvent,
  promptViaArg: true,                 // ← penanda: prompt lewat argumen, bukan stdin
  // kilo run "<prompt>" --auto --format json --dir <cwd> [-m model] [-s sessionId]
  buildArgs(perm, model, sessionId, prompt) {   // ← prompt param baru (lihat di bawah)
    const args = ['run', prompt, '--format', 'json'];
    if (perm === 'bypassPermissions') args.push('--auto');
    else args.push('--dangerously-skip-permissions'); // kilo tetap butuh non-interaktif
    if (model && model !== 'default') args.push('--model', model);
    if (sessionId) args.push('--session', sessionId);
    // --dir di-set lewat opsi spawn cwd; tambahkan eksplisit bila perlu:
    // args.push('--dir', /* cwd */);  // cwd sudah diberikan via spawn { cwd } → tidak wajib
    return args;
  },
};
```

> **Perubahan signature `buildArgs`:** engine lain memakai `buildArgs(perm, model, sessionId)`.
> Kilo butuh `prompt` juga. Solusi minim-risiko: ubah pemanggilan di `runEngine` menjadi
> `engine.buildArgs(currentPerm, currentModel, currentSessionId, promptForEngine)` dan
> engine lain cukup mengabaikan arg ke-4 (JS aman: param ekstra diabaikan). **Pastikan
> `promptForEngine` sudah dihitung sebelum `buildArgs` dipanggil** — saat ini
> `promptForEngine` dihitung setelah spawn; pindahkan perhitungannya ke ATAS sebelum
> `const args = engine.buildArgs(...)`.

**Penanganan stdin di `runEngine`:** cari baris:
```js
proc.stdin.write(promptForEngine);
proc.stdin.end();
```
ganti menjadi:
```js
if (engine.promptViaArg) {
  proc.stdin.end();               // Kilo: prompt sudah di argv; tutup stdin kosong
} else {
  proc.stdin.write(promptForEngine);
  proc.stdin.end();
}
```

### 3.5b Penemuan session_id (`processLine`)
Codex menambahkan `evt.session_id || evt.thread_id`. Tambahkan sumber Kilo. Cari:
```js
const incomingSessionId = evt.session_id || evt.thread_id;
```
ganti menjadi:
```js
const incomingSessionId = evt.session_id || evt.thread_id
  || evt.properties?.info?.id || evt.properties?.sessionID || evt.sessionID;
```
> Sesuaikan path persis dengan hasil rekaman §1. Validasi format id
> (`/^[a-zA-Z0-9_.-]+$/`) sudah ada di awal `runEngine` — id Kilo (alfanumerik/UUID)
> lolos. Jika Kilo memakai karakter lain, longgarkan regex itu.

### 3.5c Jika memilih dedup tool via `run` (opsi a di §3.4)
Ubah pemanggilan normalizer di `processLine`:
```js
const normalized = engine.normalize(evt, run);
```
dan normalizer lain (`normalizeClaudeEvent`, `normalizeCodexEvent`) cukup mengabaikan
arg ke-2. Di `normalizeKiloEvent`, pakai `run._kiloToolStarted ??= new Set()` untuk dedup.

### 3.6 `sendPromptKilo`
```js
export function sendPromptKilo(ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId) {
  return runEngine(KILO_ENGINE, ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId);
}
```

> **Gambar:** Kilo punya flag `-f, --file` asli. Untuk versi pertama, ikuti pola engine
> lain (sisipkan path ke prompt teks). Peningkatan: teruskan `savedImages[].path` via
> `--file` di `buildArgs`. Catat sebagai follow-up; jangan blokir versi awal.

---

## 4. Backend — `src/websockets/agentWs.js`

### 4.1 Import
```js
import { activeRuns, sendPromptClaude, sendPromptQwen, sendPromptCodex, sendPromptKilo, broadcast } from '../services/engineService.js';
```

### 4.2 Dispatch (handler `m.type === 'prompt'`)
Tambahkan cabang `kilo` ke rantai if/else if yang sudah ada (claude/qwen/codex):
```js
} else if (currentEngine === 'kilo') {
  result = await sendPromptKilo(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, (sid) => { currentSessionId = sid; });
}
```
(struktur sudah `let result; if/else if ...; if (result?.error) ...` setelah Codex.)

### 4.3 Validasi model
Helper `modelAllowed(engine, model)` sudah ada (dibuat saat Codex). Tambah `kilo`:
```js
function modelAllowed(engine, model) {
  if (VALID_MODELS.has(model)) return true;
  if ((engine === 'qwen' || engine === 'codex' || engine === 'kilo')
      && typeof model === 'string' && model.length > 0) return true;
  return false;
}
```
> Model Kilo memakai `/` (provider/model). Regex validasi model di `engineService.js`
> (`/^[a-zA-Z0-9_.\-/:@]+$/`) sudah mengizinkan `/` (lihat commit `bef7e7a`). Aman.

---

## 5. Frontend — `public/index.html`

Pola identik dengan penambahan Codex. Cari semua tempat yang menangani `'codex'` dan
tambahkan padanan `'kilo'`.

### 5.1 Warna badge (CSS, dekat `.engine-badge.codex`)
```css
.engine-badge.kilo { border-color: #f59e0b; color: #f59e0b; } /* amber — bedakan dari hijau codex & biru qwen */
```

### 5.2 Tombol engine di popover (HTML, setelah tombol `data-engine="codex"`)
```html
<button class="popover-opt" data-engine="kilo" type="button">
  <span class="opt-dot"></span>Kilo Code
</button>
```

### 5.3 Opsi settings select (setelah `<option value="codex">`)
```html
<option value="kilo">Kilo Code</option>
```

### 5.4 Daftar model + helper (dekat `codexModelOptionsHtml`)
```js
const KILO_MODELS_UI = [
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'anthropic/claude-opus-4',   label: 'Claude Opus 4' },
  { id: 'openai/gpt-5',              label: 'GPT-5' },
];
function kiloModelOptionsHtml(selected) {
  return KILO_MODELS_UI.map(m =>
    `<option value="${m.id}"${m.id === selected ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('');
}
```
> Samakan id dengan `KILO_MODELS` di backend (§3.2) dan hasil verifikasi CLI.

### 5.5 Handler `case 'engine_set'` (setelah cabang codex)
```js
} else if (m.engine === 'kilo') {
  els.modelSelect.innerHTML = kiloModelOptionsHtml(state.model || 'anthropic/claude-sonnet-4');
  if (state.model && els.modelSelect.querySelector(`option[value="${CSS.escape(state.model)}"]`)) {
    els.modelSelect.value = state.model;
  } else {
    els.modelSelect.value = 'anthropic/claude-sonnet-4';
  }
  state.model = els.modelSelect.value;
  send({ type: 'set_model', model: state.model });
}
```

### 5.6 `buildPopoverModels()` (setelah cabang codex)
```js
} else if (state.engine === 'kilo') {
  for (const m of KILO_MODELS_UI) {
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

### 5.7 `updateEngineBadge()` — label & model
Tambah cabang label:
```js
if (engine === 'qwen') label.textContent = 'Qwen Code';
else if (engine === 'codex') label.textContent = 'Codex';
else if (engine === 'kilo') label.textContent = 'Kilo Code';
else label.textContent = 'Claude Code';
```
Tambah cabang model span:
```js
} else if (engine === 'kilo') {
  const found = KILO_MODELS_UI.find(x => x.id === model);
  modelSpan.textContent = found ? found.label : (model || '');
}
```

### 5.8 `loadSession()` & handler `hello` — pilih model options sesuai engine
Di blok kondisional yang memilih `innerHTML` model select (yang sudah punya cabang
codex), tambah:
```js
} else if (state.engine === 'kilo') {
  els.modelSelect.innerHTML = kiloModelOptionsHtml(state.model || 'anthropic/claude-sonnet-4');
}
```

---

## 6. Konfigurasi & Docs

### 6.1 `.env.example`
```
# Path ke Kilo CLI (opsional; auto-resolve bila kosong)
KILO_BIN=
```

### 6.2 `README.md` (opsional)
Tambahkan Kilo ke daftar engine yang didukung.

---

## 7. Urutan Eksekusi

1. **§1 — REKAM SCHEMA EVENT KILO DULU.** Tanpa ini, parser hanya tebakan.
2. Backend: `config.js` → `engineService.js` (normalizer + engine + stdin handling +
   session id) → `agentWs.js`.
3. Uji backend end-to-end (§8) sebelum sentuh UI.
4. Frontend `index.html`.
5. Konfig & docs.

> Rasional sama seperti plan Codex: parser = 80% risiko. Buktikan event Kilo → kontrak
> internal sebelum UI. UI hanya konsumen pasif `kind`.

---

## 8. Verifikasi (WAJIB sebelum tandai selesai)

### 8.1 Unit terhadap rekaman
Validasi `normalizeKiloEvent` terhadap `/tmp/kilo-events.jsonl` (dari §1): tiap baris →
`normalizeKiloEvent(JSON.parse(line))` → pastikan menghasilkan `kind` yang benar &
tidak ada `kind` asing.

### 8.2 Integrasi via UI
1. `npm start` (atau `./start.sh`).
2. Pilih engine **Kilo Code**, pilih model.
3. Prompt pemicu: teks + perintah shell + perubahan file
   ("buat file `demo.txt` isi 'halo', lalu `cat demo.txt`").
4. Cek tiap kind tampil benar:
   - bubble teks asisten (`message.updated`/part text → `assistant_text`),
   - kartu tool shell dgn output (part `tool` → tool_start/result, **tidak dobel**),
   - kartu perubahan file,
   - ringkasan turn dgn token (`session.turn.close` → turn_complete).
5. **Resume:** prompt lanjutan di session sama → pastikan `--session <id>` dipakai &
   konteks nyambung.
6. **Persistence:** reload → buka session Kilo dari sidebar → replay benar, badge
   "Kilo Code", engine ter-restore (`meta.engine === 'kilo'`).
7. **Abort:** mulai turn panjang → Stop → proses kilo mati
   (`ps aux | grep kilo` bersih). Catatan: Kilo men-spawn server lokal + plugin —
   pastikan `process.kill(-pid)` (detached group, sudah dipakai di abort) membunuh
   seluruh tree. **Verifikasi tidak ada proses kilo nyangkut.**

### 8.3 Regresi
Jalankan satu turn **Claude**, **Qwen**, **Codex** → pastikan perubahan signature
`buildArgs` (param `prompt` ke-4) dan stdin handling tidak merusak ketiganya.

---

## 9. Risiko & Catatan

| Risiko | Mitigasi |
|--------|----------|
| **Schema JSON Kilo tak terdokumentasi** | §1 wajib: rekam event nyata sebelum tulis parser |
| **Output bukan JSONL** (pretty-print multi-baris) | Cek di §1. Jika ya, parser per-baris `\n` di `runEngine` gagal → kumpulkan buffer & parse per objek (perlu penyesuaian khusus) |
| **Prompt via arg, bukan stdin** | `promptViaArg` + hitung `promptForEngine` sebelum `buildArgs` (§3.5) |
| **`buildArgs` butuh param prompt ke-4** | Engine lain abaikan arg ekstra (JS aman); uji regresi §8.3 |
| **tool_start dobel** (part update berulang) | Dedup via opsi (a) Set di `run`, atau (b) emit hanya pada status `pending` (§3.4) |
| **Kilo spawn server+plugin (proses anak banyak)** | Abort pakai `process.kill(-pid)` (group); verifikasi tree mati (§8.2 #7) |
| **Startup Kilo lambat** (load DB, plugin, indexing — terlihat di log) | Turn pertama bisa lambat; jangan set timeout agresif. Pertimbangkan indikator "menyiapkan engine" |
| **Model autonomous belum terkonfigurasi** | Turn hang tanpa output → konfigurasi model/login provider Kilo dulu (§1) |
| **Cost mungkin tak tersedia** | `turn_complete.cost_usd = undefined` bila absen (sama seperti Codex) |
| **Gambar** | Versi pertama: path di prompt; follow-up: pakai `--file` (§3.6) |

---

## 10. Definition of Done

- [ ] `/tmp/kilo-events.jsonl` direkam & `normalizeKiloEvent` dibangun dari schema NYATA.
- [ ] Pilih engine "Kilo Code" → kirim prompt → teks, kartu tool shell, perubahan file,
      ringkasan token tampil rapi & **tanpa kartu tool dobel**.
- [ ] Resume session Kilo jalan (`--session`, konteks nyambung).
- [ ] Reload + buka session Kilo → replay benar, badge & engine ter-restore.
- [ ] Abort membunuh seluruh proses-tree Kilo tanpa sisa.
- [ ] Turn Claude, Qwen, Codex tetap normal (regresi `buildArgs`/stdin bersih).
- [ ] `normalizeKiloEvent` hanya output `kind` dari kontrak §0.3; tidak ada `kind` baru.
- [ ] Tidak ada perubahan logika render UI.

---

### Lampiran: Referensi
- Kilo CLI reference: https://kilo.ai/docs/code-with-ai/platforms/cli-reference
- Kilo CLI overview: https://kilo.ai/docs/cli
- Kilo SDK & event bus (DeepWiki): https://deepwiki.com/Kilo-Org/kilocode/13-sdk-and-api
- Session lifecycle: https://deepwiki.com/Kilo-Org/kilocode/5.1-session-lifecycle
- Arsitektur induk (OpenCode SDK): https://opencode.ai/docs/sdk/
- **Sumber kebenaran schema:** `packages/sdk/openapi.json` di repo kilocode, ATAU rekaman
  `kilo run --format json` di mesin target (§1).
- Template implementasi: `normalizeCodexEvent` & `CODEX_ENGINE` di
  `src/services/engineService.js` (commit `414a22e`).
