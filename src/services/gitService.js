import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// Promise wrapper around `git` with a timeout and bounded output buffer.
export function runGit(cwd, args) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: err.message, spawnError: true });
    }
    const MAX = 4 * 1024 * 1024; // 4 MB cap
    let out = '', errBuf = '', truncated = false, done = false;
    const finish = (code) => { if (done) return; done = true; resolve({ code, stdout: out, stderr: errBuf, truncated }); };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(-2); }, 10000);
    proc.stdout.on('data', (d) => { if (out.length < MAX) out += d; else truncated = true; });
    proc.stderr.on('data', (d) => { if (errBuf.length < MAX) errBuf += d; });
    proc.on('error', (err) => { clearTimeout(timer); if (!errBuf) errBuf = err.message; proc.spawnError = true; finish(-1); });
    proc.on('close', (code) => { clearTimeout(timer); finish(code); });
  });
}

// Parse `git diff --numstat` output into { path: { insertions, deletions } }.
export function parseNumstat(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const ins = parts[0] === '-' ? null : parseInt(parts[0], 10);
    const del = parts[1] === '-' ? null : parseInt(parts[1], 10);
    let p = parts.slice(2).join('\t');
    const arrow = p.indexOf(' => ');
    if (arrow >= 0) {
      p = p.replace(/\{[^}]*=> ([^}]*)\}/g, '$1');
      const idx = p.indexOf(' => ');
      if (idx >= 0) p = p.slice(idx + 4);
    }
    map.set(p, { insertions: ins, deletions: del });
  }
  return map;
}

// Collect the working-tree file list for `cwd` from `git status --porcelain -z`,
// enriched with per-file insertions/deletions (untracked files are counted by
// reading the file). Pass `filter` (a Set of repo-relative paths) to restrict
// the result, e.g. to files edited during the last agent turn.
export async function collectStatusFiles(cwd, filter = null) {
  const [porcelain, unstaged, staged] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(cwd, ['diff', '--numstat']),
    runGit(cwd, ['diff', '--cached', '--numstat']),
  ]);
  const unstagedStats = parseNumstat(unstaged.stdout);
  const stagedStats = parseNumstat(staged.stdout);

  // `-z` separates entries with NUL; rename entries consume an extra NUL token.
  const tokens = porcelain.stdout.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const x = entry[0], y = entry[1];
    let p = entry.slice(3);
    let renamedFrom = null;
    if (x === 'R' || x === 'C') { renamedFrom = tokens[++i] || null; }

    if (filter && !filter.has(p)) continue;

    const untracked = x === '?' && y === '?';
    const isStaged = !untracked && x !== ' ' && x !== '?';
    const hasUnstaged = y !== ' ' && y !== '?';
    let status = untracked ? '?' : (x !== ' ' ? x : y);
    let stat = stagedStats.get(p) || unstagedStats.get(p) || null;
    if (untracked) {
      // Count lines in the new file as insertions (text only; binary → null).
      try {
        const full = path.join(cwd, p);
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) stat = { insertions: null, deletions: 0 };
        else {
          const txt = buf.toString('utf8');
          const lines = txt.length === 0 ? 0 : txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0);
          stat = { insertions: lines, deletions: 0 };
        }
      } catch { stat = { insertions: null, deletions: 0 }; }
    }
    files.push({
      path: p, status, staged: isStaged, unstaged: hasUnstaged || untracked,
      untracked, renamedFrom, insertions: stat ? stat.insertions : null, deletions: stat ? stat.deletions : null,
    });
  }
  return files;
}
