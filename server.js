import http from 'http';
import app from './src/app.js';
import { wss } from './src/websockets/agentWs.js';
import { termWss } from './src/websockets/termWs.js';
import { isAuthenticated } from './src/services/authService.js';
import { 
  PORT, HOST, DEFAULT_CWD, STATE_DIR, USERNAME, PASSWORD, 
  CLAUDE_BIN, REMOTE_NODES, ALL_NODES 
} from './src/config.js';

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url ? req.url.split('?')[0] : '';
  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else if (pathname === '/term') {
    termWss.handleUpgrade(req, socket, head, ws => termWss.emit('connection', ws, req));
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, HOST, () => {
  console.log(`Self Agent Orchestrator listening on http://${HOST}:${PORT}`);
  console.log(`  claude:    ${CLAUDE_BIN}`);
  console.log(`  cwd:       ${DEFAULT_CWD}`);
  console.log(`  state:     ${STATE_DIR}`);
  console.log(`  username:  ${USERNAME}`);
  console.log(`  password:  ${PASSWORD === 'changeme' ? '(default — change in .env!)' : '(set)'}`);
  if (REMOTE_NODES.length > 0) {
    console.log(`  nodes:     ${ALL_NODES.map(n => n.name).join(', ')}`);
  }
});
