import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');

assert.match(html, /completedSessions:\s*new Set\(\)/, 'frontend state must track completed sessions');
assert.match(html, /session-complete-dot/, 'sidebar must render a completion indicator element');
assert.match(html, /session-complete-blink/, 'completion indicator must blink');
assert.match(html, /state\.completedSessions\.add\(state\.sessionId\)/, 'turn_end must mark current session as completed');
assert.match(html, /state\.completedSessions\.delete\(s\.id\)/, 'clicking a completed session must clear the marker');
assert.match(html, /state\.completedSessions\.delete\(state\.sessionId\)/, 'turn_start must clear stale completion marker when work resumes');

console.log('session completion marker checks passed');
