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
