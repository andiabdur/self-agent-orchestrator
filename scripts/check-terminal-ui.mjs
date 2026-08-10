import fs from 'fs';

const html = fs.readFileSync('public/index.html', 'utf8');

const requiredSnippets = [
  'id="terminal-shell"',
  'id="terminal-tabs"',
  'id="terminal-select"',
  'id="terminal-select-label"',
  'id="terminal-menu"',
  'id="terminal-new-btn"',
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
  'const terminalSessions = new Map();',
  'function createTerminalSession()',
  'function switchTerminalSession(id)',
  'function closeTerminalSession(id)',
  'function renderTerminalTabs()',
  'function updateTerminalSelectorMode()',
  'function renderTerminalMenu(session)',
  'function setTerminalMenuOpen(open)',
  'terminal-use-select',
  'terminal-menu-open',
  '#terminal-new-btn, #terminal-pin-btn, #terminal-close-btn',
  'flex: 0 0 34px',
  'order: 1',
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

const pinButtonMatch = html.match(/<button id="terminal-pin-btn"[\s\S]*?<\/button>/);
if (!pinButtonMatch || !pinButtonMatch[0].includes('<svg')) {
  console.error('Terminal pin button must use an inline SVG icon.');
  failed = true;
}
if (pinButtonMatch && /📌|📍|🧷/.test(pinButtonMatch[0])) {
  console.error('Terminal pin button must not use emoji icons.');
  failed = true;
}

if (failed) process.exit(1);
console.log('Terminal UI static checks passed.');
