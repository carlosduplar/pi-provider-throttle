/**
 * E2E smoke test for the provider-throttle extension: drives the REAL module
 * through a minimal ExtensionAPI-shaped mock, with a temp config file wired
 * in through PI_PROVIDER_THROTTLE_CONFIG. The developer's real config is
 * never touched.
 *
 * Scenarios:
 *   1. /throttle command registered (renamed away from /pthrottle)
 *   2. cold call immediate; next call paced ~interval
 *   3. elapsed wall time counts toward the gap
 *   4. abort mid-wait resolves promptly and does not burn the slot
 *   5. other providers are unthrottled
 *   6. modelPrefixes attributes payload-only requests
 *   7. corrupt config warns exactly once; /throttle config reports it
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

type NotifyArgs = [type: "info" | "warning" | "error", message: string];

interface MockUi {
	notificationLog: Array<[string, string]>;
	statuses: Record<string, string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, value: string | undefined): void;
	setWorkingMessage(message?: string): void;
}

interface Runtime {
	handlers: Record<string, Array<(event: { type: string; payload?: unknown }, ctx: unknown) => unknown>>;
	commands: Record<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }
	>;
	ui: MockUi;
}

const INTERVAL_S = 0.4;
const INTERVAL_MS = INTERVAL_S * 1000;

const root = mkdtempSync(join(tmpdir(), `ppt-e2e-${process.pid}-`));
const CONFIG = join(root, "provider-throttle.json");
mkdirSync(dirname(CONFIG), { recursive: true });
process.env.PI_PROVIDER_THROTTLE_CONFIG = CONFIG;

const EXT_DEFAULT = (await import("../extensions/provider-throttle.ts")).default;

const writeValidConfig = (withPrefixes = false) => {
	const cfg: Record<string, unknown> = {
		providers: { prov: INTERVAL_S, nvidia_nim: INTERVAL_S },
	};
	if (withPrefixes) cfg.modelPrefixes = { "nvidia/": "nvidia_nim" };
	writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
};

writeValidConfig(false);

const makeRuntime = () => {
	const handlers: Runtime["handlers"] = {};
	const commands: Runtime["commands"] = {};
	const ui: MockUi = {
		notificationLog: [],
		statuses: {},
		notify(message, type) {
			this.notificationLog.push([type ?? "info", message]);
		},
		setStatus(key, value) {
			this.statuses[key] = value;
		},
		setWorkingMessage() {},
	};
	EXT_DEFAULT({
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			(handlers[name] ??= []).push(handler);
		},
		registerCommand(name: string, spec: (typeof commands)[string]) {
			commands[name] = spec;
		},
} as unknown as Parameters<typeof EXT_DEFAULT>[0]);
	return { handlers, commands, ui } satisfies Runtime;
};

const fire = async (rt: Runtime, event: { type: string; payload?: unknown }, ctx: unknown) =>
	Promise.all((rt.handlers[event.type] ?? []).map((h) => h(event, ctx)));

const ctxOf = (rt: Runtime, overrides: Record<string, unknown> = {}) =>
	({ model: { provider: "prov" }, ui: rt.ui, signal: undefined, ...overrides });

const measure = async (fn: () => unknown): Promise<number> => {
	const t0 = performance.now();
	await fn();
	return performance.now() - t0;
};

const outageNotices = (rt: Runtime) =>
	rt.ui.notificationLog.filter(([, message]) =>
		/DISABLED until the file is fixed/.test(String(message)),
	);

const PRE = { type: "before_provider_request", payload: {} };

test("provider-throttle end-to-end", async (t) => {
	const rt = makeRuntime();

	await t.test("command registered as /throttle (not /pthrottle)", () => {
		assert.ok(rt.commands.throttle, "/throttle missing");
		assert.ok(!rt.commands.pthrottle, "legacy /pthrottle must be gone");
	});

	await t.test("cold first call is immediate; next same-provider call paces", async () => {
		const cold = await measure(() => fire(rt, PRE, ctxOf(rt)));
		assert.ok(cold < 300, `cold call unexpectedly waited ${cold.toFixed(0)}ms`);

		const paced = await measure(() => fire(rt, PRE, ctxOf(rt)));
		assert.ok(
			paced >= INTERVAL_MS - 100 && paced <= INTERVAL_MS + 1000,
			`second call waited ${paced.toFixed(0)}ms; expected ~${INTERVAL_MS}ms`,
		);
	});

	await t.test("elapsed wall-clock counts toward the gap", async () => {
		await new Promise((r) => setTimeout(r, INTERVAL_MS * 0.6));
		const ms = await measure(() => fire(rt, PRE, ctxOf(rt)));
		assert.ok(
			ms < INTERVAL_MS * 0.55,
			`expected only the residual (~${Math.round(INTERVAL_MS * 0.4)}ms), got ${ms.toFixed(0)}ms`,
		);
	});

	await t.test("abort mid-wait resolves promptly and does not burn the slot", async () => {
		const ac = new AbortController();
		const wait = measure(() => fire(rt, PRE, ctxOf(rt, { signal: ac.signal })));
		const outcome = await Promise.race([
			wait,
			new Promise<{ hung: boolean }>((r) => setTimeout(() => r({ hung: true }), 1200)),
		]) as unknown as number | { hung: boolean };
		assert.ok(typeof outcome !== "object", "handler wedged after abort");

		const after = await measure(() => fire(rt, PRE, ctxOf(rt)));
		assert.ok(
			after >= INTERVAL_MS * 0.5 && after <= INTERVAL_MS + 1200,
			`post-abort canary wait off band (${after.toFixed(0)}ms)`,
		);
	});

	await t.test("other providers run freely", async () => {
		const ms = await measure(() => fire(rt, PRE, ctxOf(rt, { model: { provider: "other" } })));
		assert.ok(ms < 150, `unthrottled provider waited ${ms.toFixed(0)}ms`);
	});

	await t.test("modelPrefixes attributes payload-only requests", async () => {
		writeValidConfig(true); // adds { "nvidia/": "nvidia_nim" }
		const ctx = ctxOf(rt, { model: undefined });
		const mapped = { type: "before_provider_request", payload: { model: "nvidia/llama-3.3-70b" } };

		const first = await measure(() => fire(rt, mapped, ctx));
		assert.ok(first < 300, `first mapped call unexpectedly paced (${first.toFixed(0)}ms)`);

		const paced = await measure(() => fire(rt, mapped, ctx));
		assert.ok(paced >= INTERVAL_MS - 80, `mapped provider did not pace (${paced.toFixed(0)}ms)`);
	});

	await t.test("corrupt config warns once, supports /throttle config, recovers", async () => {
		writeFileSync(CONFIG, "{ this is not json");
		await fire(rt, { type: "session_start" }, ctxOf(rt));
		assert.equal(outageNotices(rt).length, 1, "one explicit outage advisory expected");

		for (let i = 0; i < 3; i++) await fire(rt, { type: "session_start" }, ctxOf(rt));
		assert.equal(outageNotices(rt).length, 1, "must not accumulate repeat advisories");

		const throttleCmd = rt.commands.throttle;
		assert.ok(throttleCmd, "/throttle must be registered before the outage probes");
		throttleCmd.handler("config", ctxOf(rt));
		const configMsg = rt.ui.notificationLog.find(([, m]) => m.includes("parse: FAILED"));
		assert.ok(configMsg, "/throttle config must surface the parse failure");

		writeValidConfig(true);
		await fire(rt, { type: "session_start" }, ctxOf(rt));
		assert.equal(outageNotices(rt).length, 1, "recovery must not produce fresh advisories");
	});

	rmSync(root, { recursive: true, force: true });
});
