import { spawn } from 'child_process';
import { isWin, CLAUDE_BIN, QWEN_BIN } from '../config.js';
import { appendSessionEvent, loadIndex, upsertSessionMeta, loadIndexEnriched } from './sessionStore.js';

export const activeRuns = new Map();

// Verbose per-event broadcast logging is noisy on the streaming hot path; gate
// it behind DEBUG=1. Anomalies (no run / send failure) always log.
const DEBUG = process.env.DEBUG === '1';

export function broadcast(key, msg) {
  const run = activeRuns.get(key);
  if (!run) {
    console.warn(`[broadcast] No active run found for key: ${key} (dropped event kind: ${msg.kind})`);
    return;
  }
  const data = JSON.stringify(msg);
  if (DEBUG) {
    if (run.subscribers.size === 0) console.warn(`[broadcast] Run ${key} has no subscribers. Buffering event kind: ${msg.kind}`);
    else console.log(`[broadcast] Sending event to run ${key}: kind=${msg.kind}, subscribers=${run.subscribers.size}`);
  }
  for (const ws of run.subscribers) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch (err) { console.error(`[broadcast] Failed:`, err.message); }
    } else if (DEBUG) {
      console.warn(`[broadcast] Subscriber WebSocket not open for run ${key}`);
    }
  }
}

// GC: remove completed runs >5 min after completion
setInterval(() => {
  const now = Date.now();
  for (const [k, run] of activeRuns) {
    if (run.status === 'done' && run.completedAt && (now - run.completedAt) > 5 * 60 * 1000) {
      activeRuns.delete(k);
    }
  }
}, 60_000).unref();

function normalizeEvent(evt) {
  if (evt.type === 'system' && evt.subtype === 'init') {
    return [{ kind: 'turn_start', session_id: evt.session_id, cwd: evt.cwd, model: evt.model }];
  }
  if (evt.type === 'assistant' && evt.message?.content) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type === 'text') out.push({ kind: 'assistant_text', text: block.text });
      else if (block.type === 'tool_use') out.push({ kind: 'tool_start', id: block.id, name: block.name, input: block.input });
      else if (block.type === 'thinking') out.push({ kind: 'thinking', text: block.thinking || '' });
    }
    return out;
  }
  if (evt.type === 'user' && evt.message?.content) {
    const out = [];
    for (const block of evt.message.content) {
      if (block.type === 'tool_result') {
        let content = block.content;
        if (Array.isArray(content)) content = content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
        out.push({ kind: 'tool_result', tool_use_id: block.tool_use_id, content: String(content || ''), is_error: !!block.is_error });
      }
    }
    return out;
  }
  if (evt.type === 'result') {
    const u = evt.usage || {};
    return [{
      kind: 'turn_complete', cost_usd: evt.total_cost_usd, duration_ms: evt.duration_ms, num_turns: evt.num_turns,
      input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: u.cache_read_input_tokens,
      cache_creation_tokens: u.cache_creation_input_tokens, is_error: !!evt.is_error, session_id: evt.session_id,
    }];
  }
  return [];
}

// ─── Engine definitions ───────────────────────────────────────────────────
// Claude and Qwen share the same run lifecycle (spawn → stream stdout JSONL →
// persist + broadcast). They differ only in the binary, the CLI args, the
// pending-key prefix, and whether JSON parse failures are logged.
const CLAUDE_ENGINE = {
  name: 'claude',
  bin: CLAUDE_BIN,
  keyPrefix: '__pending_',
  logParseErrors: true,
  buildArgs(perm, model, sessionId) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', perm];
    if (perm === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
    args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
};

const QWEN_ENGINE = {
  name: 'qwen',
  bin: QWEN_BIN,
  keyPrefix: '__pending_qwen_',
  logParseErrors: false,
  buildArgs(perm, model, sessionId) {
    const args = ['-p', '--output-format', 'stream-json'];
    let approvalMode = 'default';
    if (perm === 'plan') approvalMode = 'plan';
    else if (perm === 'acceptEdits') approvalMode = 'auto-edit';
    else if (perm === 'bypassPermissions') approvalMode = 'yolo';
    args.push('--approval-mode', approvalMode);
    if (model && model !== 'default') args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    return args;
  },
};

async function runEngine(engine, ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, onSessionId) {
  if (currentSessionId && !/^[a-zA-Z0-9_.-]+$/.test(currentSessionId)) {
    return { error: 'Invalid session ID format' };
  }
  if (currentModel && currentModel !== 'default' && !/^[a-zA-Z0-9_.\-/:@]+$/.test(currentModel)) {
    return { error: 'Invalid model format' };
  }

  const args = engine.buildArgs(currentPerm, currentModel, currentSessionId);

  let proc;
  try {
    proc = spawn(engine.bin, args, { cwd: currentCwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWin, shell: isWin });
  } catch (err) { return { error: `Failed to spawn ${engine.name}: ${err.message}` }; }

  const tempKey = tempSessionId || (engine.keyPrefix + Math.random().toString(36).slice(2, 10));
  const initialKey = currentSessionId || tempKey;

  const userEvent = { kind: 'user_message', text, timestamp: Date.now(), ...(savedImages.length > 0 ? { images: savedImages.map(s => ({ filename: s.filename, name: s.name, mime: s.mime, thumbData: s.thumbData })) } : {}) };

  let promptForEngine = text;
  if (savedImages.length > 0) {
    const paths = savedImages.map(s => `- ${s.path}`).join('\n');
    promptForEngine = text.trim() ? `${text}\n\n---\nGambar terlampir (gunakan Read tool untuk melihatnya):\n${paths}` : `Tolong lihat gambar berikut menggunakan Read tool dan jelaskan:\n${paths}`;
  }

  const run = { proc, status: 'running', cwd: currentCwd, perm: currentPerm, model: currentModel, promptText: text, sessionId: currentSessionId, isNew, bufferedEvents: [userEvent], subscribers: new Set([ws]), completedAt: null };
  activeRuns.set(initialKey, run);

  if (currentSessionId) { appendSessionEvent(currentSessionId, userEvent); run.bufferedEvents = []; }
  broadcast(initialKey, userEvent);

  proc.stdin.write(promptForEngine);
  proc.stdin.end();

  let stderrBuf = '', buffer = '';
  const processLine = (line) => {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch (err) { if (engine.logParseErrors) console.error('[stdout] JSON parse fail:', err.message); return; }

    if (evt.session_id && !run.sessionId) {
      run.sessionId = evt.session_id;
      if (onSessionId) onSessionId(evt.session_id);
      activeRuns.delete(initialKey);
      activeRuns.set(run.sessionId, run);
      for (const e of run.bufferedEvents) appendSessionEvent(run.sessionId, e);
      run.bufferedEvents = [];
      const title = run.isNew ? run.promptText.split('\n')[0].slice(0, 60) : undefined;
      upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: engine.name, model: run.model, ...(title ? { title } : {}) });
      broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() });
    }

    const normalized = normalizeEvent(evt);
    const key = run.sessionId || initialKey;
    for (const n of normalized) {
      if (n.kind === 'turn_complete' && typeof n.cost_usd === 'number' && run.sessionId) {
        const prev = (loadIndex().find(s => s.id === run.sessionId)?.totalCostUsd) || 0;
        upsertSessionMeta(run.sessionId, { totalCostUsd: prev + n.cost_usd });
      }
      if (run.sessionId) appendSessionEvent(run.sessionId, n);
      else run.bufferedEvents.push(n);
      broadcast(key, n);
    }
  };

  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) { processLine(buffer.slice(0, idx)); buffer = buffer.slice(idx + 1); }
  });
  proc.stdout.on('end', () => { if (buffer.trim()) { processLine(buffer); buffer = ''; } });
  proc.stderr.on('data', d => { stderrBuf += d.toString(); });
  proc.on('error', err => { broadcast(run.sessionId || initialKey, { kind: 'error', message: `${engine.name} process error: ${err.message}` }); });
  proc.on('exit', (code) => {
    run.status = 'done'; run.completedAt = Date.now();
    const key = run.sessionId || initialKey;
    if (code !== 0 && code !== null) broadcast(key, { kind: 'error', message: `${engine.name} exited with code ${code}${stderrBuf ? ': ' + stderrBuf.slice(0, 500) : ''}` });
    if (run.sessionId) { upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: engine.name, model: run.model }); broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() }); }
    broadcast(key, { kind: 'turn_end' });
  });

  return { key: initialKey, sessionId: currentSessionId };
}

export function sendPromptClaude(ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId) {
  return runEngine(CLAUDE_ENGINE, ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId);
}

export function sendPromptQwen(ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId) {
  return runEngine(QWEN_ENGINE, ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId);
}
