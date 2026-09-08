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
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
interface MockUi {
	notificationLog: Array<[string, string]>;
	statuses: Record<string, string | undefined>;
	confirmLog: Array<[string, string]>;
	confirmAnswers: boolean[];
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, value: string | undefined): void;
	setWorkingMessage(message?: string): void;
	confirm(title: string, message: string): Promise<boolean>;
}

interface ProviderToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
}

interface ProviderToolDef {
	name: string;
	description?: string;
	promptSnippet?: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<ProviderToolResult>;
}

interface Runtime {
	handlers: Record<
		string,
		Array<(event: { type: string; payload?: unknown }, ctx: unknown) => unknown>
	>;
	commands: Record<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => Promise<void> | void;
		}
	>;
	tools: Record<string, ProviderToolDef>;
	ui: MockUi;
}

const INTERVAL_S = 0.4;
const INTERVAL_MS = INTERVAL_S * 1000;

const root = mkdtempSync(join(tmpdir(), `ppt-e2e-${process.pid}-`));
const CONFIG = join(root, "provider-throttle.json");
mkdirSync(dirname(CONFIG), { recursive: true });
process.env.PI_PROVIDER_THROTTLE_CONFIG = CONFIG;

const { default: EXT_DEFAULT, STATUS_KEY } = await import(
	"../extensions/provider-throttle.ts"
);

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
	const tools: Record<string, ProviderToolDef> = {};
	const ui: MockUi = {
		notificationLog: [],
		statuses: {},
		confirmLog: [],
		confirmAnswers: [],
		notify(message, type) {
			this.notificationLog.push([type ?? "info", message]);
		},
		setStatus(key, value) {
			this.statuses[key] = value;
		},
		setWorkingMessage() {},
		confirm(title, message) {
			this.confirmLog.push([title, message]);
			const next = this.confirmAnswers.shift();
			return Promise.resolve(next ?? false);
		},
	};
	EXT_DEFAULT({
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			(handlers[name] ??= []).push(handler);
		},
		registerCommand(name: string, spec: (typeof commands)[string]) {
			commands[name] = spec;
		},
		registerTool(tool: ProviderToolDef) {
			tools[tool.name] = tool;
		},
	} as unknown as Parameters<typeof EXT_DEFAULT>[0]);
	return { handlers, commands, tools, ui } satisfies Runtime;
};

const fire = async (
	rt: Runtime,
	event: { type: string; payload?: unknown },
	ctx: unknown,
) => Promise.all((rt.handlers[event.type] ?? []).map((h) => h(event, ctx)));

const ctxOf = (rt: Runtime, overrides: Record<string, unknown> = {}) => ({
	model: { provider: "prov" },
	ui: rt.ui,
	signal: undefined,
	...overrides,
});

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

	await t.test(
		"cold first call is immediate; next same-provider call paces",
		async () => {
			const cold = await measure(() => fire(rt, PRE, ctxOf(rt)));
			assert.ok(cold < 300, `cold call unexpectedly waited ${cold.toFixed(0)}ms`);

			const paced = await measure(() => fire(rt, PRE, ctxOf(rt)));
			assert.ok(
				paced >= INTERVAL_MS - 100 && paced <= INTERVAL_MS + 1000,
				`second call waited ${paced.toFixed(0)}ms; expected ~${INTERVAL_MS}ms`,
			);
		},
	);

	await t.test("elapsed wall-clock counts toward the gap", async () => {
		await new Promise((r) => setTimeout(r, INTERVAL_MS * 0.6));
		const ms = await measure(() => fire(rt, PRE, ctxOf(rt)));
		assert.ok(
			ms < INTERVAL_MS * 0.55,
			`expected only the residual (~${Math.round(INTERVAL_MS * 0.4)}ms), got ${ms.toFixed(0)}ms`,
		);
	});

	await t.test(
		"abort mid-wait resolves promptly and does not burn the slot",
		async () => {
			const ac = new AbortController();
			const wait = measure(() => fire(rt, PRE, ctxOf(rt, { signal: ac.signal })));
			const outcome = (await Promise.race([
				wait,
				new Promise<{ hung: boolean }>((r) =>
					setTimeout(() => r({ hung: true }), 1200),
				),
			])) as unknown as number | { hung: boolean };
			assert.ok(typeof outcome !== "object", "handler wedged after abort");

			const after = await measure(() => fire(rt, PRE, ctxOf(rt)));
			assert.ok(
				after >= INTERVAL_MS * 0.5 && after <= INTERVAL_MS + 1200,
				`post-abort canary wait off band (${after.toFixed(0)}ms)`,
			);
		},
	);

	await t.test("other providers run freely", async () => {
		const ms = await measure(() =>
			fire(rt, PRE, ctxOf(rt, { model: { provider: "other" } })),
		);
		assert.ok(ms < 150, `unthrottled provider waited ${ms.toFixed(0)}ms`);
	});

	await t.test("modelPrefixes attributes payload-only requests", async () => {
		writeValidConfig(true); // adds { "nvidia/": "nvidia_nim" }
		const ctx = ctxOf(rt, { model: undefined });
		const mapped = {
			type: "before_provider_request",
			payload: { model: "nvidia/llama-3.3-70b" },
		};

		const first = await measure(() => fire(rt, mapped, ctx));
		assert.ok(
			first < 300,
			`first mapped call unexpectedly paced (${first.toFixed(0)}ms)`,
		);

		const paced = await measure(() => fire(rt, mapped, ctx));
		assert.ok(
			paced >= INTERVAL_MS - 80,
			`mapped provider did not pace (${paced.toFixed(0)}ms)`,
		);
	});

	await t.test(
		"corrupt config warns once, supports /throttle config, recovers",
		async () => {
			writeFileSync(CONFIG, "{ this is not json");
			await fire(rt, { type: "session_start" }, ctxOf(rt));
			assert.equal(
				outageNotices(rt).length,
				1,
				"one explicit outage advisory expected",
			);

			for (let i = 0; i < 3; i++)
				await fire(rt, { type: "session_start" }, ctxOf(rt));
			assert.equal(
				outageNotices(rt).length,
				1,
				"must not accumulate repeat advisories",
			);

			const throttleCmd = rt.commands.throttle;
			assert.ok(
				throttleCmd,
				"/throttle must be registered before the outage probes",
			);
			throttleCmd.handler("config", ctxOf(rt));
			const configMsg = rt.ui.notificationLog.find(([, m]) =>
				m.includes("parse: FAILED"),
			);
			assert.ok(configMsg, "/throttle config must surface the parse failure");

			writeValidConfig(true);
			await fire(rt, { type: "session_start" }, ctxOf(rt));
			assert.equal(
				outageNotices(rt).length,
				1,
				"recovery must not produce fresh advisories",
			);
		},
	);

	await t.test(
		"live /throttle saves refresh the status strip immediately",
		async () => {
			const throttleCmd = rt.commands.throttle;
			assert.ok(
				throttleCmd,
				"/throttle must be registered before status-refresh probing",
			);
			const before = rt.ui.statuses[STATUS_KEY];

			await throttleCmd.handler("nvidia_nim 3", ctxOf(rt));
			assert.notEqual(
				rt.ui.statuses[STATUS_KEY],
				before,
				"a successful save must refresh the status strip without waiting for session_start",
			);
			assert.match(String(rt.ui.statuses[STATUS_KEY]), /nvidia_nim 3s/);

			// restore the elicited pace in case further suites depend on it
			await throttleCmd.handler(`nvidia_nim ${INTERVAL_S}`, ctxOf(rt));
			assert.match(String(rt.ui.statuses[STATUS_KEY]), /nvidia_nim 0\.4s/);
		},
	);

	await t.test(
		"assistant response end stamps a fresh pacing anchor",
		async () => {
			writeValidConfig(false); // providers { prov, nvidia_nim } @ INTERVAL_S
			const rt2 = makeRuntime(); // fresh wiring -> fresh pacing state
			const ctxViaNvidia = ctxOf(rt2, { model: { provider: "nvidia_nim" } });

			const cold = await measure(() => fire(rt2, PRE, ctxViaNvidia));
			assert.ok(cold < 300, `cold call gated unexpectedly (${cold.toFixed(0)}ms)`);

			// age the sole anchor (call-start) beyond the interval...
			await new Promise((r) => setTimeout(r, INTERVAL_MS * 1.25));
			// ...then finish a response on that provider. Attribution must come from
			// the assistant message itself, not from ctx.model.
			const responseEnded = {
				type: "message_end",
				message: {
					role: "assistant",
					provider: "nvidia_nim",
					model: "nvidia/llama-3.3-70b",
				},
			};
			await fire(rt2, responseEnded, ctxOf(rt2, { model: undefined }));

			// Without the response-end anchor this would be a ~0ms residual wait.
			const paced = await measure(() => fire(rt2, PRE, ctxViaNvidia));
			assert.ok(
				paced >= INTERVAL_MS - 100 && paced <= INTERVAL_MS + 800,
				`response-end anchor paced the next call ${paced.toFixed(0)}ms; expected ~full interval`,
			);
		},
	);
});

// ── provider_throttle tool end-to-end ───────────────────────────

const REGISTRY_IDS = ["nvidia_nim", "openai", "anthropic"];
const DISPLAY: Record<string, string> = {
	nvidia_nim: "NVIDIA NIM",
	openai: "OpenAI Gateway",
	anthropic: "Anthropic",
};
const registryMock = {
	getRegisteredProviderIds: () => [...REGISTRY_IDS],
	getProviderDisplayName: (id: string) => DISPLAY[id] ?? id,
};

const toolCtx = (rt: Runtime, overrides: Record<string, unknown> = {}) => ({
	hasUI: true,
	ui: rt.ui,
	signal: undefined,
	modelRegistry: registryMock,
	...overrides,
});

const callTool = async (
	rt: Runtime,
	params: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): Promise<ProviderToolResult> => {
	const tool = rt.tools.provider_throttle;
	assert.ok(tool, "provider_throttle must be registered");
	return tool.execute(
		"t1",
		params as never,
		undefined,
		undefined,
		toolCtx(rt, overrides) as never,
	) as Promise<ProviderToolResult>;
};

const extractText = (result: ProviderToolResult): string =>
	result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");

const intervalInFile = (provider: string): number | undefined => {
	const parsed = JSON.parse(readFileSync(CONFIG, "utf-8")) as {
		providers?: Record<string, number>;
	};
	return parsed.providers?.[provider];
};

test("provider_throttle tool end-to-end", async (t) => {
	const rt = makeRuntime();
	writeValidConfig(true);

	await t.test("registers the provider_throttle tool", () => {
		assert.ok(rt.tools.provider_throttle, "tool must be registered at load");
		assert.match(
			String(rt.tools.provider_throttle.description),
			/rpm/i,
			"tool description must advertise rpm-driven pacing",
		);
	});

	await t.test(
		"'list' reports ids, display names, and pacing state",
		async () => {
			const result = await callTool(rt, { action: "list" });
			const text = extractText(result);
			assert.match(text, /- nvidia_nim \(NVIDIA NIM\): 0\.4s/);
			assert.match(text, /- anthropic \(Anthropic\): off/);
			assert.match(text, /write path:/);
		},
	);

	await t.test(
		"'set' resolves a display-name hint and persists the rpm floor",
		async () => {
			rt.ui.confirmAnswers.push(true);
			const result = await callTool(rt, {
				action: "set",
				provider: "NVIDIA",
				rpm: 40,
			});
			assert.match(extractText(result), /nvidia_nim now paced: at least 2s/);
			assert.equal(intervalInFile("nvidia_nim"), 2);
			const notice = rt.ui.notificationLog.at(-1);
			assert.match(String(notice?.[1]), /nvidia_nim: min interval 2s/);
		},
	);

	await t.test(
		"explicit seconds override rpm; hasUI false skips the confirm dialog",
		async () => {
			const confirmCallsBefore = rt.ui.confirmLog.length;
			await callTool(
				rt,
				{ action: "set", provider: "openai", seconds: 3, rpm: 40 },
				{ hasUI: false },
			);
			assert.equal(intervalInFile("openai"), 3);
			assert.equal(
				rt.ui.confirmLog.length,
				confirmCallsBefore,
				"headless contexts must not attempt a dialog",
			);
		},
	);

	await t.test(
		"declining the confirm leaves the config bytes intact",
		async () => {
			const before = readFileSync(CONFIG, "utf-8");
			rt.ui.confirmAnswers.push(false);
			const result = await callTool(rt, {
				action: "set",
				provider: "anthropic",
				rpm: 30,
			});
			assert.match(extractText(result), /Declined/);
			assert.equal(readFileSync(CONFIG, "utf-8"), before);
		},
	);

	await t.test(
		"unknown hints enumerate known ids instead of writing",
		async () => {
			const before = readFileSync(CONFIG, "utf-8");
			const result = await callTool(rt, {
				action: "set",
				provider: "groq",
				rpm: 10,
			});
			const text = extractText(result);
			assert.match(text, /No provider resembles "groq"/);
			assert.match(text, /Known: nvidia_nim, openai, anthropic/);
			assert.equal(readFileSync(CONFIG, "utf-8"), before);
		},
	);

	await t.test(
		"unparsable write target propagates the save refusal",
		async () => {
			writeFileSync(CONFIG, "{ broken");
			rt.ui.confirmAnswers.push(true);
			const result = await callTool(rt, {
				action: "set",
				provider: "NVIDIA",
				rpm: 40,
			});
			const text = extractText(result);
			assert.match(text, /Could not persist/);
			assert.match(text, /refusing to save over unreadable/);
			writeValidConfig(true);
		},
	);

	rmSync(root, { recursive: true, force: true });
});
