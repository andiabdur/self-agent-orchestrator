import express from 'express';
import fs from 'fs';
import path from 'path';
import { resolveContainedDir } from '../utils/helpers.js';
import { runGit, collectStatusFiles } from '../services/gitService.js';
import { SESSIONS_DIR } from '../config.js';
import { isAuthenticated } from '../services/authService.js';

const router = express.Router();

router.get('/api/git/status', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.query.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return res.json({ isRepo: false });
  }

  const branchRes = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  let branch = branchRes.stdout.trim();
  if (branch === 'HEAD') {
    const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    branch = sha.stdout.trim() ? `(detached ${sha.stdout.trim()})` : '(detached)';
  }

  const files = await collectStatusFiles(cwd);
  res.json({ isRepo: true, branch, files });
});

router.get('/api/git/last-turn', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.query.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : null;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return res.json({ isRepo: false });
  }

  const fPath = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(fPath)) {
    return res.json({ isRepo: true, files: [] });
  }

  let events = [];
  try {
    events = fs.readFileSync(fPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read session events: ' + err.message });
  }

  let lastTurnStartIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'turn_start') {
      lastTurnStartIndex = i;
      break;
    }
  }

  if (lastTurnStartIndex === -1) {
    return res.json({ isRepo: true, files: [] });
  }

  const editedFilesSet = new Set();
  for (let i = lastTurnStartIndex; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'tool_start' && (e.name === 'Write' || e.name === 'Edit' || e.name === 'NotebookEdit')) {
      const absPath = e.input?.file_path || e.input?.notebook_path;
      if (absPath) {
        try {
          const resolvedAbs = path.resolve(absPath);
          if (resolvedAbs === cwd || resolvedAbs.startsWith(cwd + path.sep)) {
            const relPath = path.relative(cwd, resolvedAbs);
            editedFilesSet.add(relPath);
          }
        } catch {}
      }
    }
  }

  const files = await collectStatusFiles(cwd, editedFilesSet);
  res.json({ isRepo: true, files });
});

router.get('/api/git/diff', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.query.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const rel = req.query.path ? String(req.query.path) : null;
  if (!rel) return res.status(400).json({ error: 'path required' });
  let target;
  try { target = path.resolve(cwd, rel); } catch { return res.status(400).json({ error: 'Invalid path' }); }
  if (target !== cwd && !target.startsWith(cwd + path.sep)) return res.status(403).json({ error: 'Access denied' });

  const staged = req.query.staged === '1';
  const untracked = req.query.untracked === '1';
  let result;
  if (untracked) {
    result = await runGit(cwd, ['diff', '--no-index', '--', '/dev/null', target]);
    if (result.spawnError || result.code < 0) return res.status(400).json({ error: result.stderr || 'git diff failed' });
  } else {
    const args = ['diff'];
    if (staged) args.push('--cached');
    args.push('--', rel);
    result = await runGit(cwd, args);
    if (result.code !== 0 && result.code < 0) return res.status(400).json({ error: result.stderr || 'git diff failed' });
  }
  res.json({ diff: result.stdout, truncated: !!result.truncated });
});

router.post('/api/git/stage', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.body.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const files = req.body.files;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'files required' });
  for (const f of files) {
    if (typeof f !== 'string') return res.status(400).json({ error: 'files must be strings' });
    let target;
    try { target = path.resolve(cwd, f); } catch { return res.status(400).json({ error: 'Invalid path' }); }
    if (target !== cwd && !target.startsWith(cwd + path.sep)) return res.status(403).json({ error: 'Access denied' });
  }
  const result = await runGit(cwd, ['add', '--', ...files]);
  if (result.code !== 0) return res.status(400).json({ error: result.stderr || 'git add failed' });
  res.json({ ok: true });
});

router.post('/api/git/unstage', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.body.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const files = req.body.files;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'files required' });
  for (const f of files) {
    if (typeof f !== 'string') return res.status(400).json({ error: 'files must be strings' });
    let target;
    try { target = path.resolve(cwd, f); } catch { return res.status(400).json({ error: 'Invalid path' }); }
    if (target !== cwd && !target.startsWith(cwd + path.sep)) return res.status(403).json({ error: 'Access denied' });
  }
  const result = await runGit(cwd, ['reset', 'HEAD', '--', ...files]);
  if (result.code !== 0) return res.status(400).json({ error: result.stderr || 'git reset failed' });
  res.json({ ok: true });
});

router.post('/api/git/commit-push', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.body.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const message = req.body.message;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'commit message required' });
  }
  const commitResult = await runGit(cwd, ['commit', '-m', message.trim()]);
  if (commitResult.code !== 0) {
    return res.status(400).json({ error: commitResult.stderr || 'git commit failed', step: 'commit' });
  }
  const branchRes = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.stdout.trim();
  if (!branch || branch === 'HEAD') {
    return res.json({ ok: true, committed: true, pushed: false, error: 'Cannot push from detached HEAD' });
  }
  const pushResult = await runGit(cwd, ['push', '-u', 'origin', branch], { timeout: 60000 });
  if (pushResult.code !== 0) {
    return res.json({ ok: true, committed: true, pushed: false, error: pushResult.stderr || 'git push failed' });
  }
  res.json({ ok: true, committed: true, pushed: true, branch });
});

router.get('/api/git/branches', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.query.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const result = await runGit(cwd, ['branch', '--format=%(refname:short)\t%(HEAD)']);
  if (result.code !== 0) return res.status(400).json({ error: result.stderr || 'git branch failed' });
  const branches = [];
  let current = '';
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, head] = line.split('\t');
    branches.push(name);
    if (head === '*') current = name;
  }
  res.json({ branches, current });
});

router.post('/api/git/checkout', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.body.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const branch = req.body.branch;
  if (!branch || typeof branch !== 'string' || !branch.trim()) {
    return res.status(400).json({ error: 'branch name required' });
  }
  const sanitized = branch.trim();
  if (/[;&|`$(){}]/.test(sanitized)) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }
  const result = await runGit(cwd, ['checkout', sanitized]);
  if (result.code !== 0) return res.status(400).json({ error: result.stderr || 'git checkout failed' });
  res.json({ ok: true, branch: sanitized });
});

router.post('/api/git/merge', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' });
  const c = resolveContainedDir(req.body.cwd);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const cwd = c.dir;
  const from = req.body.from;
  const into = req.body.into;
  if (!from || !into || typeof from !== 'string' || typeof into !== 'string') {
    return res.status(400).json({ error: 'from and into branch names required' });
  }
  for (const b of [from, into]) {
    if (/[;&|`$(){}]/.test(b.trim())) return res.status(400).json({ error: 'Invalid branch name' });
  }
  // Checkout target branch first
  const checkoutResult = await runGit(cwd, ['checkout', into.trim()]);
  if (checkoutResult.code !== 0) {
    return res.status(400).json({ error: checkoutResult.stderr || 'checkout failed', step: 'checkout' });
  }
  // Merge from branch into current
  const mergeResult = await runGit(cwd, ['merge', '--no-ff', from.trim()]);
  if (mergeResult.code !== 0) {
    // Abort merge to leave repo clean
    await runGit(cwd, ['merge', '--abort']);
    return res.status(400).json({ error: mergeResult.stderr || 'merge failed', step: 'merge', conflict: mergeResult.stderr.includes('CONFLICT') });
  }
  res.json({ ok: true, from: from.trim(), into: into.trim(), output: mergeResult.stdout });
});

export default router;
