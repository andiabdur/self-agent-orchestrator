# Restart App Button — Design Spec

**Date:** 2026-07-17
**Status:** Approved, ready for implementation plan

## Problem

Restarting the orchestrator server today is manual: the operator SSHes/opens a
terminal and runs shell scripts (`stop.sh`, `start.sh`). We want a **Restart**
button in the sidebar that stops and starts the app automatically, then the page
auto-refreshes and lands on the login screen so the user can log in again.

## User-facing flow (option A — with confirmation)

1. User opens sidebar → **Account** section → clicks **Restart** button.
2. Native `confirm(...)` dialog: "Yakin mau restart aplikasi? Semua sesi aktif
   akan terputus dan kamu harus login lagi." Cancel → nothing happens.
3. On confirm → a fullscreen **overlay** ("Restarting… tunggu sebentar" + spinner)
   covers the UI so the user can't interact during the transition.
4. Frontend calls `POST /api/restart`, then polls `GET /api/auth/check` every
   ~1.5s until the server responds again.
5. On the first successful poll response → `window.location.href = '/login.html'`.
6. If polling exceeds a ~30s timeout → overlay shows a failure message with a
   manual "Reload" button.

Because auth sessions are stored **in-memory** (`activeSessions` Set in
`authService.js`), restarting the server invalidates all existing tokens
automatically — the user is bounced to login with no extra logout logic needed.
On-disk session history (`~/.self-agent-orchestrator/sessions/`) is preserved.

## Architecture

### Backend — `POST /api/restart`

Added to `src/routes/authRoutes.js` (protected by the existing auth middleware in
`src/app.js`; not added to `publicPaths`).

The server cannot restart itself in-process — if it kills its own process, nothing
remains to start it back up. So the endpoint spawns a **detached, unref'd child
process** that outlives the server, then exits:

```js
router.post('/api/restart', (req, res) => {
  res.json({ ok: true });                       // respond before dying
  const child = spawn('/bin/bash', [RESTART_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT_DIR,
  });
  child.unref();                                // let the parent exit
  setTimeout(() => process.exit(0), 300);       // give the HTTP response time to flush
});
```

- `RESTART_SCRIPT` = absolute path to `restart.sh` at the project root.
- `ROOT_DIR` resolved from `import.meta.url` (same pattern as `src/config.js` /
  `src/app.js`).
- `detached: true` + `child.unref()` + `stdio: 'ignore'` ensure the child is not
  tied to the dying parent's process group / stdio.

### New script — `restart.sh`

A macOS/Linux restart script (only `.bat`/`.ps1` variants exist today). It runs
the existing scripts in sequence:

```bash
#!/bin/bash
cd "$(dirname "$0")"
./stop.sh
sleep 1
./start.sh
```

`start.sh` already uses a pidfile + `nohup`, so the newly started server is a
proper independent background process. The script must be `chmod +x`.

Note: when the detached child calls `stop.sh`, the current server process is the
one being killed — the child itself is independent, so it survives to run
`start.sh`.

### Frontend — `public/index.html`

Three additions:

1. **Button** in the Account `settings-card`, placed *above* the Logout button.
   Style `settings-action-btn` (normal color, not `danger` — to distinguish it
   from Logout). Circular-arrows (refresh) icon. `id="btn-restart"`.

2. **Overlay** element `#restart-overlay`: `position: fixed`, full-screen,
   backdrop blur, centered spinner + status text. Hidden by default; shown when
   restart starts. Covers all UI so no interaction is possible mid-restart.

3. **JS handler** wired like the existing `btnLogout` handler:
   - `confirm(...)` → on OK, show overlay, `fetch('/api/restart', {method:'POST'})`.
   - Poll `/api/auth/check` every ~1.5s inside a try/catch loop. Network errors
     (server down) are expected → keep polling.
   - First successful response → redirect to `/login.html`.
   - 30s hard timeout → swap overlay content to a failure message + manual
     Reload button.

## Data flow

```
[Restart btn] --confirm--> [show overlay] --POST /api/restart--> [server]
                                                                    |
                                                          spawn detached child
                                                                    |
                                                          server process.exit(0)
                                                                    |
   [poll /api/auth/check every 1.5s] <--- child: stop.sh; sleep; start.sh
                    |
        first success --> window.location = '/login.html'
```

## Error handling

- Confirm cancelled → no-op.
- `POST /api/restart` fetch throws (server already dying) → ignore, proceed to
  polling phase (the goal is just to wait for the server to return).
- Each poll wrapped in try/catch; a failed request means the server is mid-restart
  → continue polling.
- 30s timeout reached without a successful poll → overlay shows failure text and a
  "Reload manual" button (`window.location.reload()`).

## Files touched

1. `restart.sh` — **new** bash script (stop → sleep → start), `chmod +x`.
2. `src/routes/authRoutes.js` — new `POST /api/restart` endpoint.
3. `public/index.html` — Restart button (Account section), `#restart-overlay`
   markup + CSS, and the JS handler (button click + polling loop).

## Testing (manual)

No test framework in this project (`package.json` `scripts` is empty), so verify
manually:

1. Login → open sidebar → Account → click Restart.
2. Confirm dialog appears → OK → "Restarting…" overlay shows.
3. In a terminal, `./status.sh` shows the server briefly down, then up again with
   a **new pid**.
4. Page auto-reloads to `/login.html` within ~2–4s.
5. Log in again → previous session history is still present (stored on disk); only
   the auth token was reset.
6. Cancel the confirm dialog → nothing changes.
