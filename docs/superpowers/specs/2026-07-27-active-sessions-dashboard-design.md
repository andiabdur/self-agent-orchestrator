# Active Sessions Dashboard

**Date:** 2026-07-27
**Status:** Approved

## Overview

A dedicated `/dashboard` page that displays currently running/active sessions in a card grid layout. Shows session title, tokens used, engine, and model — simple and informative at a glance.

## Route & Navigation

- Separate page at `/dashboard`
- New button in the header bar (dashboard/grid icon) linking to `/dashboard`
- Uses existing auth middleware (redirects to `/login` if unauthenticated)
- Header on dashboard page has a back button to return to chat (`/`)

## Layout

- Responsive card grid using CSS `auto-fit` with `minmax(320px, 1fr)`
- Single column on mobile, 2–3 columns on wider screens
- Empty state when no sessions are active: icon + "No active sessions" message

## Card Content

Each card represents one active (currently running) session and shows:

| Field | Source | Format |
|---|---|---|
| Session title | `session.title` | Text, fallback "Untitled" |
| Engine badge | `session.engine` | Colored badge: Claude (blue), Qwen (purple), Codex (green), Kilo (orange) |
| Model | `session.model` | Human label, e.g. "Opus 4.8", "Sonnet 4.6" |
| Tokens used | `turn_complete.input_tokens + output_tokens` | Formatted: "12.5k tokens" |
| Run duration | Computed from turn start | Live timer (mm:ss), updates every second |
| Status indicator | Active run state | Pulsing green dot |

## Data Flow

### Backend Changes

1. **New API endpoint `GET /api/active-runs`** — returns list of currently running sessions with their metadata. Sources data from the `activeRuns` Map in `agentWs.js`.

Response shape:
```json
[
  {
    "sessionId": "abc-123",
    "title": "Fix auth bug",
    "engine": "claude",
    "model": "sonnet",
    "startedAt": 1721234567890,
    "inputTokens": 5000,
    "outputTokens": 1200
  }
]
```

2. **WebSocket events on `/ws`** — the dashboard connects via WebSocket and listens for `turn_start` and `turn_complete` events to update cards in real-time (add/remove cards as sessions start/stop).

### Frontend

- `dashboard.html` — standalone HTML page, self-contained (CSS + JS inline), same pattern as `login.html` and `index.html`
- On load: fetch `GET /api/active-runs` to populate initial cards
- Open WebSocket to `/ws` for real-time updates
- Live timer per card via `setInterval` (1s tick)
- Auto-refresh cards when a session starts or completes

## Styling

- Uses the same CSS custom property theme system as `index.html`
- Inherits theme preference from localStorage (same key used by main app)
- Font: IBM Plex Sans / IBM Plex Mono (same Google Fonts import)
- Card style: subtle border, rounded corners, consistent with existing UI panels

## Scope

- No analytics, no historical data, no graphs
- Only shows sessions that are actively running right now
- Clicking a card could navigate to that session in the main chat (nice-to-have, not required)
