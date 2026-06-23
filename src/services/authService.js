import { USERNAME, PASSWORD } from '../config.js';

export const activeSessions = new Set();

export function getSessionToken(req) {
  const cookieHeader = req.headers?.cookie || '';
  const match = cookieHeader.match(/session_token=([^;]+)/);
  if (match) return match[1];
  return null;
}

export function isAuthenticated(req) {
  const token = getSessionToken(req);
  if (token && activeSessions.has(token)) return true;
  // Basic auth fallback for server-to-server connections
  const authHeader = req.headers?.['authorization'] || req.headers?.['Authorization'];
  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0 && decoded.slice(0, idx) === USERNAME && decoded.slice(idx + 1) === PASSWORD) return true;
    } catch {}
  }
  return false;
}
