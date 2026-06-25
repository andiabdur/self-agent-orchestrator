import { spawn } from 'child_process';
import { isWin, CLAUDE_BIN, QWEN_BIN, CODEX_BIN, KILO_BIN } from '../config.js';
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

function normalizeClaudeEvent(evt) {
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

function normalizeKiloEvent(evt, run) {
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
      return []; // andalkan message.updated final (di bawah) dan DROP delta
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
        run._kiloToolStarted = run._kiloToolStarted || new Set();
        if (!run._kiloToolStarted.has(id)) {
          run._kiloToolStarted.add(id);
          return [{ kind: 'tool_start', id, name: part.tool || 'tool', input: st.input || {} }];
        }
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
    let msg = evt.error?.data?.message || evt.properties?.error?.message || evt.message || evt.error;
    if (typeof msg === 'object' && msg !== null) msg = JSON.stringify(msg);
    if (!msg) msg = JSON.stringify(evt);
    return [{ kind: 'assistant_text', text: `⚠️ Kilo error: ${msg}` }];
  }

  return []; // session.status, session.diff, permission.asked, dll → drop
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
  normalize: normalizeClaudeEvent,
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
  normalize: normalizeClaudeEvent,
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

const KILO_ENGINE = {
  name: 'kilo',
  bin: KILO_BIN,
  keyPrefix: '__pending_kilo_',
  logParseErrors: true,
  normalize: normalizeKiloEvent,
  promptViaArg: true,
  buildArgs(perm, model, sessionId, prompt) {
    const args = ['run', prompt, '--format', 'json'];
    if (perm === 'bypassPermissions') args.push('--auto');
    else args.push('--dangerously-skip-permissions');
    if (model && model !== 'default') args.push('--model', model);
    if (sessionId) args.push('--session', sessionId);
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

  let promptForEngine = text;
  if (savedImages.length > 0) {
    const paths = savedImages.map(s => `- ${s.path}`).join('\n');
    promptForEngine = text.trim() ? `${text}\n\n---\nGambar terlampir (gunakan Read tool untuk melihatnya):\n${paths}` : `Tolong lihat gambar berikut menggunakan Read tool dan jelaskan:\n${paths}`;
  }

  const args = engine.buildArgs(currentPerm, currentModel, currentSessionId, promptForEngine);

  let proc;
  try {
    proc = spawn(engine.bin, args, { cwd: currentCwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWin, shell: isWin });
  } catch (err) { return { error: `Failed to spawn ${engine.name}: ${err.message}` }; }

  const tempKey = tempSessionId || (engine.keyPrefix + Math.random().toString(36).slice(2, 10));
  const initialKey = currentSessionId || tempKey;

  const userEvent = { kind: 'user_message', text, timestamp: Date.now(), ...(savedImages.length > 0 ? { images: savedImages.map(s => ({ filename: s.filename, name: s.name, mime: s.mime, thumbData: s.thumbData })) } : {}) };

  const run = { proc, status: 'running', cwd: currentCwd, perm: currentPerm, model: currentModel, promptText: text, sessionId: currentSessionId, isNew, bufferedEvents: [userEvent], subscribers: new Set([ws]), completedAt: null };
  activeRuns.set(initialKey, run);

  if (currentSessionId) { appendSessionEvent(currentSessionId, userEvent); run.bufferedEvents = []; }
  broadcast(initialKey, userEvent);

  if (engine.promptViaArg) {
    proc.stdin.end();
  } else {
    proc.stdin.write(promptForEngine);
    proc.stdin.end();
  }

  let stderrBuf = '', buffer = '';
  const processLine = (line) => {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch (err) { if (engine.logParseErrors) console.error('[stdout] JSON parse fail:', err.message); return; }

    const incomingSessionId = evt.session_id || evt.thread_id || evt.properties?.info?.id || evt.properties?.sessionID || evt.sessionID;
    if (incomingSessionId && !run.sessionId) {
      run.sessionId = incomingSessionId;
      if (onSessionId) onSessionId(incomingSessionId);
      activeRuns.delete(initialKey);
      activeRuns.set(run.sessionId, run);
      for (const e of run.bufferedEvents) appendSessionEvent(run.sessionId, e);
      run.bufferedEvents = [];
      const title = run.isNew ? run.promptText.split('\n')[0].slice(0, 60) : undefined;
      upsertSessionMeta(run.sessionId, { cwd: run.cwd, permissionMode: run.perm, engine: engine.name, model: run.model, ...(title ? { title } : {}) });
      broadcast(run.sessionId, { kind: 'session_persisted', sessionId: run.sessionId, sessions: loadIndexEnriched() });
    }

    const normalized = engine.normalize(evt, run);
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

export function sendPromptCodex(ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId) {
  return runEngine(CODEX_ENGINE, ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId);
}

export function sendPromptKilo(ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId) {
  return runEngine(KILO_ENGINE, ws, text, savedImages, cwd, perm, model, sessionId, isNew, tempSessionId, onSessionId);
}
