/**
 * provider-throttle — per-provider pacing for LLM calls, persisted across sessions.
 *
 * Different providers have very different tolerance for back-to-back traffic.
 * A shared gateway may absorb rapid calls while a rate-limited endpoint
 * (e.g. NVIDIA NIM, 40 RPM tiers) starts answering 429s almost immediately.
 * This extension lets you pace each provider independently and remembers the
 * intervals between Pi sessions.
 *
 * Pacing semantics: the gap is measured against the LATEST of the last
 * call-start stamp and the last observed assistant-response end on that
 * provider. Long streaming responses therefore insert breathing room after
 * they finish. This is pacing — it spaces outbound calls; it is not a token-
 * bucket rate limiter and does not guarantee N-rpm attainment on its own.
 *
 * Unlike npm:pi-throttle (session-only, one global knob affecting every
 * provider), this extension:
 *   - throttles ONLY the providers listed in its config,
 *   - reads intervals from a persistent JSON config file,
 *   - live-adjusts through /throttle (changes are saved atomically),
 *   - serializes overlapping same-provider requests across streaming/steer
 *     overlaps so two racing requests cannot both slip through ungated.
 *
 * Config resolution order (see configPaths):
 *   1. PI_PROVIDER_THROTTLE_CONFIG env var (absolute path; then exclusive).
 *   2. ~/.pi/agent/provider-throttle.json  (preferred default).
 *   3. ~/.pi/agent/extensions/provider-throttle.json (legacy, read-only
 *      fallback so pre-package installs keep working; writes always target
 *      the preferred default).
 *
 * Config shape:
 *   {
 *     "providers": { "nvidia_nim": 2 },            // seconds between calls; 0/absent = off
 *     "modelPrefixes": { "nvidia/": "nvidia_nim" } // optional payload fallback (see README)
 *   }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ENV_VAR = "PI_PROVIDER_THROTTLE_CONFIG";
export const STATUS_KEY = "provider-throttle";
export const MAX_TIMER_MS = 2_147_483_647;

export const PREFERRED_CONFIG_PATH = join(homedir(), ".pi", "agent", "provider-throttle.json");
export const LEGACY_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "provider-throttle.json");

export interface Config {
	providers?: Record<string, unknown>;
	modelPrefixes?: Record<string, unknown>;
}

/** Result of consulting the active config file. */
export type LoadResult =
	| { ok: true; cfg: Config; path: string }
	| { ok: false; error: unknown; path: string };

// ── Path resolution ─────────────────────────────────────────────────────

/**
 * Path pair used for reading and where writes are allowed to land.
 * With ENV_VAR set it wins exclusively in both roles.
 */
export function configPaths(env: NodeJS.ProcessEnv = process.env): { read: string; write: string } {
	const override = env[ENV_VAR];
	if (override) {
		const abs = resolve(override);
		return { read: abs, write: abs };
	}
	if (existsSync(PREFERRED_CONFIG_PATH)) {
		return { read: PREFERRED_CONFIG_PATH, write: PREFERRED_CONFIG_PATH };
	}
	return { read: LEGACY_CONFIG_PATH, write: PREFERRED_CONFIG_PATH };
}

// ── Interval normalization ──────────────────────────────────────────────

/** Positive, finite intervals only; anything malformed is treated as off (0). */
export function normalizeInterval(raw: unknown): number {
	const seconds = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function intervalFor(cfg: Config, provider: string): number {
	return normalizeInterval(cfg.providers?.[provider]);
}

// ── Provider resolution ─────────────────────────────────────────────────

/**
 * Which provider this request will hit. `ctx.model` is authoritative; the
 * config's `modelPrefixes` map is a data-driven fallback for contexts where
 * ctx.model is missing or vague (e.g. request payload built in a race with a
 * model switch). Keyed on the request payload's `model` field. Exact model
 * ids match as full keys; otherwise a prefix that models often share wins.
 * Longest matching key wins.
 */
export function resolveProvider(
	payload: unknown,
	ctx: { model?: { provider?: unknown } | undefined },
	cfg: Config,
): string | undefined {
	const fromCtx = ctx.model?.provider;
	if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;

	const requestModel = (payload as { model?: unknown } | null | undefined)?.model;
	if (typeof requestModel !== "string" || requestModel.length === 0) return undefined;

	const keys = cfg.modelPrefixes ?? {};
	// Exact key match, when present, trumps prefix matches.
	if (typeof keys[requestModel] === "string" && keys[requestModel].length > 0) {
		return keys[requestModel] as string;
	}

	let best: { len: number; provider: string } | undefined;
	for (const [key, target] of Object.entries(keys)) {
		if (typeof target !== "string" || target.length === 0) continue;
		// A zero-length key matches EVERY model ("" is a prefix of anything) —
		// that can only be a config mistake, so treat it as inert.
		if (key.length === 0) continue;
		if (!requestModel.startsWith(key)) continue;
		if (!best || key.length > best.len) best = { len: key.length, provider: target };
	}
	return best?.provider;
}

// ── Timer with abort support ────────────────────────────────────────────

/**
 * Resolve after `ms`, or immediately when the signal aborts. A swallowed
 * resolution here would wedge the before-provider handler, so abort always
 * resolves — the caller re-checks the signal and skips stamping.
 */
export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolveOut) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			resolveOut();
		};
		timer = setTimeout(
			() => {
				timer = undefined;
				resolveOut();
			},
			Math.min(ms, MAX_TIMER_MS),
		);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

// ── Store: config loader + warn-once + per-provider runtime state ─────

interface ProviderState {
	lastCallAtMs: number;
	lastAssistantAtMs: number;
}

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createThrottle(options: {
	readPath: () => string;
	writePath: string;
	notify?: NotifyFn;
}) {
	// CONFIG — re-read on demand. The file is a tiny hand-managed JSON; its
	// parse cost is noise next to the pacing gaps this extension exists to
	// enforce — so there is deliberately no mtime/bytes cache to keep
	// consistent (an earlier mtime cache served stale bytes on fast edits).
	let warnedBadFile: string | null = null;

	// RUNTIME — provider pacing state.
	const state = new Map<string, ProviderState>();
	const getProviderState = (provider: string): ProviderState => {
		let s = state.get(provider);
		if (!s) {
			s = { lastCallAtMs: 0, lastAssistantAtMs: 0 };
			state.set(provider, s);
		}
		return s;
	};

	// GATE — serialize overlapping same-provider requests. Each acquire chains
	// onto the provider's current tail and releases it on drain; the tail node
	// removes itself once nothing newer has chained behind it.
	const inFlight = new Map<string, Promise<void>>();

	const acquire = async (provider: string): Promise<() => void> => {
		const previous = inFlight.get(provider) ?? Promise.resolve();
		let release!: () => void;
		const ticket = new Promise<void>((r) => (release = r));
		const chained = previous.then(() => ticket);
		inFlight.set(provider, chained);
		void chained.then(() => {
			if (inFlight.get(provider) === chained) inFlight.delete(provider);
		});
		await previous.catch(() => undefined); // defensive: a broken link must not wedge us
		return release;
	};

	const load = (): LoadResult => {
		const path = options.readPath();
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Config;
			const cfg = sanitize(parsed);
			if (warnedBadFile === path) warnedBadFile = null; // file recovered
			return { ok: true, cfg, path };
		} catch (err) {
			if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
				if (warnedBadFile === path) warnedBadFile = null;
				return { ok: true, cfg: {}, path }; // no file = no pacing, not an error
			}
			// Parse Error, EACCES, EISDIR, ... — pace nothing, but say so ONCE
			// until the file recovers; a per-request storm of toasts helps nobody.
			if (warnedBadFile !== path) {
				warnedBadFile = path;
				options.notify?.(
					`provider-throttle: cannot parse ${path} — pacing is DISABLED until the file is fixed (${describeError(err)})`,
					"warning",
				);
			}
			return { ok: false, error: err, path };
		}
	};

	const sanitize = (parsed: Config): Config => {
		const pick = (v: unknown) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v as Record<string, unknown>))
				: undefined;
		const out: Config = {};
		const providers = pick(parsed?.providers);
		if (providers) out.providers = providers;
		const modelPrefixes = pick(parsed?.modelPrefixes);
		if (modelPrefixes) out.modelPrefixes = modelPrefixes;
		return out;
	};

	/** Human summary of providers with an active interval (status strip). */
	const featuredSummary = (cfg: Config): string =>
		Object.entries(cfg.providers ?? {})
			.map(([p, v]) => ({ p, seconds: normalizeInterval(v) }))
			.filter((e) => e.seconds > 0)
			.map((e) => `${e.p} ${e.seconds}s`)
			.join(", ");

	return {
		/** Effective interval in ms (0 = off) for a provider. */
		intervalMsFor(provider: string): number {
			const res = load();
			return res.ok ? intervalFor(res.cfg, provider) * 1000 : 0;
		},

		/** Raw view for the /throttle display. */
		view(): { cfg: Config; ok: boolean; path: string; error?: unknown } {
			const res = load();
			return res.ok
				? { cfg: res.cfg, ok: true, path: res.path }
				: { cfg: {}, ok: false, path: res.path, error: res.error };
		},

		/** Terse status-strip text; undefined when there is nothing to say. */
		statusText(): string | undefined {
			const res = load();
			if (!res.ok) return "cfg error";
			const summary = featuredSummary(res.cfg);
			return summary.length > 0 ? `paced: ${summary}` : undefined;
		},

		/** Stamp a call start for the provider (injectable now for tests). */
		recordCall(provider: string, now = Date.now()): void {
			if (provider) getProviderState(provider).lastCallAtMs = now;
		},

		/** Stamp an assistant-response end observed on the provider. */
		recordAssistant(provider: string | undefined, now = Date.now()): void {
			if (provider) getProviderState(provider).lastAssistantAtMs = now;
		},

		/**
		 * Current pacing anchor — the later of call-start and response-end.
		 * Reads must happen INSIDE the gate, right after acquiring it, so a
		 * predecessor's stamp is honoured; reading at queue-entry would race.
		 */
		anchorMs(provider: string): number {
			const ps = state.get(provider);
			if (!ps) return 0;
			return Math.max(ps.lastCallAtMs, ps.lastAssistantAtMs);
		},

		/** Serialize an async body on its provider and auto-release. */
		runGated<T>(provider: string, body: () => Promise<T>): Promise<T> {
			return acquire(provider).then(async (release) => {
				try {
					return await body();
				} finally {
					release();
				}
			});
		},

		/**
		 * Persist a config change: write to the designated path via temp+rename,
		 * preserve unrelated top-level keys, refresh the memo so the next
		 * provider call observes the new bytes immediately.
		 *
		 * Saves target the write path even while reads still resolve to the
		 * legacy file (migration tail), which is why the memo is keyed by path.
		 */
		save(mutator: (cfg: Config) => void): { ok: true } | { ok: false; attemptedPath: string; error: unknown } {
			const readRes = load();
			const base = readRes.ok ? readRes.cfg : {};
			const tmp = `${options.writePath}.${process.pid}.tmp`;
			try {
				mkdirSync(dirname(options.writePath), { recursive: true });
				const cfg: Config = { ...base, providers: { ...(base.providers ?? {}) } };
				if (base.modelPrefixes) cfg.modelPrefixes = base.modelPrefixes;
				mutator(cfg);
				writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
				renameSync(tmp, options.writePath);
				if (warnedBadFile === options.writePath) warnedBadFile = null;
				return { ok: true };
			} catch (err) {
				try {
					if (existsSync(tmp)) unlinkSync(tmp);
				} catch {
					// best effort only; the next save overwrites a leftover .tmp anyway
				}
				return { ok: false, attemptedPath: options.writePath, error: err };
			}
		},

		// Shutdown drops runtime pacing state; config reads are stateless,
		// so there is nothing else to reset.
		shutdown(): void {
			state.clear();
			warnedBadFile = null;
			for (const [provider, tail] of [...inFlight]) {
				void tail.catch(() => undefined);
				inFlight.delete(provider);
			}
		},
	};
}

// ── Wire-up ─────────────────────────────────────────────────────────────

export default function providerThrottle(pi: ExtensionAPI) {
	// io hooks until a dialog-capable context arrives (session_start/commands);
	// earlier load-time warnings get flushed there instead of black-holed.
	let uiHook: NotifyFn | undefined;
	let deferred: { message: string; type?: "info" | "warning" | "error" }[] = [];
	const notify: NotifyFn = (message, type) => {
		uiHook ? uiHook(message, type) : deferred.push({ message, type });
	};

	let writePathCache = configPaths().write;
	const store = createThrottle({
		readPath: () => {
			const { read, write } = configPaths(process.env);
			writePathCache = write;
			return read;
		},
		writePath: process.env[ENV_VAR]
			? resolve(String(process.env[ENV_VAR]))
			: PREFERRED_CONFIG_PATH,
		notify,
	});

	pi.registerCommand("throttle", {
		description:
			"Show/change persisted per-provider throttle intervals (seconds; 0 = off)",
		handler: async (args, ctx) => {
			uiHook ??= (message, type) => ctx.ui.notify(message, type);
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				const view = store.view();
				const rows = Object.entries(view.cfg.providers ?? {}).map(
					([p]) => `  ${p}: ${intervalFor(view.cfg, p)}s`,
				);
				const body = rows.length ? `\n${rows.join("\n")}` : "  (nothing configured)";
				const health = view.ok ? "" : `  [unreadable: ${describeError(view.error)}]`;
				ctx.ui.notify(
					`provider-throttle\n${body}\nread : ${view.path}${health}\nwrite: ${writePathCache}`,
					view.ok ? "info" : "warning",
				);
				return;
			}

			if (parts[0] === "config") {
				const view = store.view();
				ctx.ui.notify(
					`read : ${view.path}\nwrite: ${writePathCache}\nparse: ${view.ok ? "ok" : `FAILED (${describeError(view.error)})`}`,
					view.ok ? "info" : "warning",
				);
				return;
			}

			if (parts.length !== 2) {
				ctx.ui.notify("Usage: /throttle <provider> <seconds|0>  —  or:  /throttle config", "error");
				return;
			}

			const provider = String(parts[0]);
			const seconds = Number(parts[1]);
			if (!Number.isFinite(seconds) || seconds < 0) {
				ctx.ui.notify(`Seconds must be a number >= 0, got "${parts[1]}"`, "error");
				return;
			}

			const outcome = store.save((cfg) => {
				if (seconds > 0) cfg.providers![provider] = seconds;
				else delete cfg.providers![provider];
			});

			if (!outcome.ok) {
				ctx.ui.notify(
					`Could not save config (${outcome.attemptedPath}): ${describeError(outcome.error)}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(
				seconds > 0
					? `${provider}: min interval ${seconds}s between provider calls (persisted)`
					: `provider-throttle disabled for ${provider} (persisted)`,
				"info",
			);
		},
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const view = store.view();
		const provider = view.ok ? resolveProvider(event.payload, ctx, view.cfg) : undefined;
		if (!provider) return;

		const intervalMs = store.intervalMsFor(provider);
		if (!(intervalMs > 0)) return;

		await store.runGated(provider, async () => {
			let showingWaiting = false;
			try {
				while (!ctx.signal?.aborted) {
					const intended = store.anchorMs(provider);
					const remaining = intended === 0 ? 0 : Math.max(0, intervalMs - (Date.now() - intended));
					if (remaining === 0) break;
					if (!showingWaiting) {
						ctx.ui.setWorkingMessage(
							`...Waiting (${provider} pace ${Math.round(intervalMs / 100) / 10}s)`,
						);
						showingWaiting = true;
					}
					await delay(remaining, ctx.signal);
				}
			} finally {
				if (showingWaiting) ctx.ui.setWorkingMessage();
			}
			// An aborted call must not consume the pacing slot.
			if (ctx.signal?.aborted) return;
			store.recordCall(provider);
		});
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		store.recordAssistant(ctx.model?.provider);
	});

	pi.on("session_start", (_, ctx) => {
		uiHook ??= (message, type) => ctx.ui.notify(message, type);
		const pending = deferred.splice(0);
		const view = store.view();
		if (!view.ok) {
			ctx.ui.notify(
				`provider-throttle: cannot parse ${view.path} — pacing disabled until fixed (${describeError(view.error)})`,
				"warning",
			);
		}
		for (const n of pending) ctx.ui.notify(n.message, n.type);
		ctx.ui.setStatus(STATUS_KEY, store.statusText());
	});

	pi.on("session_shutdown", () => {
		store.shutdown();
	});
}

// Reserved for contributors: expose configPaths/save/load semantics via the
// store only — keep the runtime authoritative symbols exported above (for
// tests) and nothing mutable at module scope.
