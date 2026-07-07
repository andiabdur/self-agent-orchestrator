# Powerful Search — Design

Date: 2026-07-07 · Branch: `fitur/search`

## Goal

1. Move "search inside conversations" (content search) out of the sidebar into a
   full **search page in the body** — bigger, richer, more powerful.
2. The **sidebar search becomes session-title-only** (find a session fast).
3. Content-search results are **sorted by most recent conversation first**
   (`last_used_at` desc), not by hit count.
4. Timestamps become clearer: recent sessions keep relative time ("5m ago"),
   older ones show **absolute date + clock** ("2 Jul 14:26", plus year when
   it differs from the current year).

## Current state

- `public/index.html` (single-file frontend): sidebar search input
  `#session-search` with a `#btn-search-mode` toggle that switches between
  title filtering and content search rendered as snippets inside the sidebar.
- `GET /api/sessions/search` (`src/routes/sessionRoutes.js`): single-phrase,
  case-insensitive scan of every session `.jsonl`, returns max 3 snippets per
  session, sorted by hitCount, capped at 20 sessions.
- Session events carry no per-event timestamp; only session-level
  `last_used_at` exists.

## Design

### Backend — upgrade `GET /api/sessions/search`

- **Multi-word AND search**: split query on whitespace into terms; a session
  matches only if *every* term appears somewhere in its user/assistant text.
  Snippets are built around each term occurrence (all terms highlighted).
- Keep the `\x00` highlight-marker protocol (frontend converts to `<mark>`).
- Return per session: `id, title, cwd, last_used_at, snippets (≤5), hitCount`.
- **Sort by `last_used_at` desc** (newest conversation first). Cap 50.
- Single-phrase queries behave as before (one term).

### Frontend — search page in the body

- New full-body overlay `#search-panel` (same pattern as `#git-panel`, but
  covering the main area): header with a large autofocused search input +
  close button, scrollable results list.
- Opened via a new **magnifier button in the header** and **Cmd/Ctrl+K**.
  Esc or ✕ closes. Query is debounced 300 ms.
- Result card per session: title, absolute/relative time, short cwd, hit
  count badge, up to 5 highlighted snippets.
- Clicking a card loads the session (existing `load_session` ws message) and
  **scrolls to + flash-highlights the first message bubble containing the
  query** after replay.

### Sidebar — sessions only

- Remove `#btn-search-mode` and all `contentSearchMode` state/rendering from
  the sidebar. `#session-search` filters by title only.
- Placeholder stays "Search sessions…".

### Timestamps — `formatWhen(ts)`

- `<60s` → "just now"; `<1h` → "Xm ago"; `<24h` → "Xh ago";
- `<7d` → "Xd ago";
- otherwise → "2 Jul 14:26" (add " 2025" when the year differs).
- Used in the sidebar session meta and in search-result cards.

## Error handling

- Search fetch failure → inline "Search failed" message in the panel.
- Sessions whose `.jsonl` is missing/corrupt are skipped (existing behavior).
- Query under 2 chars → empty state with hint text.

## Testing

- Manual: run server, verify sidebar filters titles only; open search page
  via header button and Cmd+K; multi-word query returns sessions sorted
  newest-first with highlighted snippets; clicking a result opens the session
  and scrolls to the match; old sessions show absolute date+time.
