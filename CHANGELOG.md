# Changelog

## 1.0.0 — 2026-09-08

Initial release.

- Per-provider request pacing, persisted across Pi sessions.
- `/throttle <provider> <seconds>` to set/clear live; writes are atomic (temp + rename).
- Serialization of overlapping same-provider requests (steer/subagent overlap safe).
- Warn-once diagnostics when the config file is unreadable instead of silent fail-open.
- Data-driven `modelPrefixes` fallback for attributing requests when `ctx.model` is unavailable.
- Config resolution: `PI_PROVIDER_THROTTLE_CONFIG` env → `~/.pi/agent/provider-throttle.json` → legacy `~/.pi/agent/extensions/provider-throttle.json` (read-only).
