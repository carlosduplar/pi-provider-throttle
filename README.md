# pi-provider-throttle

<div align="center">

Pace LLM requests per provider across Pi sessions — throttling, not request blasting. Keeps rate-limited endpoints (think NVIDIA NIM at 40 RPM) from throwing 429s, without slowing down providers that are perfectly happy with rapid traffic.

[![npm version](https://img.shields.io/npm/v/pi-provider-throttle.svg)](https://www.npmjs.com/package/pi-provider-throttle)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

## Why throttle?

Every LLM provider enforces a rate limit: responses per account per minute. When a provider answers with **HTTP 429 Too Many Requests**, the turn dies and the agent loop has to retry — wasted wall time and possibly a worse key reputation. This extension prevents the 429 from happening at all: each provider gets its own pacing floor, so calls aimed at tight quotas never fire back-to-back. Providers without quotas are untouched.

## Features

- **Per-provider pacing** — a separate interval per provider, not one global knob
- **Ask-pi setup** — a `provider_throttle` agent tool turns phrasing like “restrict NVIDIA to 40 RPM” into resolved, confirmed, persisted config
- **Persistent** — intervals survive session restarts; stored in a JSON config file
- **`/throttle` command** — view or change intervals live, atomic saves; the status strip reflects changes immediately
- **Streaming-aware** — the gap clocks from the latest of last call start and last assistant response end, so long streams breathe before the next shot
- **Overlap-safe** — same-provider requests arriving together (steer, subagents) are serialized, so a race cannot slip two calls through
- **Fail-safe** — an unreadable config paces nothing but tells you exactly once, instead of silently vanishing
- **Zero dependencies** — no `npm install` baggage beyond pi's own bundled modules

## Who is this for

You mix providers in one Pi setup and one of them is stricter than the rest:

- **Rate-limited tiers** — e.g. NVIDIA NIM free tiers allow 40 RPM; rapid agent loops hit 429s long before you notice. `/throttle nvidia_nim 2` and forget it.
- **Shared gateways** — an API with a friendly admin and a strict wall behind them.
- **Anything else** — everyone else keeps running at full speed.

If you never see a 429, you don't need this extension. `/throttle` with no arguments shows whether you have anything configured at all.

## Install

```bash
pi install npm:pi-provider-throttle
```

Then restart your Pi session.

## Or just ask pi

> Use pi-provider-throttle to restrict NVIDIA requests to 40 RPM

With the extension loaded, that sentence is your whole setup: the included `provider_throttle` tool resolves the provider id against your model registry, converts RPM into a safe seconds floor, and persists it (confirm first, of course). Verify with `/throttle`.

## Config

Intervals live in `~/.pi/agent/provider-throttle.json`:

```json
{
  "providers": {
    "nvidia_nim": 2
  },
  "modelPrefixes": {
    "nvidia/": "nvidia_nim"
  }
}
```

`providers` values are **seconds between calls** for that provider. `0` or an absent entry means "off".

`modelPrefixes` is optional insurance for attributing a request by the payload's `model` field when Pi cannot tell you which provider it targets (`ctx.model.provider` is authoritative and used whenever present). Longest matching key wins; exact model ids work as keys too.

Example: NVIDIA NIM at 40 RPM has a floor of 60 ÷ 40 = **1.5s between requests**; real-world traffic rarely stays perfectly serial, so `2–3s` is the comfortable zone.

### Config paths, in resolution order

1. `PI_PROVIDER_THROTTLE_CONFIG` env var — when set, that file is used exclusively (nice for testing and per-project setups).
2. `~/.pi/agent/provider-throttle.json` — preferred default.
3. `~/.pi/agent/extensions/provider-throttle.json` — legacy fallback (read-only), so installs predating the packaged extension keep working. Writes always go to the preferred path.

`/throttle config` shows which path resolved for reading and where writes land.

## Commands

| Command | Description |
| --- | --- |
| `/throttle` | Show configured providers and which config file is live |
| `/throttle nvidia_nim 2` | Set `nvidia_nim` → 2 seconds (persisted) |
| `/throttle nvidia_nim 0` | Disable throttling for `nvidia_nim` (persisted) |
| `/throttle config` | Show resolved read/write paths and parse health |
| `provider_throttle` (agent tool) | Ask the model in-session: `list` shows registered providers and active pacing; `set` resolves a name like “NVIDIA” against the registry and applies an rpm-derived or exact seconds floor |

## Behavior notes

- **Gap measurement** — after a response ends on the provider, the next call waits until `interval` has elapsed from whichever came last: the previous call start or that response end. This is pacing, not a token-bucket rate limiter — it spaces shots, it does not immunize you from firing across restarts or from other tools sharing your API key.
- **Overlaps** — two same-provider requests mid-stream serialize behind a per-provider gate with each paying only its own residual wait.
- **Aborted requests** (you pressed Esc) do not consume the pacing slot.
- **Failures** — if the config file cannot be parsed (hand-edit typo, torn write), pacing is disabled and one warning tells you the path and the reason. It stays quiet until the file parses again.
- **Atomic saves** — `/throttle` writes via temp file + rename, so a crash mid-save cannot leave a half-written JSON.
- **No destructive recovery** — while the config file is unreadable, `/throttle <provider> <seconds>` refuses to save instead of silently flattening your hand-edited near-miss content. Fix or delete the file (see Troubleshooting), and saves resume.
- **Per-process clocks** — two Pi instances in parallel windows keep separate pacing against the same provider. That is a documented limitation, not a bug.

## Troubleshooting

**Warnings about not parsing config:** `/throttle config` prints the exact path and parse error. Hand-edited JSON is the usual culprit. While the file is unreadable, saves are refused rather than overwriting it, so the content is still on disk when you fix the typo.

**Still seeing 429s:** honest diagnosis: pacing inserts clearance between Pi's own calls on that provider. Nothing here throttles other processes on the same API key; and if you restart Pi and leave its previous window mid-stream, the fresh session does not inherit its clock.

**Config not taking effect:** `/throttle` (no arguments) shows which file is live and the write path next saves go to.

## License

MIT
