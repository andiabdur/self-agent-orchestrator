# Git Panel (Right Sidebar) — Design Specification

**Date:** 2026-06-21
**Status:** Approved (option A, read-only)

## Goal

Add a right-side slide-in panel that shows the git state of the **active workload**
(the current working directory / `cwd` of the selected session). The panel lets the
user see, without leaving the chat UI:

- Whether the active `cwd` is a git repository, and which **branch** is checked out.
- The list of **changed files** with per-file diff stats (`+21 -2` style).
- The **diff** of any changed file, expanded inline within the panel.

This is **read-only** in v1 — no stage/commit/branch-switch/pull/push. Those can be
layered on later without reworking the panel.

## Scope (v1)

In scope:
- Detect git repo at `cwd`; show repo state or a clean "not a git repository" message.
- Current branch name (+ ahead/behind is **out of scope** for v1).
- Changed files (staged + unstaged + untracked), each with insertions/deletions counts.
- Inline unified diff per file when clicked.
- Manual refresh button + auto-refresh when `cwd`/session changes.

Out of scope (future):
- Any write action (stage, unstage, commit, discard, branch switch, pull, push, stash).
- Remote/ahead-behind tracking, commit history, blame.

## Architecture

### Backend — `server.js`

One new authenticated REST endpoint that shells out to `git` via the existing
`spawn` import. A small `runGit(cwd, args)` helper wraps `spawn` and returns
`{ code, stdout, stderr }` (promise-based), with the **`cwd` confined to the user's
home directory** — same containment rule already used by `/api/file` and
`/api/download` (resolve realpath, must start with `realBase + path.sep`).

- `GET /api/git/status?cwd=<dir>` → returns:
  ```json
  {
    "isRepo": true,
    "branch": "main",
    "files": [
      { "path": "server.js", "status": "M", "staged": false,
        "insertions": 21, "deletions": 2, "untracked": false }
    ]
  }
  ```
  - `isRepo:false` (with HTTP 200) when `git rev-parse --is-inside-work-tree` fails —
    the UI treats this as a normal "not a repo" state, not an error.
  - Branch via `git rev-parse --abbrev-ref HEAD` (`HEAD` when detached → show short SHA).
  - File list built from `git status --porcelain=v1` (covers staged, unstaged,
    untracked, renames).
  - Per-file stats from `git diff --numstat` (unstaged) and
    `git diff --cached --numstat` (staged), merged by path. Untracked files: count
    every line as an insertion (`wc -l`-style by reading the file), `-` shown when
    binary/unreadable.

- `GET /api/git/diff?cwd=<dir>&path=<file>&staged=0|1` → returns:
  ```json
  { "diff": "<unified diff text>", "binary": false }
  ```
  - Uses `git diff [--cached] -- <path>` for tracked files; for untracked files,
    `git diff --no-index /dev/null <path>` so the UI still gets a green-add diff.
  - Path confined to home dir and additionally must resolve inside `cwd`.

Both endpoints guard with `isAuthenticated(req)` and return `{ error }` with the
appropriate status on failure, matching existing endpoints. `git` invocations use a
short timeout and a bounded output buffer to avoid hangs on huge diffs.

### Frontend — `public/index.html`

A new right panel mirroring the existing left `#sidebar` slide-in pattern:

- **Markup:** `<aside id="git-panel">` + `#git-panel-bg` backdrop, with a header
  ("Git" title + refresh + close buttons), a body containing: branch row, changed-files
  list, and an empty/clean/not-a-repo state.
- **Toggle:** a new header button `#btn-git` (git-branch icon) next to `#btn-terminal`,
  opens/closes the panel. Reuses the same open/close/backdrop CSS conventions as the
  left sidebar (no pinning in v1).
- **State:** `state.git = { open, cwd, branch, files, loading, expanded }`.
- **Data flow:** a `refreshGit(cwd)` function calls `/api/git/status`, renders the
  branch + file list. It is invoked from the same three places `refreshFileList` already
  runs — the `hello`, `session_loaded`, and `cwd_set` handlers — so the panel always
  reflects the active workload. Refresh also runs when the panel is opened.
- **File row:** name (with dir prefix muted), a status badge (M/A/D/R/U/?), and a
  `+N -M` stat with green/red coloring. Clicking a row toggles an inline diff: lazy
  `GET /api/git/diff`, rendered as a unified diff with per-line add/remove/context
  coloring (HTML-escaped). Re-clicking collapses it.
- **States:** loading spinner; "Not a git repository" when `isRepo:false`; "No changes"
  (working tree clean) when repo has zero changed files.

## Error Handling

- Network/endpoint error → inline error line in panel body with the message; refresh
  button stays available.
- `git` missing on host → backend returns `isRepo:false` (rev-parse fails to spawn);
  UI shows the not-a-repo state. Acceptable for v1.
- Large diffs → backend caps output buffer; UI shows truncation note if capped.

## Testing

- **Backend:** manual curl against a known repo cwd (this project) and a non-repo cwd
  (e.g. `/tmp`); confirm `isRepo`, branch, file stats, and diff text. Verify path
  containment rejects `cwd` outside home (403) and traversal attempts.
- **Frontend:** open panel on a dirty repo → branch + files + stats render; click a file
  → diff expands with correct coloring; switch session/cwd → panel updates; open on a
  clean repo and a non-repo dir → correct empty states.

## Reuse / Patterns Followed

- Backend: existing REST + `isAuthenticated` + home-dir realpath containment.
- Frontend: existing `#sidebar` slide-in (markup/CSS/open-close), `refreshFileList`
  refresh hook points, `escapeHtml`, and `shortCwd` helpers.
