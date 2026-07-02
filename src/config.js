import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Load .env file manually if it exists (Antigravity demo modification)
try {
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        const key = trimmed.substring(0, index).trim();
        let val = trimmed.substring(index + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // Real environment variables take precedence over the .env file
        if (process.env[key] === undefined) process.env[key] = val;
      }
    });
  }
} catch (err) {
  console.warn('Failed to load .env file:', err.message);
}

export const PORT = parseInt(process.env.PORT || '7000', 10);
export const HOST = process.env.HOST || '0.0.0.0';
export const USERNAME = process.env.WEB_USERNAME || 'admin';
export const PASSWORD = process.env.WEB_PASSWORD || 'changeme';
export const isWin = process.platform === 'win32';

// Resolve CLAUDE_BIN dynamically
const rawClaudeBin = process.env.CLAUDE_BIN || '/Users/andi/.local/bin/claude';
function resolveClaudeBin() {
  if (rawClaudeBin && fs.existsSync(rawClaudeBin)) {
    return rawClaudeBin;
  }
  if (isWin) {
    if (process.env.APPDATA) {
      const globalNpmPath = path.join(process.env.APPDATA, 'npm', 'claude.cmd');
      if (fs.existsSync(globalNpmPath)) {
        return globalNpmPath;
      }
    }
    return 'claude';
  } else {
    const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'claude');
    if (fs.existsSync(userLocalBin)) {
      return userLocalBin;
    }
    if (fs.existsSync('/usr/local/bin/claude')) {
      return '/usr/local/bin/claude';
    }
    return 'claude';
  }
}
export const CLAUDE_BIN = resolveClaudeBin();

// Resolve QWEN_BIN dynamically
const rawQwenBin = process.env.QWEN_BIN || '/Users/andi/.local/bin/qwen';
function resolveQwenBin() {
  if (rawQwenBin && fs.existsSync(rawQwenBin)) {
    return rawQwenBin;
  }
  if (isWin) {
    if (process.env.APPDATA) {
      const globalNpmPath = path.join(process.env.APPDATA, 'npm', 'qwen.cmd');
      if (fs.existsSync(globalNpmPath)) {
        return globalNpmPath;
      }
    }
    return 'qwen';
  } else {
    const userLocalBin = path.join(os.homedir(), '.local', 'bin', 'qwen');
    if (fs.existsSync(userLocalBin)) {
      return userLocalBin;
    }
    if (fs.existsSync('/usr/local/bin/qwen')) {
      return '/usr/local/bin/qwen';
    }
    if (fs.existsSync('/opt/homebrew/bin/qwen')) {
      return '/opt/homebrew/bin/qwen';
    }
    return 'qwen';
  }
}
export const QWEN_BIN = resolveQwenBin();

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
  if (fs.existsSync('/opt/homebrew/bin/kilo')) return '/opt/homebrew/bin/kilo';
  return 'kilo';
}
export const KILO_BIN = resolveKiloBin();

export const DEFAULT_CWD = process.env.AGENT_CWD || os.homedir();
export const DEFAULT_PERM = process.env.PERMISSION_MODE || 'bypassPermissions';
export const VALID_PERMS = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']);
export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

export const CLAUDE_MODELS = [
  { id: 'opus',   label: 'Claude Opus 4.8' },
  { id: 'sonnet', label: 'Claude Sonnet 4.6' },
  { id: 'haiku',  label: 'Claude Haiku 4.5' },
];

// Load custom models from ~/.claude/settings.json env entries
(function loadCustomModels() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const env = settings.env || {};
    for (const [key, value] of Object.entries(env)) {
      if (/^CUSTOM_MODEL\d*$/i.test(key) && typeof value === 'string' && value.trim()) {
        const modelId = value.trim();
        if (!CLAUDE_MODELS.some(m => m.id === modelId)) {
          const shortLabel = modelId.includes('/') ? modelId.split('/').pop() : modelId;
          CLAUDE_MODELS.push({ id: modelId, label: shortLabel, custom: true });
        }
      }
    }
  } catch (_) { /* settings.json missing or malformed — ignore */ }
})();

export const VALID_MODELS = new Set(CLAUDE_MODELS.map(m => m.id));
export const DEFAULT_ENGINE = process.env.ENGINE || 'claude';
export const VALID_ENGINES = new Set(['claude', 'qwen', 'codex', 'kilo']);

export const CODEX_MODELS = [
  { id: 'gpt-5-codex',  label: 'GPT-5 Codex' },
  { id: 'gpt-5',        label: 'GPT-5' },
  { id: 'o4-mini',      label: 'o4-mini' },
];

export const KILO_MODELS = [
  { id: 'kilo/kilo-auto/free',                         label: 'Kilo Auto (Free)' },
  { id: 'kilo/poolside/laguna-m.1:free',               label: 'Laguna M.1 (Free)' },
  { id: 'kilo/stepfun/step-3.7-flash:free',            label: 'Step 3.7 Flash (Free)' },
  { id: 'kilo/nvidia/nemotron-3.5-content-safety:free',label: 'Nemotron 3.5 Safety (Free)' },
  { id: 'kilo/cohere/north-mini-code:free',            label: 'North Mini Code (Free)' },
  { id: 'kilo/nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra (Free)' },
];

export const NODE_NAME = process.env.NODE_NAME || os.hostname();
export const REMOTE_NODES = (() => {
  try {
    const raw = process.env.NODES;
    if (!raw) return [];
    const seen = new Set(['local']);
    const out = [];
    JSON.parse(raw).forEach((n, i) => {
      let id = n.id || `node-${i + 1}`;
      if (seen.has(id)) {
        const original = id;
        let suffix = 2;
        while (seen.has(id)) { id = `${original}-${suffix++}`; }
        console.warn(`[nodes] id "${original}" collides; renamed to "${id}"`);
      }
      seen.add(id);
      if (!n.url) {
        console.warn(`[nodes] node ${id} missing url — skipped`);
        return;
      }
      out.push({
        id,
        name: n.name || `Node ${i + 1}`,
        url: String(n.url),
        username: String(n.username || USERNAME),
        password: String(n.password || PASSWORD),
      });
    });
    return out;
  } catch (e) {
    console.error('[nodes] Failed to parse NODES env:', e.message);
    return [];
  }
})();
export const ALL_NODES = [{ id: 'local', name: NODE_NAME }, ...REMOTE_NODES];

export const STATE_DIR = process.env.STATE_DIR || path.join(os.homedir(), '.self-agent-orchestrator');
export const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
export const SESSIONS_INDEX = path.join(STATE_DIR, 'sessions.json');
export const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
