# Git Panel (Right Sidebar) — Design Specification

**Date:** 2026-06-21
**Status:** Approved (option A, read-only with review panel redesign & line numbers)

## Goal

Add a right-side slide-in panel (pushes chat content like `#viewer`, resizable, saved width) that shows the git state of the **active workload** (the current working directory / `cwd` of the selected session) in a polished review layout:

- Switch between **Git changes** (all working tree changes) and **Last turn changes** (only files modified by the AI in its last step).
- File rows showing status labels (Added, Modified, Deleted) and stats (+N -M).
- Unified diff with **line numbers** in the gutters, toggle-able, and expand/collapse all controls.

## Scope (v1)

In scope:
- Detect git repo at `cwd`; show repo state or a clean "not a git repository" message.
- Git Changes view + Last Turn Changes view.
- Pinned & resizable right sidebar review panel pushing the main workspace.
- Clear file list indicating Added/Modified/Deleted status text with stats.
- Expand / Collapse all files, toggle between Unified/Split (UI placeholder for Split, default Unified).
- Unified diff with custom gutter rendering for line numbers.

## Architecture

### Backend — `server.js`

1. `GET /api/git/status?cwd=<dir>` → returns:
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

2. `GET /api/git/last-turn?cwd=<dir>&sessionId=<sessionId>` → returns:
  ```json
  {
    "isRepo": true,
    "files": [
      { "path": "server.js", "status": "M", "staged": false,
        "insertions": 21, "deletions": 2, "untracked": false }
    ]
  }
  ```
  - Parses `/Users/andi/.self-agent-orchestrator/sessions/<sessionId>.jsonl` to locate the last `turn_start` event.
  - Scan `tool_start` calls after this `turn_start` to find files edited by `Write`, `Edit`, or `NotebookEdit`.
  - Filter these files to make sure they resolve within `cwd` and returns them in the standard file status format.

3. `GET /api/git/diff?cwd=<dir>&path=<file>&staged=0|1` → returns:
  ```json
  { "diff": "<unified diff text>", "binary": false }
  ```

### Frontend — `public/index.html`

- **Review Panel Markup:**
  Header displaying "Review" with the active session ID prefix, a dropdown selector (`Git changes` / `Last turn changes`), pill toggle buttons (`Unified` / `Split`), and an `Expand/Collapse all` button.
- **Diff Line Number Parser:**
  Frontend parses the diff string block and tracks `oldLine` and `newLine` count offset from the `@@ -old,len +new,len @@` header. Renders `.git-diff-line` as:
  `<div class="git-diff-line [add|del|hunk|meta]"><span class="ln-old">N</span><span class="ln-new">M</span><span class="line-code">Code content</span></div>`
- **Expand/Collapse All:**
  Toggles classes on all files list and triggers lazy diff fetches.

