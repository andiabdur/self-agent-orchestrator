# Restart App Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a sidebar "Restart" button that stops+starts the server via a detached child process, then auto-reloads the page to the login screen.

**Architecture:** A protected `POST /api/restart` endpoint spawns a detached, unref'd `restart.sh` child (stop→sleep→start) and exits. The frontend shows a fullscreen overlay and polls `/api/auth/check` until the server returns, then redirects to `/login.html`.

**Tech Stack:** Node/Express, node child_process, vanilla JS frontend, bash.

---

### Task 1: restart.sh script

**Files:**
- Create: `restart.sh`

- [ ] **Step 1: Write restart.sh**

```bash
#!/bin/bash
# Restart self-agent-orchestrator: stop then start
cd "$(dirname "$0")"
./stop.sh
sleep 1
./start.sh
```

- [ ] **Step 2: Make executable**

Run: `chmod +x restart.sh`

- [ ] **Step 3: Commit**

```bash
git add restart.sh
git commit -m "feat: add restart.sh for macOS/Linux"
```

---

### Task 2: POST /api/restart endpoint

**Files:**
- Modify: `src/routes/authRoutes.js`

- [ ] **Step 1: Add imports at top of authRoutes.js**

Add after existing imports:

```js
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const RESTART_SCRIPT = path.join(ROOT_DIR, 'restart.sh');
```

- [ ] **Step 2: Add the endpoint before `export default router;`**

```js
router.post('/api/restart', (req, res) => {
  res.json({ ok: true });
  const child = spawn('/bin/bash', [RESTART_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT_DIR,
  });
  child.unref();
  setTimeout(() => process.exit(0), 300);
});
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/authRoutes.js
git commit -m "feat: add POST /api/restart endpoint"
```

---

### Task 3: Frontend button, overlay, and handler

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add Restart button above Logout in the Account settings-card**

Insert before the `#btn-logout` button (line ~2269):

```html
<button id="btn-restart" class="settings-action-btn" type="button">
  <span class="settings-row-icon" style="color:inherit">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
  </span>
  Restart aplikasi
</button>
```

- [ ] **Step 2: Add overlay markup right after `<body>` opening (or near top-level UI). Place before `#sidebar-bg` element.**

```html
<div id="restart-overlay" aria-hidden="true">
  <div class="restart-box">
    <div class="restart-spinner"></div>
    <div id="restart-msg">Restarting… tunggu sebentar</div>
    <button id="restart-reload" type="button" style="display:none">Reload manual</button>
  </div>
</div>
```

- [ ] **Step 3: Add CSS (in the `<style>` block)**

```css
#restart-overlay {
  position: fixed; inset: 0; z-index: 9999;
  display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
}
#restart-overlay.open { display: flex; }
#restart-overlay .restart-box {
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  padding: 32px 40px; background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 12px; color: var(--text); font-size: 14px; text-align: center;
}
#restart-overlay .restart-spinner {
  width: 32px; height: 32px; border: 3px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%;
  animation: restart-spin 0.8s linear infinite;
}
@keyframes restart-spin { to { transform: rotate(360deg); } }
#restart-overlay #restart-reload {
  padding: 8px 16px; background: var(--accent); color: #fff; border: none;
  border-radius: 6px; cursor: pointer; font-size: 13px;
}
```

- [ ] **Step 4: Register the button element in the `els` object (near `btnLogout: $('#btn-logout'),`)**

```js
    btnRestart: $('#btn-restart'),
```

- [ ] **Step 5: Add the handler right after the `els.btnLogout.addEventListener(...)` block**

```js
  els.btnRestart.addEventListener('click', async () => {
    if (!confirm('Yakin mau restart aplikasi? Semua sesi aktif akan terputus dan kamu harus login lagi.')) return;
    const overlay = document.getElementById('restart-overlay');
    const msg = document.getElementById('restart-msg');
    const reloadBtn = document.getElementById('restart-reload');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    try { await fetch('/api/restart', { method: 'POST' }); } catch {}

    const start = Date.now();
    const TIMEOUT_MS = 30000;
    const poll = async () => {
      if (Date.now() - start > TIMEOUT_MS) {
        msg.textContent = 'Restart kelamaan. Coba reload manual.';
        reloadBtn.style.display = 'inline-block';
        return;
      }
      try {
        const res = await fetch('/api/auth/check', { cache: 'no-store' });
        if (res.ok) { window.location.href = '/login.html'; return; }
      } catch {}
      setTimeout(poll, 1500);
    };
    // give the server a moment to actually go down before first poll
    setTimeout(poll, 2000);
  });
  document.getElementById('restart-reload').addEventListener('click', () => window.location.reload());
```

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: sidebar restart button with overlay and auto-reload"
```

---

### Task 4: Manual verification

- [ ] Login → sidebar → Account → click **Restart aplikasi**.
- [ ] Confirm dialog → OK → overlay "Restarting…" shows.
- [ ] `./status.sh` in terminal shows server down then up with a NEW pid.
- [ ] Page auto-reloads to `/login.html` within ~2–4s.
- [ ] Log in again; prior session history still present.
- [ ] Cancel confirm → nothing changes.
