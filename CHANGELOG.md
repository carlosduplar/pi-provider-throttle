# Changelog

## 1.1.2 — 2026-11-25

- Fix: `session_start` no longer emits a second outage notice for an unreadable config — `load()` already warns once through the notify hook, so the duplicate (with mismatched case) is gone.
- Fix: `save()` preserves unrelated top-level config keys (e.g. $schema, future options) instead of silently deleting them; `sanitize()` now carries unknown keys through verbatim.
- Fix: `provider_throttle` tool isolates each registry source (`getAll()`, `getRegisteredProviderIds()`, per-id display-name lookups) so one throwing getter no longer empties the whole catalog; an empty catalog falls back to trusting the explicit id verbatim.
- Tests: delay abort tests now prove the abort path resolved (signal-aborted + lower-bound timing) instead of passing via timer overflow; the e2e abort-mid-wait test actually aborts and asserts the shortcut.

## 1.1.1 — 2026-09-08

- Fix: `provider_throttle` builds its provider catalogue from every model visible to the session — `registry.getAll()` unioned with `getRegisteredProviderIds()` — so store-scoped providers (e.g. NVIDIA configured via `models-store.json`) resolve to their exact id instead of bouncing with `Known: llama.cpp`. Reads degrade to registered ids on hosts without `getAll()`; unit + e2e coverage pins the union, dedupe, and failure-skip behavior.

## 1.1.0 — 2026-09-08

- Added: `provider_throttle` agent tool (registerTool) — say `restrict NVIDIA requests to 40 RPM`: free-text provider hints resolve against pi's live model registry (never guessed), rpm converts to a conservative seconds floor, and writes are confirm-gated and routed through the same refusing/atomic save() as `/throttle`. `action: "list"` reports every registered provider with its current pacing.
- Docs: SEO tuning across README/npm metadata (throttling / rate limit / 429 / NVIDIA free tier wording), new “Or just ask pi” onboarding section.
- Fix: `delay` now detaches its abort listener on normal completion, so long-lived signals no longer accumulate stale listeners (and Node's MaxListeners warning) across paced calls.
- Fix: `/throttle <provider> <seconds>` refuses to save while the write-target config file is unreadable, instead of silently flattening the user's hand-edited content. A corrupt legacy read path still heals by writing a fresh preferred file.
- Fix: successful live edits refresh the status strip immediately instead of waiting for the next `session_start`.
- Fix: assistant response-end stamps use the finished message's own `provider` field, keeping streaming-aware pacing symmetric with request gating even when `ctx.model` rotated mid-stream.
- Refactor: each provider request reads the config once (attribution and interval now derive from the same load); the write path is derived from a single `configPaths()` call. `ThrottleStore.intervalMsFor()` was removed in the process — compute intervals from `view().cfg` via `intervalFor()`.
- Chore: `prepublishOnly` gate (typecheck + tests) added; regression tests cover listener hygiene, refused saves, status refresh, and response-end anchors.

## 1.0.0 — 2026-09-08

Initial release.

- Per-provider request pacing, persisted across Pi sessions.
- `/throttle <provider> <seconds>` to set/clear live; writes are atomic (temp + rename).
- Serialization of overlapping same-provider requests (steer/subagent overlap safe).
- Warn-once diagnostics when the config file is unreadable instead of silent fail-open.
- Data-driven `modelPrefixes` fallback for attributing requests when `ctx.model` is unavailable.
- Config resolution: `PI_PROVIDER_THROTTLE_CONFIG` env → `~/.pi/agent/provider-throttle.json` → legacy `~/.pi/agent/extensions/provider-throttle.json` (read-only).
