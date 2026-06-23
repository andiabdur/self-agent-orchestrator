import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { isAuthenticated } from './services/authService.js';
import authRoutes from './routes/authRoutes.js';
import sessionRoutes from './routes/sessionRoutes.js';
import fsRoutes from './routes/fsRoutes.js';
import gitRoutes from './routes/gitRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const app = express();
app.use(express.json());

// Public paths that do not require authentication
const publicPaths = new Set([
  '/login.html',
  '/api/login',
  '/api/auth/check',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/sw.js'
]);

// Authentication middleware
app.use((req, res, next) => {
  if (publicPaths.has(req.path)) {
    return next();
  }

  if (isAuthenticated(req)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  res.redirect('/login.html');
});

// API Routes
app.use(authRoutes);
app.use(sessionRoutes);
app.use(fsRoutes);
app.use(gitRoutes);

// Static files
app.use(express.static(path.join(ROOT_DIR, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

export default app;
