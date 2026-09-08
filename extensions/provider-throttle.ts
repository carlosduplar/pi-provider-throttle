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
import { Type } from "typebox";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ENV_VAR = "PI_PROVIDER_THROTTLE_CONFIG";
export const STATUS_KEY = "provider-throttle";
export const MAX_TIMER_MS = 2_147_483_647;

export const PREFERRED_CONFIG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"provider-throttle.json",
);
export const LEGACY_CONFIG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"extensions",
	"provider-throttle.json",
);

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
export function configPaths(env: NodeJS.ProcessEnv = process.env): {
	read: string;
	write: string;
} {
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

	const requestModel = (payload as { model?: unknown } | null | undefined)
		?.model;
	if (typeof requestModel !== "string" || requestModel.length === 0)
		return undefined;

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
		if (!best || key.length > best.len)
			best = { len: key.length, provider: target };
	}
	return best?.provider;
}

// ── Natural-language pacing helpers (custom tool) ────────────────────

/**
 * RPM → a comfortably rounded seconds floor: 60/rpm, one +25% notch, rounded
 * to the nearest 0.5s (bounded at 0.5s min so absurd rates still pace).
 * Undefined unless `rpm` is a usable positive number.
 */
export function secondsFromRpm(rpm: unknown): number | undefined {
	const rate = typeof rpm === "number" ? rpm : Number(rpm);
	if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) return undefined;
	return Math.max(0.5, Math.round((60 / rate) * 1.25 * 2) / 2);
}

export type HintMatch =
	| { kind: "unique"; id: string }
	| { kind: "ambiguous"; ids: string[] }
	| { kind: "none" };

/**
 * Resolve a human provider hint ("NVIDIA", "nvidia nim", ...) against the
 * registered-catalogue entries. Tiered scoring: exact id/display (case-
 * insensitive) beats prefix match beats containment; ties inside the winning
 * tier are ambiguous. No match at all is "none".
 */
export function matchProviderHint(
	hint: string,
	providers: readonly { readonly id: string; readonly display: string }[],
): HintMatch {
	const q = hint.trim().toLowerCase();
	if (!q) return { kind: "none" };

	const score = (entry: { id: string; display: string }): number => {
		const id = entry.id.toLowerCase();
		const display = entry.display.toLowerCase();
		if (id === q || display === q) return 3;
		if (id.startsWith(q) || display.startsWith(q)) return 2;
		if (id.includes(q) || display.includes(q)) return 1;
		return 0;
	};

	let best = 0;
	const winners: string[] = [];
	for (const entry of providers) {
		const s = score(entry);
		if (s === 0) continue;
		if (s > best) {
			best = s;
			winners.length = 0;
		}
		if (s === best) winners.push(entry.id);
	}
	if (best === 0) return { kind: "none" };
	return winners.length === 1
		? { kind: "unique", id: winners[0]! }
		: { kind: "ambiguous", ids: winners };
}

/**
 * Union of provider ids a session can actually call. Store-scoped models
 * (user's models-store.json) surface via registry.getAll(); native agents
 * register eagerly and appear only in getRegisteredProviderIds() — building
 * the catalogue from either alone misreports known candidates (observed:
 * a session whose entire known list was `llama.cpp` while NVIDIA models
 * sat in the store). First occurrence wins; junk rows are skipped.
 */
export function buildCatalog(
	models: readonly { readonly provider?: unknown }[],
	registeredIds: readonly string[],
	displayNameFor: (id: string) => string,
): { id: string; display: string }[] {
	const byId = new Map<string, string>();
	const add = (id: unknown) => {
		if (typeof id !== "string" || !id) return;
		if (!byId.has(id)) byId.set(id, displayNameFor(id) || id);
	};
	for (const m of models) add(m?.provider);
	for (const id of registeredIds) add(id);
	return [...byId].map(([id, display]) => ({ id, display }));
}

// ── Timer with abort support ────────────────────────────────────────────

/**
 * Resolve after `ms`, or immediately when the signal aborts. A swallowed
 * resolution here would wedge the before-provider handler, so abort always
 * resolves — the caller re-checks the signal and skips stamping.
 */
export function delay(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<void> {
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
				// Normal completion must detach the abort listener: a long-lived signal
				// would otherwise accumulate one stale listener per paced call.
				signal?.removeEventListener("abort", abort);
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

export type NotifyFn = (
	message: string,
	type?: "info" | "warning" | "error",
) => void;

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
		save(
			mutator: (cfg: Config) => void,
		): { ok: true } | { ok: false; attemptedPath: string; error: unknown } {
			const readRes = load();
			// Never clobber an unreadable SAVE TARGET: the outage warning told the
			// user to fix exactly that file, so flattening it here would destroy
			// their hand-edited near-miss content. (A read failure on a different
			// path — e.g. a corrupt legacy file while the preferred default is
			// missing — still heals by writing a fresh, clean target.)
			if (!readRes.ok && readRes.path === options.writePath) {
				return {
					ok: false,
					attemptedPath: options.writePath,
					error: new Error(
						`refusing to save over unreadable ${options.writePath} (${describeError(readRes.error)}) — fix or delete the file first`,
					),
				};
			}
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
	const deferred: { message: string; type?: "info" | "warning" | "error" }[] =
		[];
	const notify: NotifyFn = (message, type) => {
		if (uiHook) {
			uiHook(message, type);
		} else {
			deferred.push({ message, type });
		}
	};

	// The write target is invariant for the process (env override, else the
	// preferred default), so derive it from configPaths — the rule lives once.
	const writePath = configPaths(process.env).write;
	const store = createThrottle({
		readPath: () => configPaths(process.env).read,
		writePath,
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
				const body = rows.length
					? `\n${rows.join("\n")}`
					: "  (nothing configured)";
				const health = view.ok
					? ""
					: `  [unreadable: ${describeError(view.error)}]`;
				ctx.ui.notify(
					`provider-throttle\n${body}\nread : ${view.path}${health}\nwrite: ${writePath}`,
					view.ok ? "info" : "warning",
				);
				return;
			}

			if (parts[0] === "config") {
				const view = store.view();
				ctx.ui.notify(
					`read : ${view.path}\nwrite: ${writePath}\nparse: ${view.ok ? "ok" : `FAILED (${describeError(view.error)})`}`,
					view.ok ? "info" : "warning",
				);
				return;
			}

			if (parts.length !== 2) {
				ctx.ui.notify(
					"Usage: /throttle <provider> <seconds|0>  —  or:  /throttle config",
					"error",
				);
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
			// Live edits must reach the status strip now, not at next session_start.
			ctx.ui.setStatus(STATUS_KEY, store.statusText());
			ctx.ui.notify(
				seconds > 0
					? `${provider}: min interval ${seconds}s between provider calls (persisted)`
					: `provider-throttle disabled for ${provider} (persisted)`,
				"info",
			);
		},
	});

	// ── provider_throttle custom tool ─────────────────────────────────────
	// Lets a session say "restrict NVIDIA to 40 RPM". Free-text hints resolve
	// against pi's live model registry before any write; rates arrive as rpm
	// (floored conservatively) or explicit seconds; persistence reuses the
	// same atomic, refuse-on-corrupt save() the /throttle command uses.
	pi.registerTool({
		name: "provider_throttle",
		label: "Provider throttle",
		description:
			'Read or change provider-throttle pacing (seconds between calls). `set` resolves a free-text provider hint (e.g. "NVIDIA") against pi\'s model registry before writing; rates are given as rpm or as exact seconds.',
		promptSnippet:
			'Configure provider pacing from phrasing like "restrict NVIDIA to 40 RPM" — resolves provider ids from the model registry',
		promptGuidelines: [
			"Prefer provider_throttle over editing provider-throttle.json by hand; resolve unknown provider hints with `list` rather than guessing an id.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("set")], {
				description:
					'"list" shows registered providers and active pacing; "set" changes one provider\'s interval',
			}),
			provider: Type.Optional(
				Type.String({
					description:
						'Provider as the user names it ("NVIDIA", "nim free tier", or the exact provider id)',
				}),
			),
			rpm: Type.Optional(
				Type.Number({
					description: "Requests-per-minute ceiling to pace to (e.g. 40)",
				}),
			),
			seconds: Type.Optional(
				Type.Number({
					description:
						"Exact seconds between calls; overrides rpm when both are given; 0 disables pacing",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let catalog: { id: string; display: string }[] = [];
			try {
				const registry = ctx.modelRegistry;
				const models =
					typeof registry.getAll === "function"
						? registry.getAll()
						: []; // older hosts: registered ids remain authoritative
				catalog = buildCatalog(
					models,
					registry.getRegisteredProviderIds(),
					(id) => registry.getProviderDisplayName(id) || id,
				);
			} catch {
				// Degraded registry read: explicit provider ids still work.
			}

			if (params.action !== "set") {
				const view = store.view();
				const health = view.ok ? "" : "  [config unreadable]";
				const lines = catalog.map(({ id, display }) => {
					const seconds = intervalFor(view.cfg, id);
					return `- ${id} (${display}): ${seconds > 0 ? `${seconds}s` : "off"}${health}`;
				});
				const body = lines.length
					? `providers\n${lines.join("\n")}\nwrite path: ${writePath}`
					: `no providers registered in this session\nwrite path: ${writePath}`;
				return {
					content: [
						{
							type: "text",
							text: body,
						},
					],
					details: {},
				};
			}

			const hint = (params.provider ?? "").trim();
			let seconds: number | undefined;
			let viaRpm = false;
			if (
				typeof params.seconds === "number" &&
				Number.isFinite(params.seconds) &&
				params.seconds >= 0
			) {
				seconds = normalizeInterval(params.seconds); // 0 authored here → disable
			} else if (
				typeof params.rpm === "number" &&
				Number.isFinite(params.rpm) &&
				params.rpm > 0
			) {
				seconds = secondsFromRpm(params.rpm);
				viaRpm = seconds !== undefined;
			}
			if (!hint || seconds === undefined) {
				return {
					content: [
						{
							type: "text",
							text:
								'Usage: provider_throttle { action: "set", provider: "NVIDIA", rpm: 40 } — or give seconds instead; seconds: 0 disables pacing.',
						},
					],
					details: {},
				};
			}

			const match = matchProviderHint(hint, catalog);
			if (match.kind === "none" || match.kind === "ambiguous") {
				const known = catalog.length
					? `Known: ${catalog.map((c) => c.id).join(", ")}`
					: "No providers are registered in this session.";
				const text =
					match.kind === "none"
						? `No provider resembles "${hint}". ${known}`
						: `"${hint}" is a prefix of several providers: ${match.ids.join(", ")}. Ask the user which one, then call again.`;
				return { content: [{ type: "text", text }], details: {} };
			}
			const providerId = match.id;

			// Writes leave this session: one user-confirmed gate before persisting.
			if (ctx.hasUI) {
				const approved = await ctx.ui.confirm(
					"provider-throttle",
					`Pace "${providerId}" at ${seconds}s minimum interval${viaRpm ? ` (floor for ${params.rpm} RPM)` : ""}? Persisted to ${writePath}`,
				);
				if (!approved) {
					return {
						content: [
							{ type: "text", text: `Declined — "${providerId}" config untouched.` },
						],
						details: { applied: false, provider: providerId },
					};
				}
			}

			const outcome = store.save((cfg) => {
				cfg.providers ??= {};
				const table = cfg.providers;
				if (seconds > 0) table[providerId] = seconds;
				else delete table[providerId];
			});
			if (!outcome.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Could not persist (${outcome.attemptedPath}): ${describeError(outcome.error)}`,
						},
					],
					details: { applied: false, provider: providerId },
				};
			}

			ctx.ui.setStatus(STATUS_KEY, store.statusText());
			ctx.ui.notify(
				seconds > 0
					? `${providerId}: min interval ${seconds}s between provider calls (persisted)`
					: `provider-throttle disabled for ${providerId} (persisted)`,
				"info",
			);
			return {
				content: [
					{
						type: "text",
						text:
							seconds > 0
								? `${providerId} now paced: at least ${seconds}s between calls${viaRpm ? ` (floor for ${params.rpm} RPM)` : ""}. Check /throttle.`
								: `Pacing disabled for ${providerId}. Check /throttle.`,
					},
				],
				details: { applied: true, provider: providerId, seconds },
			};
		},
	});

	pi.on("before_provider_request", async (event, ctx) => {
		// One load serves both attribution and the interval lookup: the same
		// bytes decide both, so a mid-flight config edit cannot split them.
		const view = store.view();
		if (!view.ok) return;

		const provider = resolveProvider(event.payload, ctx, view.cfg);
		if (!provider) return;

		const intervalMs = intervalFor(view.cfg, provider) * 1000;
		if (!(intervalMs > 0)) return;

		await store.runGated(provider, async () => {
			let showingWaiting = false;
			try {
				while (!ctx.signal?.aborted) {
					const intended = store.anchorMs(provider);
					const remaining =
						intended === 0 ? 0 : Math.max(0, intervalMs - (Date.now() - intended));
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

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		// The finished message names its own provider — response-end stamps stay
		// symmetric with request gating even if ctx.model rotated mid-stream.
		store.recordAssistant(message.provider);
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
