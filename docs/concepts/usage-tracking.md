---
summary: "Session usage and cost tracking surfaces"
read_when:
  - You need to explain usage/cost display behavior in /status and /usage
title: "Usage Tracking"
---

# Usage tracking

## What it is

- Tracks per-response and per-session token/cost usage from DennouAibou session
  logs.
- Session-level `/status` and `session_status` can fall back to the latest
  transcript usage entry when the live session snapshot is sparse. That
  fallback fills missing token/cache counters, can recover the active runtime
  model label, and prefers the larger prompt-oriented total when session
  metadata is missing or smaller. Existing nonzero live values still win.

## Where it shows up

- `/status` in chats: emoji-rich status card with session tokens + estimated
  cost (API key only).
- `/usage off|tokens|full` in chats: per-response usage footer (OAuth shows
  tokens only).
- `/usage cost` in chats: local cost summary aggregated from DennouAibou
  session logs.
- macOS menu bar: "Usage" section under Context (only if available).
