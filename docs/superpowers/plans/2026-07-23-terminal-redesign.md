# Terminal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded terminal feel like a polished developer workbench and make it usable on phones with Tab/Ctrl/Shift/Alt/arrows and extra terminal keys.

**Architecture:** Keep the current single-page app structure and `node-pty` WebSocket backend. Modify only the terminal slice in `public/index.html`, plus add one lightweight static regression script so the UI structure and shortcut keys do not regress. Backend `src/websockets/termWs.js` already supports input and resize, so no backend change is required unless manual testing reveals a PTY issue.

**Tech Stack:** Plain HTML/CSS/JavaScript, xterm.js 5.5.0, xterm fit addon, Express/ws/node-pty, Node.js static verification script.

---

## File Structure

- Create: `scripts/check-terminal-ui.mjs`
  - Reads `public/index.html` and asserts the redesigned terminal markup, CSS hooks, and JavaScript shortcut helpers exist.
  - This gives a quick repeatable check in a project that does not currently have frontend tests.
- Modify: `public/index.html:1789-1848`
  - Replace current terminal CSS with a more polished dock/sheet design, visible grip, status dot, mobile key strip, and More panel.
- Modify: `public/index.html:2544-2571`
  - Replace terminal panel markup with header groups, cwd/status elements, key strip, and extended key panel.
- Modify: `public/index.html:5913-6058`
  - Update xterm theme palette, shortcut key handling, modifier state, hide/show lifecycle, restart behavior, persisted resize height, and mobile viewport fitting.
- Existing, no planned changes: `src/websockets/termWs.js`
  - Already accepts `{ t: 'i', d }` input and `{ t: 'r', cols, rows }` resize messages.
- Run after code changes: `graphify update .`
  - Required by project instructions to keep `graphify-out/` current.

---

### Task 1: Add Terminal UI Regression Check

**Files:**
- Create: `scripts/check-terminal-ui.mjs`

- [ ] **Step 1: Write the failing static regression check**

Create `scripts/check-terminal-ui.mjs` with this exact content:

```js
import fs from 'fs';

const html = fs.readFileSync('public/index.html', 'utf8');

const requiredSnippets = [
  'id="terminal-shell"',
  'id="terminal-status-dot"',
  'id="terminal-cwd"',
  'id="terminal-keystrip"',
  'id="terminal-more-panel"',
  'data-key="ctrl"',
  'data-key="shift"',
  'data-key="alt"',
  'data-key="tab"',
  'data-key="up"',
  'data-key="down"',
  'data-key="left"',
  'data-key="right"',
  'data-key="home"',
  'data-key="end"',
  'data-key="pageup"',
  'data-key="pagedown"',
  'data-key="delete"',
  'data-key="ctrlc"',
  'data-key="ctrll"',
  'const modifierState = { ctrl: false, shift: false, alt: false };',
  'function terminalKeySequence(key)',
  'function sendTerminalInput(data)',
  'function updateModifierButtons()',
  'function setTerminalCwdLabel()',
  'localStorage.setItem(\'terminal-height\'',
  'panel.classList.toggle(\'dragging\'',
];

let failed = false;
for (const snippet of requiredSnippets) {
  if (!html.includes(snippet)) {
    console.error(`Missing terminal UI snippet: ${snippet}`);
    failed = true;
  }
}

if (/function closeTerminal\(\) \{[\s\S]*?term\.dispose\(\)/.test(html)) {
  console.error('closeTerminal() must hide the dock without disposing the shell; Restart handles shell reset.');
  failed = true;
}

if (!html.includes('fontSize: window.matchMedia(\'(max-width: 700px)\').matches ? 14 : 13')) {
  console.error('Terminal font size must be larger on mobile.');
  failed = true;
}

if (failed) process.exit(1);
console.log('Terminal UI static checks passed.');
```

- [ ] **Step 2: Run the check to verify it fails before implementation**

Run:

```bash
node scripts/check-terminal-ui.mjs
```

Expected: `FAIL` with several `Missing terminal UI snippet:` lines because the redesign is not implemented yet.

- [ ] **Step 3: Commit the failing check**

```bash
git add scripts/check-terminal-ui.mjs
git commit -m "test: add terminal ui regression check"
```

---

### Task 2: Replace Terminal Markup

**Files:**
- Modify: `public/index.html:2544-2571`
- Test: `scripts/check-terminal-ui.mjs`

- [ ] **Step 1: Replace the existing terminal panel HTML**

Replace the entire existing `<div id="terminal-panel" aria-hidden="true"> ... </div>` block at `public/index.html:2544-2571` with this exact markup:

```html
<div id="terminal-panel" aria-hidden="true">
  <div id="terminal-resize" title="Drag to resize terminal" aria-label="Resize terminal">
    <span></span>
  </div>
  <div id="terminal-bar">
    <div class="terminal-bar-main">
      <span id="terminal-title">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        Terminal
      </span>
      <span id="terminal-shell">shell</span>
      <span id="terminal-status-wrap" aria-live="polite">
        <span id="terminal-status-dot"></span>
        <span id="terminal-status">idle</span>
      </span>
      <span id="terminal-cwd" title="Current terminal directory"></span>
    </div>
    <div class="terminal-bar-actions">
      <button id="terminal-clear-btn" class="terminal-bar-btn" type="button" title="Clear terminal screen">Clear</button>
      <button id="terminal-restart-btn" class="terminal-bar-btn danger-soft" type="button" title="Restart shell">Restart</button>
      <button id="terminal-close-btn" class="terminal-bar-btn icon-btn" type="button" title="Hide terminal" aria-label="Hide terminal">×</button>
    </div>
  </div>
  <div id="terminal-host-wrap">
    <div id="terminal-host"></div>
  </div>
  <div id="terminal-keystrip" aria-label="Mobile terminal shortcuts">
    <button class="terminal-key" data-key="esc" type="button">Esc</button>
    <button class="terminal-key" data-key="tab" type="button">Tab</button>
    <button class="terminal-key modifier" data-key="ctrl" type="button">Ctrl</button>
    <button class="terminal-key modifier" data-key="shift" type="button">Shift</button>
    <button class="terminal-key modifier" data-key="alt" type="button">Alt</button>
    <button class="terminal-key" data-key="up" type="button">↑</button>
    <button class="terminal-key" data-key="down" type="button">↓</button>
    <button class="terminal-key" data-key="left" type="button">←</button>
    <button class="terminal-key" data-key="right" type="button">→</button>
    <button class="terminal-key" data-key="slash" type="button">/</button>
    <button class="terminal-key" data-key="dash" type="button">-</button>
    <button class="terminal-key wide" data-key="enter" type="button">Enter</button>
    <button id="terminal-more-btn" class="terminal-key wide" data-key="more" type="button" aria-expanded="false" aria-controls="terminal-more-panel">More</button>
  </div>
  <div id="terminal-more-panel" hidden>
    <button class="terminal-key" data-key="home" type="button">Home</button>
    <button class="terminal-key" data-key="end" type="button">End</button>
    <button class="terminal-key" data-key="pageup" type="button">PgUp</button>
    <button class="terminal-key" data-key="pagedown" type="button">PgDn</button>
    <button class="terminal-key" data-key="insert" type="button">Ins</button>
    <button class="terminal-key" data-key="delete" type="button">Del</button>
    <button class="terminal-key danger" data-key="ctrlc" type="button">^C</button>
    <button class="terminal-key" data-key="ctrll" type="button">^L</button>
    <button class="terminal-key" data-key="ctrld" type="button">^D</button>
    <button class="terminal-key wide" data-key="clear" type="button">Clear</button>
  </div>
</div>
```

- [ ] **Step 2: Run the static check and confirm markup-related failures are gone**

Run:

```bash
node scripts/check-terminal-ui.mjs
```

Expected: still `FAIL`, but missing selector errors for `terminal-shell`, `terminal-status-dot`, `terminal-cwd`, `terminal-keystrip`, `terminal-more-panel`, and the `data-key` entries should be gone. Remaining failures should be JavaScript/CSS lifecycle snippets.

- [ ] **Step 3: Commit the markup change**

```bash
git add public/index.html
git commit -m "feat: restructure terminal panel markup"
```

---

### Task 3: Replace Terminal CSS

**Files:**
- Modify: `public/index.html:1789-1848`
- Test: `scripts/check-terminal-ui.mjs`

- [ ] **Step 1: Replace terminal CSS block**

Replace the CSS block from `/* ─── Terminal panel ─────────────────────────────────── */` through `#terminal-host .xterm { height: 100%; }` with this exact CSS:

```css
  /* ─── Terminal panel ─────────────────────────────────── */
  #terminal-panel {
    position: fixed; left: 10px; right: 10px; bottom: 10px;
    height: var(--term-h, 46vh); min-height: 180px; max-height: min(86vh, 720px);
    background: color-mix(in srgb, var(--code-bg) 92%, #000 8%);
    border: 1px solid color-mix(in srgb, var(--border) 82%, var(--accent) 18%);
    border-radius: 12px;
    z-index: 60; display: none; flex-direction: column;
    box-shadow: 0 -18px 48px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.025) inset;
    overflow: hidden;
    transform: translateY(12px) scale(.992);
    opacity: 0;
    transition: transform .16s ease, opacity .16s ease, border-color .16s ease;
    padding-bottom: env(safe-area-inset-bottom);
  }
  #terminal-panel.open { display: flex; transform: translateY(0) scale(1); opacity: 1; }
  #terminal-panel.dragging { transition: none; border-color: var(--accent); }
  #terminal-resize {
    position: absolute; top: 0; left: 0; right: 0; height: 14px;
    cursor: ns-resize; z-index: 3;
    display: flex; align-items: center; justify-content: center;
    touch-action: none;
  }
  #terminal-resize span {
    width: 54px; height: 3px; border-radius: 999px;
    background: color-mix(in srgb, var(--muted) 72%, var(--accent) 28%);
    opacity: .65;
    transition: width .14s ease, opacity .14s ease, background .14s ease;
  }
  #terminal-resize:hover span, #terminal-panel.dragging #terminal-resize span {
    width: 74px; opacity: 1; background: var(--accent);
  }
  #terminal-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 12px 12px 8px; flex-shrink: 0;
    background: linear-gradient(180deg, color-mix(in srgb, var(--bg-2) 94%, #fff 6%), var(--bg-2));
    border-bottom: 1px solid color-mix(in srgb, var(--border) 88%, transparent 12%);
    font-size: 12px; user-select: none;
  }
  .terminal-bar-main, .terminal-bar-actions {
    display: flex; align-items: center; gap: 8px; min-width: 0;
  }
  .terminal-bar-main { flex: 1; }
  #terminal-title {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--text-strong); font-weight: 600;
    font-family: 'IBM Plex Mono', monospace;
    letter-spacing: .01em;
  }
  #terminal-shell {
    color: var(--muted); font-size: 10.5px; font-family: 'IBM Plex Mono', monospace;
    border: 1px solid var(--border); border-radius: 999px;
    padding: 2px 7px; background: rgba(0,0,0,.12);
  }
  #terminal-status-wrap {
    display: inline-flex; align-items: center; gap: 5px;
    color: var(--muted); font-size: 11px; font-family: 'IBM Plex Mono', monospace;
    white-space: nowrap;
  }
  #terminal-status-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--muted);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--muted) 18%, transparent);
  }
  #terminal-panel[data-status="connected"] #terminal-status-dot { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent); }
  #terminal-panel[data-status="connecting"] #terminal-status-dot { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  #terminal-panel[data-status="error"] #terminal-status-dot,
  #terminal-panel[data-status="disconnected"] #terminal-status-dot,
  #terminal-panel[data-status="exited"] #terminal-status-dot { background: var(--error); box-shadow: 0 0 0 3px color-mix(in srgb, var(--error) 18%, transparent); }
  #terminal-cwd {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--muted); font-size: 11px; font-family: 'IBM Plex Mono', monospace;
  }
  .terminal-bar-btn, .terminal-key {
    background: color-mix(in srgb, var(--bg-2) 76%, #000 24%);
    border: 1px solid var(--border); color: var(--text-em);
    cursor: pointer; border-radius: 7px;
    font: inherit; font-family: 'IBM Plex Mono', monospace;
    transition: background .12s, color .12s, border-color .12s, transform .08s;
    touch-action: manipulation; user-select: none; -webkit-user-select: none;
  }
  .terminal-bar-btn { padding: 4px 10px; font-size: 11.5px; }
  .terminal-bar-btn:hover, .terminal-key:hover { background: var(--bg-3); color: var(--text); border-color: var(--accent); }
  .terminal-bar-btn:active, .terminal-key:active { transform: translateY(1px); }
  .terminal-bar-btn.danger-soft:hover, .terminal-key.danger { border-color: color-mix(in srgb, var(--error) 70%, var(--border)); color: var(--error); }
  .terminal-bar-btn.icon-btn { min-width: 30px; padding: 4px 8px; font-size: 16px; line-height: 1; }
  #terminal-host-wrap {
    flex: 1; min-height: 0; padding: 10px;
    background:
      radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 30%),
      color-mix(in srgb, var(--code-bg) 96%, #000 4%);
  }
  #terminal-host {
    height: 100%; overflow: hidden; border-radius: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--code-bg) 90%, #000 10%);
    border: 1px solid rgba(255,255,255,.035);
  }
  #terminal-host .xterm { height: 100%; }
  #terminal-keystrip, #terminal-more-panel {
    display: none;
    flex-shrink: 0;
    gap: 6px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--bg-2) 88%, #000 12%);
    border-top: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  #terminal-keystrip::-webkit-scrollbar, #terminal-more-panel::-webkit-scrollbar { display: none; }
  #terminal-more-panel:not([hidden]) { display: flex; }
  .terminal-key {
    min-width: 44px; min-height: 40px; padding: 0 10px;
    font-size: 12px; flex: 0 0 auto;
  }
  .terminal-key.wide { min-width: 64px; }
  .terminal-key.modifier.active {
    background: var(--accent); color: var(--on-accent); border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent);
  }
  @media (max-width: 768px) {
    #terminal-panel {
      left: 0; right: 0; bottom: 0;
      height: var(--term-h, 58vh); min-height: 280px; max-height: 92vh;
      border-left: none; border-right: none; border-bottom: none;
      border-radius: 14px 14px 0 0;
    }
    #terminal-bar { align-items: flex-start; padding: 14px 10px 8px; gap: 8px; }
    .terminal-bar-main { flex-wrap: wrap; row-gap: 5px; }
    #terminal-cwd { flex-basis: 100%; }
    .terminal-bar-actions { gap: 6px; }
    .terminal-bar-btn { min-height: 34px; padding: 4px 9px; }
    #terminal-host-wrap { padding: 8px; }
    #terminal-host { padding: 7px 8px; }
    #terminal-keystrip { display: flex; }
  }
  @media (prefers-reduced-motion: reduce) {
    #terminal-panel, #terminal-resize span, .terminal-bar-btn, .terminal-key { transition: none; }
  }
```

- [ ] **Step 2: Run the static check and confirm CSS-related failure is gone**

Run:

```bash
node scripts/check-terminal-ui.mjs
```

Expected: still `FAIL`, but the `panel.classList.toggle('dragging'` and `localStorage.setItem('terminal-height'` failures will remain until JavaScript is updated.

- [ ] **Step 3: Commit the CSS change**

```bash
git add public/index.html
git commit -m "style: polish terminal dock"
```

---

### Task 4: Add Mobile Shortcut Key Handling

**Files:**
- Modify: `public/index.html:5913-6007`
- Test: `scripts/check-terminal-ui.mjs`

- [ ] **Step 1: Replace `xtermTheme()`, `setStatus()`, `fitAndResize()`, and shortcut setup code**

Inside `(function initTerminal() { ... })`, replace the existing code from `function xtermTheme() {` through the end of `function ensureTerm() { ... }` with this exact code:

```js
    const modifierState = { ctrl: false, shift: false, alt: false };

    function xtermTheme() {
      const css = getComputedStyle(document.documentElement);
      const v = (n, d) => (css.getPropertyValue(n).trim() || d);
      return {
        background: v('--code-bg', '#16161e'),
        foreground: v('--text', '#c0caf5'),
        cursor: v('--accent', '#7aa2f7'),
        cursorAccent: v('--code-bg', '#16161e'),
        selectionBackground: 'rgba(122,162,247,.30)',
        black: '#15161e',
        red: v('--error', '#f7768e'),
        green: v('--success', '#9ece6a'),
        yellow: v('--code-fg', '#e0af68'),
        blue: v('--accent', '#7aa2f7'),
        magenta: '#bb9af7',
        cyan: v('--link', '#7dcfff'),
        white: v('--text-em', '#a9b1d6'),
        brightBlack: v('--muted', '#565f89'),
        brightRed: v('--error', '#f7768e'),
        brightGreen: v('--success', '#9ece6a'),
        brightYellow: v('--code-fg', '#e0af68'),
        brightBlue: v('--accent', '#7aa2f7'),
        brightMagenta: '#bb9af7',
        brightCyan: v('--link', '#7dcfff'),
        brightWhite: v('--text-strong', '#d8e0ff'),
      };
    }

    function setStatus(s) {
      if (statusEl) statusEl.textContent = s;
      panel.dataset.status = s;
    }

    function setTerminalCwdLabel() {
      const cwdEl = document.getElementById('terminal-cwd');
      const shellEl = document.getElementById('terminal-shell');
      let cwd = '';
      if (window.currentSessionId && window.__sessions) {
        const session = window.__sessions.find(s => s.id === window.currentSessionId);
        if (session && session.cwd) cwd = session.cwd;
      }
      if (!cwd && window.DEFAULT_CWD) cwd = window.DEFAULT_CWD;
      if (cwdEl) {
        const home = (window.__HOME || '').replace(/\/$/, '');
        const label = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
        cwdEl.textContent = label || 'current workspace';
        cwdEl.title = cwd || 'Current workspace';
      }
      if (shellEl) shellEl.textContent = navigator.platform.toLowerCase().includes('win') ? 'powershell' : 'zsh';
    }

    function fitAndResize() {
      if (!term || !fitAddon) return;
      try { fitAddon.fit(); } catch {}
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
      }
    }

    function sendTerminalInput(data) {
      if (!data || !sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ t: 'i', d: data }));
      term && term.focus();
    }

    function resetModifiers() {
      modifierState.ctrl = false;
      modifierState.shift = false;
      modifierState.alt = false;
      updateModifierButtons();
    }

    function updateModifierButtons() {
      document.querySelectorAll('#terminal-keystrip .terminal-key.modifier').forEach((button) => {
        const key = button.getAttribute('data-key');
        button.classList.toggle('active', !!modifierState[key]);
        button.setAttribute('aria-pressed', modifierState[key] ? 'true' : 'false');
      });
    }

    function terminalKeySequence(key) {
      const ctrlMap = { c: '\x03', d: '\x04', l: '\x0c', a: '\x01', e: '\x05', u: '\x15', k: '\x0b', w: '\x17' };
      const normal = {
        esc: '\x1b', tab: '\x09', enter: '\r', slash: '/', dash: '-',
        up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
        home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
        insert: '\x1b[2~', delete: '\x1b[3~', ctrlc: '\x03', ctrll: '\x0c', ctrld: '\x04',
      };
      const shifted = { tab: '\x1b[Z' };
      if (key === 'clear') { term && term.clear(); resetModifiers(); return ''; }
      if (modifierState.ctrl && ctrlMap[key]) return ctrlMap[key];
      if (modifierState.shift && shifted[key]) return shifted[key];
      let seq = normal[key] || '';
      if (modifierState.alt && seq && seq.length === 1) seq = '\x1b' + seq;
      return seq;
    }

    function handleTerminalKeyButton(button) {
      const key = button.getAttribute('data-key');
      if (!key) return;
      if (key === 'more') {
        const panelEl = document.getElementById('terminal-more-panel');
        const expanded = panelEl && panelEl.hasAttribute('hidden');
        if (panelEl) panelEl.hidden = !expanded;
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        term && term.focus();
        return;
      }
      if (key === 'ctrl' || key === 'shift' || key === 'alt') {
        modifierState[key] = !modifierState[key];
        updateModifierButtons();
        term && term.focus();
        return;
      }
      const sequence = terminalKeySequence(key);
      sendTerminalInput(sequence);
      if (key !== 'clear') resetModifiers();
    }

    function attachTerminalKeyHandlers() {
      document.querySelectorAll('#terminal-keystrip .terminal-key, #terminal-more-panel .terminal-key').forEach((button) => {
        if (button.dataset.eventsAttached) return;
        button.dataset.eventsAttached = 'true';
        button.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleTerminalKeyButton(button);
        });
      });
      updateModifierButtons();
    }

    function ensureTerm() {
      if (term || !window.Terminal) return !!term;
      term = new window.Terminal({
        cursorBlink: true,
        fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
        fontSize: window.matchMedia('(max-width: 700px)').matches ? 14 : 13,
        lineHeight: 1.22,
        letterSpacing: .2,
        theme: xtermTheme(),
        scrollback: 5000,
        allowProposedApi: true,
      });
      const FitCtor = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
      if (FitCtor) { fitAddon = new FitCtor(); term.loadAddon(fitAddon); }
      term.open(host);
      term.onData(sendTerminalInput);
      attachTerminalKeyHandlers();
      return true;
    }
```

- [ ] **Step 2: Run the static check**

Run:

```bash
node scripts/check-terminal-ui.mjs
```

Expected: still `FAIL` only for lifecycle/resize persistence snippets if Task 5 is not complete yet.

- [ ] **Step 3: Commit shortcut logic**

```bash
git add public/index.html
git commit -m "feat: add mobile terminal shortcut keys"
```

---

### Task 5: Update Terminal Lifecycle, Resize, and Persistence

**Files:**
- Modify: `public/index.html:5935-5957`
- Modify: `public/index.html:6009-6058`
- Test: `scripts/check-terminal-ui.mjs`

- [ ] **Step 1: Replace `connect()` with cwd/status-aware connection**

Replace the existing `function connect() { ... }` block with this exact code:

```js
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let cwdParam = '';
      if (window.currentSessionId && window.__sessions) {
        const session = window.__sessions.find(s => s.id === window.currentSessionId);
        if (session && session.cwd) cwdParam = '?cwd=' + encodeURIComponent(session.cwd);
      }
      setTerminalCwdLabel();
      sock = new WebSocket(proto + '//' + location.host + '/term' + cwdParam);
      setStatus('connecting');
      sock.onopen = () => { setStatus('connected'); fitAndResize(); term && term.focus(); };
      sock.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'o') term.write(msg.d);
        else if (msg.t === 'x') {
          term.write(`\r\n\x1b[90m[process exited${msg.code != null ? ' (' + msg.code + ')' : ''}]\x1b[0m\r\n`);
          setStatus('exited');
        }
      };
      sock.onclose = () => { if (panel.classList.contains('open')) setStatus('disconnected'); sock = null; };
      sock.onerror = () => { setStatus('error'); };
    }
```

- [ ] **Step 2: Replace open/close/restart/resize code**

Replace the existing code from `function openTerminal() {` through `window.addEventListener('resize', () => { if (isOpen) fitAndResize(); });` with this exact code:

```js
    function openTerminal() {
      if (!window.Terminal) { alert('Terminal gagal dimuat (xterm.js tidak tersedia).'); return; }
      isOpen = true;
      const savedHeight = localStorage.getItem('terminal-height');
      if (savedHeight) document.documentElement.style.setProperty('--term-h', savedHeight);
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      btn.classList.add('active');
      setTerminalCwdLabel();
      ensureTerm();
      if (!sock) connect();
      requestAnimationFrame(() => { fitAndResize(); term && term.focus(); });
    }

    function closeTerminal() {
      isOpen = false;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      btn.classList.remove('active');
      const morePanel = document.getElementById('terminal-more-panel');
      const moreBtn = document.getElementById('terminal-more-btn');
      if (morePanel) morePanel.hidden = true;
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
      resetModifiers();
    }

    function restartTerminal() {
      if (sock) { try { sock.close(); } catch {} sock = null; }
      if (term) { try { term.dispose(); } catch {} term = null; fitAddon = null; }
      setStatus('connecting');
      ensureTerm();
      connect();
      requestAnimationFrame(() => { fitAndResize(); term && term.focus(); });
    }

    btn.addEventListener('click', () => { isOpen ? closeTerminal() : openTerminal(); });
    document.getElementById('terminal-close-btn').addEventListener('click', closeTerminal);
    document.getElementById('terminal-clear-btn').addEventListener('click', () => { term && term.clear(); term && term.focus(); });
    document.getElementById('terminal-restart-btn').addEventListener('click', restartTerminal);

    if (resizeHandle) {
      let dragging = false;
      const onMove = (e) => {
        if (!dragging) return;
        const y = e.touches ? e.touches[0].clientY : e.clientY;
        const viewportH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const minH = window.matchMedia('(max-width: 700px)').matches ? 280 : 180;
        const maxH = viewportH * (window.matchMedia('(max-width: 700px)').matches ? 0.92 : 0.86);
        const h = Math.min(maxH, Math.max(minH, viewportH - y));
        const value = Math.round(h) + 'px';
        document.documentElement.style.setProperty('--term-h', value);
        localStorage.setItem('terminal-height', value);
        fitAndResize();
      };
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        panel.classList.toggle('dragging', false);
      };
      const start = (e) => {
        dragging = true;
        document.body.style.userSelect = 'none';
        panel.classList.toggle('dragging', true);
        e.preventDefault();
      };
      resizeHandle.addEventListener('mousedown', start);
      resizeHandle.addEventListener('touchstart', start, { passive: false });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('mouseup', stop);
      window.addEventListener('touchend', stop);
      window.addEventListener('touchcancel', stop);
    }

    window.addEventListener('resize', () => { if (isOpen) fitAndResize(); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => { if (isOpen) fitAndResize(); });
    }
```

- [ ] **Step 3: Run the static check and verify it passes**

Run:

```bash
node scripts/check-terminal-ui.mjs
```

Expected:

```text
Terminal UI static checks passed.
```

- [ ] **Step 4: Commit lifecycle and resize changes**

```bash
git add public/index.html
git commit -m "feat: improve terminal lifecycle and resize"
```

---

### Task 6: Manual Browser Verification

**Files:**
- Verify: `public/index.html`
- Verify: `src/websockets/termWs.js`

- [ ] **Step 1: Start the app**

Run:

```bash
npm start
```

Expected: server starts without syntax/runtime errors. If the app logs a port, use that port in the browser.

- [ ] **Step 2: Open terminal on desktop viewport**

In the browser:

1. Open the app.
2. Click the terminal button in the header.
3. Confirm the terminal opens as a rounded bottom dock.
4. Confirm status changes from `connecting` to `connected`.
5. Type:

```bash
pwd
```

Expected: terminal prints the session cwd or default cwd.

- [ ] **Step 3: Verify hide/show preserves terminal process**

In the terminal, run:

```bash
export TERMINAL_KEEPALIVE_TEST=ok
```

Then:

1. Click `×` to hide the terminal.
2. Click the terminal button to show it again.
3. Run:

```bash
echo $TERMINAL_KEEPALIVE_TEST
```

Expected: output is `ok`. This proves hide/show does not dispose the shell.

- [ ] **Step 4: Verify Restart intentionally resets shell**

Click `Restart`, then run:

```bash
echo $TERMINAL_KEEPALIVE_TEST
```

Expected: empty output. This proves Restart is the action that resets the PTY.

- [ ] **Step 5: Verify mobile shortcut keys**

Use responsive mode at 390px width. Open the terminal and test:

1. Tap `Tab` after typing `cd `.
   - Expected: shell attempts path completion.
2. Tap `Ctrl`, then use the `More` panel `^C` button while a command is running:

```bash
sleep 10
```

   - Expected: command interrupts.
3. Tap `↑` and `↓`.
   - Expected: shell history moves.
4. Tap `Shift`, then `Tab`.
   - Expected: sends Shift+Tab escape (`\x1b[Z`); no visual modifier remains stuck.
5. Tap `More`, then `Home`, `End`, `Del`, `PgUp`, `PgDn`.
   - Expected: escape sequences are sent; modifier buttons remain usable afterward.

- [ ] **Step 6: Stop the app**

Press `Ctrl+C` in the terminal running `npm start`.

- [ ] **Step 7: Commit any verification fixes**

If manual testing required fixes:

```bash
git add public/index.html scripts/check-terminal-ui.mjs
git commit -m "fix: polish terminal verification issues"
```

If no fixes were required, do not create an empty commit.

---

### Task 7: Project Required Graph Update and Final Checks

**Files:**
- Modify: `graphify-out/*` via `graphify update .`
- Test: `scripts/check-terminal-ui.mjs`

- [ ] **Step 1: Run static terminal check one final time**

```bash
node scripts/check-terminal-ui.mjs
```

Expected:

```text
Terminal UI static checks passed.
```

- [ ] **Step 2: Run a Node syntax smoke check**

```bash
node --check server.js
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Update the knowledge graph**

Run:

```bash
graphify update .
```

Expected: graphify completes successfully and updates `graphify-out/` metadata for changed files.

- [ ] **Step 4: Review git diff**

```bash
git diff -- public/index.html scripts/check-terminal-ui.mjs graphify-out
```

Expected: diff only contains the terminal redesign, shortcut test, and graphify update outputs.

- [ ] **Step 5: Commit graph update**

```bash
git add graphify-out scripts/check-terminal-ui.mjs public/index.html
git commit -m "chore: update graph after terminal redesign"
```

---

## Self-Review

- **Spec coverage:** Covers polished terminal panel, visible resize grip, status/cwd/shell indicators, mobile Tab/Ctrl/Shift/Alt/arrows, More keys, hide/show shell preservation, Restart reset behavior, static check, manual desktop/mobile verification, and graphify update.
- **Placeholder scan:** No TBD/TODO/fill-in placeholders are present. Every code-changing step includes exact code.
- **Type/name consistency:** The test expects `modifierState`, `terminalKeySequence`, `sendTerminalInput`, `updateModifierButtons`, `setTerminalCwdLabel`, `terminal-keystrip`, and `terminal-more-panel`; the implementation tasks define those exact names.
- **Scope:** Focused on the existing terminal UI in `public/index.html`; no unrelated app refactor or backend rewrite is included.
