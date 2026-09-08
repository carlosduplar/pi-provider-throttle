/**
 * Unit tests for provider-throttle internals: interval normalization,
 * provider attribution, config-path resolution, store memoization /
 * warn-once / atomic save / migration write targeting, and the
 * same-provider gate.
 *
 * All file-touching behavior runs inside temp dirs (synthetic config paths),
 * so the developer's real ~/.pi config is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	configPaths,
	createThrottle,
	ENV_VAR,
	intervalFor,
	normalizeInterval,
	resolveProvider,
	delay,
} from "../extensions/provider-throttle.ts";

// ── normalizeInterval / intervalFor ─────────────────────────────────────

test("normalizeInterval accepts positive finite, rejects everything else", () => {
	assert.equal(normalizeInterval(4), 4);
	assert.equal(normalizeInterval(1.5), 1.5);
	assert.equal(normalizeInterval("2.5"), 2.5);
	assert.equal(normalizeInterval(0), 0);
	assert.equal(normalizeInterval(-1), 0);
	assert.equal(normalizeInterval("abc"), 0);
	assert.equal(normalizeInterval(Number.POSITIVE_INFINITY), 0);
	assert.equal(normalizeInterval(null), 0);
	assert.equal(normalizeInterval(undefined), 0);
});

test("intervalFor reads provider rows, treating malformed rows as off", () => {
	const cfg = { providers: { a: 3, b: "2", c: -1, d: "NaNish" } };
	assert.equal(intervalFor(cfg, "a"), 3);
	assert.equal(intervalFor(cfg, "b"), 2);
	assert.equal(intervalFor(cfg, "c"), 0);
	assert.equal(intervalFor(cfg, "d"), 0);
	assert.equal(intervalFor(cfg, "missing"), 0);
});

// ── resolveProvider ─────────────────────────────────────────────────────

test("resolveProvider prefers ctx.model.provider", () => {
	assert.equal(resolveProvider({}, { model: { provider: "nvidia_nim" } }, {}), "nvidia_nim");
});

test("resolveProvider long-prefix beats short prefix; exact key wins overall", () => {
	const cfg = {
		modelPrefixes: {
			"meta/llama-3.3-70b-instruct": "exact-win",
			"meta/llama": "mid-win",
			"meta/": "short-win",
		},
	};
	assert.equal(
		resolveProvider({ model: "meta/llama-3.3-70b-instruct" }, {}, cfg),
		"exact-win",
	);
	assert.equal(resolveProvider({ model: "meta/llama-other" }, {}, cfg), "mid-win");
	assert.equal(resolveProvider({ model: "meta/mistral-x" }, {}, cfg), "short-win");
});

test("resolveProvider ignores malformed keys and unknown payloads", () => {
	const cfg = { modelPrefixes: { broken: 42, "": "empty", "good/": "score" } };
	assert.equal(resolveProvider({ model: "good/model" }, {}, cfg), "score");
	assert.equal(resolveProvider({ model: "bad/stuff" }, {}, cfg), undefined);
	assert.equal(resolveProvider(null, {}, cfg), undefined);
	assert.equal(resolveProvider({ model: 17 }, {}, cfg), undefined);
	// a bad value typed as number is skipped even when the key matches exactly
	assert.equal(resolveProvider({ model: "broken" }, {}, { modelPrefixes: { broken: 7 } }), undefined);
});

// ── configPaths precedence ──────────────────────────────────────────────

test("ENV override wins exclusively for read and write", () => {
	const paths = configPaths({ [ENV_VAR]: "/explicit/env/path.json" });
	const expected = resolve("/explicit/env/path.json"); // platform-normalized
	assert.equal(paths.read, expected);
	assert.equal(paths.write, paths.read);
});

// ── store behaviors on synthetic paths ──────────────────────────────────

const makeStore = () => {
	const root = mkdtempSync(join(tmpdir(), "ppt-unit-"));
	const cfgPath = join(root, "provider-throttle.json");
	const notices: { message: string; type?: string }[] = [];
	const store = createThrottle({
		readPath: () => cfgPath,
		writePath: cfgPath,
		notify: (message, type) => notices.push({ message, type }),
	});
	return { root, cfgPath, notices, store };
};

test("missing config reads empty without warning; save persists and reloads", () => {
	const { root, cfgPath, notices, store } = makeStore();

	const cold = store.view();
	assert.deepEqual(cold, { cfg: {}, ok: true, path: cfgPath });
	assert.equal(store.intervalMsFor("nvidia_nim"), 0);
	assert.equal(notices.length, 0, "absence is not an error");

	assert.deepEqual(store.save((cfg) => {
		if (cfg.providers) cfg.providers.nvidia_nim = 1.5;
	}), { ok: true });
	assert.equal(intervalFor(store.view().cfg, "nvidia_nim"), 1.5);
	assert.ok(!existsSync(`${cfgPath}.${process.pid}.tmp`), "atomic write leaves no stray tmp artifacts");

	rmSync(root, { recursive: true, force: true });
});

test("save preserves unrelated top-level keys and drops a disabled interval", () => {
	const { root, cfgPath, store } = makeStore();
	store.save((cfg) => {
		cfg.providers!.swissai = 4;
	});
	const outcome = store.save((cfg) => delete cfg.providers!.swissai);
	assert.deepEqual(outcome, { ok: true });
	assert.equal(intervalFor(store.view().cfg, "swissai"), 0);
	assert.ok(readFileSync(cfgPath, "utf-8").trim().startsWith("{"));
	rmSync(root, { recursive: true, force: true });
});

test("corrupt file warns once, not per read; recovery then re-break warns again", () => {
	const { root, cfgPath, notices, store } = makeStore();
	writeFileSync(cfgPath, "{ definitely not json");
	for (let i = 0; i < 5; i++) store.view();
	assert.equal(notices.length, 1);
	assert.equal(notices[0]?.type, "warning");
	assert.match(String(notices[0]?.message), /DISABLED until the file is fixed/);

	writeFileSync(cfgPath, JSON.stringify({ providers: { nvidia_nim: 1.5 } }));
	store.view();
	writeFileSync(cfgPath, "broken again");
	for (let i = 0; i < 3; i++) store.view();
	assert.equal(notices.length, 2, "recurrence warns again after recovery");

	rmSync(root, { recursive: true, force: true });
});

test("content rewrite is honored on subsequent reads", () => {
	const { root, cfgPath, store } = makeStore();
	writeFileSync(cfgPath, JSON.stringify({ providers: { p1: 1 } }));
	assert.equal(store.intervalMsFor("p1"), 1000);

	writeFileSync(cfgPath, JSON.stringify({ providers: { p1: 2 } }));
	assert.equal(store.intervalMsFor("p1"), 2000, "changed content honored after rewrite");

	rmSync(root, { recursive: true, force: true });
});

// ── gate serialization ──────────────────────────────────────────────────

test("runGated serializes overlapping same-provider attempts", async () => {
	const root = mkdtempSync(join(tmpdir(), "ppt-gate-"));
	const store = createThrottle({ readPath: () => join(root, "c.json"), writePath: join(root, "c.json") });
	const timeline: string[] = [];

	const body = (label: string, ms: number) => async () => {
		await delay(ms, undefined);
		timeline.push(`done:${label}`);
	};

	await Promise.all([
		store.runGated("prov", body("first", 60)).then(() => timeline.push("released:first")),
		store.runGated("prov", body("second", 5)).then(() => timeline.push("released:second")),
	]);

	assert.ok(
		timeline.indexOf("done:first") < timeline.indexOf("done:second"),
		`first body finished before second: ${timeline.join(" -> ")}`,
	);
	assert.ok(
		timeline.indexOf("done:first") < timeline.indexOf("released:second"),
		`second body released only after first done: ${timeline.join(" -> ")}`,
	);

	// distinct providers run ungated
	await Promise.all([store.runGated("a", body("xa", 30)), store.runGated("b", body("xb", 30))]);
	assert.ok(timeline.includes("done:xa") && timeline.includes("done:xb"));

	rmSync(root, { recursive: true, force: true });
});

test("runGated releases when the body throws — no permanent wedge", async () => {
	const root = mkdtempSync(join(tmpdir(), "ppt-gate-throw-"));
	const store = createThrottle({ readPath: () => join(root, "c.json"), writePath: join(root, "c.json") });

	await assert.rejects(
		() => store.runGated("p", async () => { throw new Error("boom"); }),
		/boom/,
	);

	// follower must still get the provider immediately
	const result = await store.runGated("p", async () => "recovered");
	assert.equal(result, "recovered");
	rmSync(root, { recursive: true, force: true });
});

// ── pacing anchor semantics ─────────────────────────────────────────────

test("anchorMs honours the later of call-start / assistant-end stamps", () => {
	const root = mkdtempSync(join(tmpdir(), "ppt-anchor-"));
	const store = createThrottle({ readPath: () => join(root, "c.json"), writePath: join(root, "c.json") });

	assert.equal(store.anchorMs("prov"), 0, "cold provider has no anchor");
	store.recordAssistant("prov", 1000);
	assert.equal(store.anchorMs("prov"), 1000);
	store.recordCall("prov", 2000);
	assert.equal(store.anchorMs("prov"), 2000);
	store.recordAssistant("prov", 3000);
	assert.equal(store.anchorMs("prov"), 3000);
	store.recordAssistant(undefined, 4000); // no-op
	store.recordCall("", 5000); // no-op
	assert.equal(store.anchorMs("prov"), 3000, "garbage provider ids change nothing");
	assert.equal(store.anchorMs("never-seen"), 0);

	rmSync(root, { recursive: true, force: true });
});

// ── delay ───────────────────────────────────────────────────────────────

test("delay waits the requested span then resolves normally", async () => {
	const t0 = Date.now();
	await delay(60, undefined);
	assert.ok(Date.now() - t0 >= 50);
});

test("delay resolves immediately on abort even for a giant span", async () => {
	const ac = new AbortController();
	const stuck = delay(Number.MAX_SAFE_INTEGER, ac.signal);
	setTimeout(() => ac.abort(), 40);
	const t0 = Date.now();
	await stuck;
	assert.ok(Date.now() - t0 < 150, `abort did not resolve promptly (took ${Date.now() - t0}ms)`);
});
