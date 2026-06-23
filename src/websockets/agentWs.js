import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import { 
  DEFAULT_CWD, DEFAULT_PERM, DEFAULT_MODEL, DEFAULT_ENGINE, 
  CLAUDE_MODELS, ALL_NODES, NODE_NAME, VALID_PERMS, VALID_MODELS, 
  VALID_ENGINES, REMOTE_NODES 
} from '../config.js';
import { loadIndexEnriched, loadSessionEvents, loadIndex, upsertSessionMeta } from '../services/sessionStore.js';
import { saveUploadedImage, MAX_IMAGES_PER_TURN } from '../utils/helpers.js';
import { activeRuns, sendPromptClaude, sendPromptQwen, broadcast } from '../services/engineService.js';

export const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  let currentSessionId = null;
  let currentCwd = DEFAULT_CWD;
  let currentPerm = DEFAULT_PERM;
  let currentModel = DEFAULT_MODEL;
  let currentEngine = DEFAULT_ENGINE;
  let attachedKey = null;

  // Multi-node proxy state
  let proxyWs = null;
  let currentNodeId = 'local';

  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  function buildHello() {
    return {
      kind: 'hello',
      defaultCwd: DEFAULT_CWD,
      defaultPerm: DEFAULT_PERM,
      defaultModel: DEFAULT_MODEL,
      defaultEngine: DEFAULT_ENGINE,
      claudeModels: CLAUDE_MODELS,
      sessions: loadIndexEnriched(),
      nodes: ALL_NODES.map(({ id, name }) => ({ id, name })),
      nodeId: 'local',
      nodeName: NODE_NAME,
    };
  }

  function closeProxy() {
    if (proxyWs) {
      proxyWs.removeAllListeners();
      proxyWs.close();
      proxyWs = null;
    }
  }

  function connectToNode(nodeId) {
    const nodeConfig = REMOTE_NODES.find(n => n.id === nodeId);
    if (!nodeConfig) { send({ kind: 'error', message: `Unknown node: ${nodeId}` }); return; }

    closeProxy();
    send({ kind: 'node_connecting', nodeId, name: nodeConfig.name });

    const wsUrl = nodeConfig.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    const auth = Buffer.from(`${nodeConfig.username}:${nodeConfig.password}`).toString('base64');

    let pws;
    try {
      pws = new WebSocket(wsUrl, { headers: { Authorization: `Basic ${auth}` } });
    } catch (err) {
      send({ kind: 'error', message: `Cannot connect to ${nodeConfig.name}: ${err.message}` });
      return;
    }

    pws.on('open', () => {
      proxyWs = pws;
      currentNodeId = nodeId;
      send({ kind: 'node_set', nodeId, name: nodeConfig.name });
    });

    pws.on('message', (data) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.kind === 'hello') {
          parsed.nodes = ALL_NODES.map(({ id, name }) => ({ id, name }));
          parsed.nodeId = nodeId;
          parsed.nodeName = nodeConfig.name;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {}
      ws.send(data.toString());
    });

    pws.on('close', () => {
      if (proxyWs !== pws) return;
      proxyWs = null;
      currentNodeId = 'local';
      send({ kind: 'error', message: `Disconnected from ${nodeConfig.name}` });
      send({ kind: 'node_set', nodeId: 'local', name: NODE_NAME });
      send(buildHello());
    });

    pws.on('error', (err) => {
      if (proxyWs === pws) { proxyWs = null; currentNodeId = 'local'; }
      send({ kind: 'error', message: `${nodeConfig.name}: ${err.message}` });
    });
  }

  function attach(key) {
    if (attachedKey === key) return activeRuns.get(key);
    if (attachedKey) {
      const prev = activeRuns.get(attachedKey);
      if (prev) prev.subscribers.delete(ws);
    }
    attachedKey = key;
    const run = key ? activeRuns.get(key) : null;
    if (run) run.subscribers.add(ws);
    return run;
  }

  send(buildHello());

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === 'set_node') {
      if (!m.nodeId || m.nodeId === 'local') {
        closeProxy();
        currentNodeId = 'local';
        send({ kind: 'node_set', nodeId: 'local', name: NODE_NAME });
        send(buildHello());
      } else {
        connectToNode(m.nodeId);
      }
      return;
    }

    if (currentNodeId !== 'local' && proxyWs) {
      if (proxyWs.readyState === WebSocket.OPEN) {
        proxyWs.send(raw.toString());
      } else {
        send({ kind: 'error', message: 'Not connected to remote node' });
      }
      return;
    }

    if (m.type === 'load_session') {
      currentSessionId = m.sessionId || null;
      let events = [];
      let active = false;

      if (currentSessionId && currentSessionId.startsWith('temp_')) {
        const run = activeRuns.get(currentSessionId);
        if (run) {
          active = run.status === 'running';
          events = run.bufferedEvents || [];
          attach(currentSessionId);
          currentCwd = run.cwd || DEFAULT_CWD;
          currentPerm = run.perm || DEFAULT_PERM;
          currentModel = run.model || DEFAULT_MODEL;
        }
      } else {
        const meta = loadIndex().find(s => s.id === currentSessionId);
        if (meta) {
          currentCwd = meta.cwd || DEFAULT_CWD;
          currentPerm = meta.permissionMode || DEFAULT_PERM;
          currentModel = meta.model || DEFAULT_MODEL;
          if (meta.engine && VALID_ENGINES.has(meta.engine)) {
            currentEngine = meta.engine;
          } else if (currentSessionId) {
            currentEngine = 'claude';
          }
        }
        events = currentSessionId ? loadSessionEvents(currentSessionId) : [];
        const run = currentSessionId ? attach(currentSessionId) : null;
        active = !!run && run.status === 'running';
      }

      send({ kind: 'session_loaded', sessionId: currentSessionId, cwd: currentCwd, permissionMode: currentPerm, model: currentModel, engine: currentEngine, events, active });
      return;
    }

    if (m.type === 'new_session') {
      currentSessionId = null;
      attach(null);
      currentCwd = m.cwd || DEFAULT_CWD;
      if (m.permissionMode && VALID_PERMS.has(m.permissionMode)) currentPerm = m.permissionMode;
      const modelOk = VALID_MODELS.has(m.model) || (currentEngine === 'qwen' && typeof m.model === 'string' && m.model.length > 0);
      if (modelOk) currentModel = m.model;
      send({ kind: 'session_loaded', sessionId: null, cwd: currentCwd, permissionMode: currentPerm, model: currentModel, engine: currentEngine, events: [], active: false });
      return;
    }

    if (m.type === 'set_engine') {
      if (VALID_ENGINES.has(m.engine)) {
        currentEngine = m.engine;
        send({ kind: 'engine_set', engine: currentEngine });
      }
      return;
    }

    if (m.type === 'set_model') {
      const modelOk = VALID_MODELS.has(m.model) || (currentEngine === 'qwen' && typeof m.model === 'string' && m.model.length > 0);
      if (modelOk) {
        currentModel = m.model;
        if (currentSessionId) upsertSessionMeta(currentSessionId, { model: currentModel });
        send({ kind: 'model_set', model: currentModel });
      }
      return;
    }

    if (m.type === 'set_cwd') {
      currentCwd = m.cwd || DEFAULT_CWD;
      if (currentSessionId) {
        currentSessionId = null;
        send({ kind: 'session_cleared', message: 'Direktori berubah — session sebelumnya dilepas. Chat baru akan dibuat di direktori baru.' });
      }
      send({ kind: 'cwd_set', cwd: currentCwd });
      return;
    }

    if (m.type === 'set_permission') {
      if (VALID_PERMS.has(m.permissionMode)) {
        currentPerm = m.permissionMode;
        if (currentSessionId) upsertSessionMeta(currentSessionId, { permissionMode: currentPerm });
        send({ kind: 'permission_set', permissionMode: currentPerm });
      }
      return;
    }

    if (m.type === 'abort') {
      const key = currentSessionId || attachedKey;
      const run = key ? activeRuns.get(key) : null;
      const proc = run?.proc;
      if (proc && run.status === 'running') {
        console.log(`[abort] killing pid=${proc.pid} (session ${key})`);
        broadcast(key, { kind: 'aborting' });
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
        setTimeout(() => {
          if (proc.exitCode === null && !proc.signalCode) {
            console.log(`[abort] escalating to SIGKILL for pid=${proc.pid}`);
            try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
          }
        }, 2000);
      }
      return;
    }

    if (m.type === 'prompt') {
      const existing = currentSessionId ? activeRuns.get(currentSessionId) : null;
      if (existing && existing.status === 'running') {
        send({ kind: 'error', message: 'A turn is already running for this session' });
        return;
      }

      if (currentSessionId) {
        const meta = loadIndex().find(s => s.id === currentSessionId);
        if (meta && meta.cwd !== currentCwd) {
          currentSessionId = null;
          send({ kind: 'session_cleared', message: 'Session sebelumnya dibuat di direktori berbeda. Membuat chat baru.' });
        }
      }

      const text = String(m.text || '');
      const tempSessionId = m.tempSessionId ? String(m.tempSessionId) : null;
      const incomingImages = Array.isArray(m.images) ? m.images.slice(0, MAX_IMAGES_PER_TURN) : [];
      if (!text.trim() && incomingImages.length === 0) return;

      if (!fs.existsSync(currentCwd)) {
        send({ kind: 'error', message: `cwd does not exist: ${currentCwd}` });
        return;
      }

      const savedImages = [];
      for (const img of incomingImages) {
        const saved = saveUploadedImage(img);
        if (saved) savedImages.push(saved);
      }
      if (incomingImages.length > 0 && savedImages.length === 0) {
        send({ kind: 'error', message: 'No valid images attached (check format / size — max 10MB each, PNG/JPG/WebP/GIF).' });
        return;
      }

      const isNew = !currentSessionId;

      if (currentEngine === 'qwen') {
        const result = await sendPromptQwen(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, (sid) => { currentSessionId = sid; });
        if (result?.error) { send({ kind: 'error', message: result.error }); return; }
        if (result?.key) attachedKey = result.key;
        if (result?.sessionId) currentSessionId = result.sessionId;
      } else {
        const result = await sendPromptClaude(ws, text, savedImages, currentCwd, currentPerm, currentModel, currentSessionId, isNew, tempSessionId, (sid) => { currentSessionId = sid; });
        if (result?.error) { send({ kind: 'error', message: result.error }); return; }
        if (result?.key) attachedKey = result.key;
        if (result?.sessionId) currentSessionId = result.sessionId;
      }
      return;
    }
  });

  ws.on('close', () => {
    closeProxy();
    if (attachedKey) {
      const run = activeRuns.get(attachedKey);
      if (run) run.subscribers.delete(ws);
    }
  });
});
