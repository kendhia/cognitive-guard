/**
 * Gate behaviour, driven through a mock ExtensionContext.
 *
 * These exercise the paths that must work with no model available: the
 * non-interactive block, the explicit override, and the attestation fallback.
 *
 * Run with: node --test test/gate.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, type GuardConfig } from "../src/config.ts";
import { isGatedCommand, runGate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";

/** Audit writes go to a scratch dir, never the real ~/.pi/agent. */
function scratchDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-guard-test-"));
}

interface MockOptions {
	hasUI?: boolean;
	/** Answers handed to successive ctx.ui.select calls. */
	selects?: string[];
	inputs?: (string | undefined)[];
	editors?: (string | undefined)[];
}

function mockCtx(options: MockOptions = {}) {
	const selects = [...(options.selects ?? [])];
	const inputs = [...(options.inputs ?? [])];
	const editors = [...(options.editors ?? [])];
	const notices: string[] = [];

	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		cwd: "/repo",
		model: undefined,
		signal: undefined,
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
		ui: {
			select: async (_title: string, choices: string[]) => {
				const next = selects.shift();
				if (next === undefined) return undefined;
				// Allow tests to name a choice by prefix.
				return choices.find((choice) => choice.startsWith(next)) ?? next;
			},
			input: async () => inputs.shift(),
			editor: async () => editors.shift(),
			notify: (message: string) => notices.push(message),
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: deliberate structural mock
	return { ctx: ctx as any, notices };
}

function ledgerWith(config: GuardConfig, paths: string[]): Ledger {
	const ledger = new Ledger(config);
	for (const [index, filePath] of paths.entries()) {
		ledger.record({
			id: `d${index}`,
			filePath,
			kind: "edit",
			linesChanged: 5,
			addedText: "if (!user.isAdmin) return deny();",
			cwd: "/repo",
		});
	}
	return ledger;
}

const config = (overrides: Partial<GuardConfig> = {}): GuardConfig => ({
	...structuredClone(DEFAULT_CONFIG),
	...overrides,
});

test("gated command detection", () => {
	const c = config();
	assert.ok(isGatedCommand("git add -A && git commit -m x", c));
	assert.ok(isGatedCommand("git push --force origin main", c));
	assert.ok(!isGatedCommand("git status --porcelain", c));
	assert.ok(!isGatedCommand("npm test", c));
});

test("nothing pending always allows", async () => {
	const c = config();
	const { ctx } = mockCtx();
	const decision = await runGate({
		ctx,
		agentDir: scratchDir(),
		config: c,
		ledger: new Ledger(c),
		entries: [],
		command: "git commit",
	});
	assert.equal(decision.allow, true);
});

test("non-interactive blocks by default and reports why", async () => {
	const c = config();
	const ledger = ledgerWith(c, ["src/auth/session.ts"]);
	const { ctx } = mockCtx({ hasUI: false });

	const decision = await runGate({
		ctx,
		agentDir: scratchDir(),
		config: c,
		ledger,
		entries: ledger.gating(),
		command: "git commit -m x",
	});

	assert.equal(decision.allow, false);
	assert.match(decision.reason ?? "", /cognitive-guard/);
	assert.match(decision.reason ?? "", /src\/auth\/session\.ts/);
	assert.match(decision.reason ?? "", /Do not retry/);
});

test("non-interactive honours allow and warn settings", async () => {
	for (const mode of ["allow", "warn"] as const) {
		const c = config();
		c.gate.nonInteractive = mode;
		const ledger = ledgerWith(c, ["src/auth/session.ts"]);
		const { ctx } = mockCtx({ hasUI: false });

		const decision = await runGate({
			ctx,
			agentDir: scratchDir(),
			config: c,
			ledger,
			entries: ledger.gating(),
			command: "git commit",
		});
		assert.equal(decision.allow, true, `mode ${mode} should allow`);
	}
});

test("cancelling blocks the commit and tells the agent not to retry", async () => {
	const c = config();
	const ledger = ledgerWith(c, ["src/auth/session.ts"]);
	const { ctx } = mockCtx({ selects: ["Cancel"] });

	const decision = await runGate({
		ctx,
		agentDir: scratchDir(),
		config: c,
		ledger,
		entries: ledger.gating(),
		command: "git commit",
	});

	assert.equal(decision.allow, false);
	assert.match(decision.reason ?? "", /Do not retry/);
	assert.equal(ledger.gating().length, 1, "cancelling must not verify anything");
});

test("override requires a reason, records it, and clears the gate", async () => {
	const c = config();
	const agentDir = scratchDir();
	const ledger = ledgerWith(c, ["src/auth/session.ts"]);
	const { ctx } = mockCtx({
		selects: ["Override"],
		inputs: ["generated client, covered by contract tests"],
	});

	const decision = await runGate({
		ctx,
		agentDir,
		config: c,
		ledger,
		entries: ledger.gating(),
		command: "git commit",
	});

	assert.equal(decision.allow, true);
	assert.equal(ledger.gating().length, 0, "override should clear the gate");

	const log = fs.readFileSync(path.join(agentDir, "cognitive-guard-audit.jsonl"), "utf-8");
	const record = JSON.parse(log.trim().split("\n").at(-1) as string);
	assert.equal(record.event, "override");
	assert.match(record.reason, /contract tests/);
});

test("override with an empty reason is refused", async () => {
	const c = config();
	const ledger = ledgerWith(c, ["src/auth/session.ts"]);
	const { ctx } = mockCtx({ selects: ["Override"], inputs: [""] });

	const decision = await runGate({
		ctx,
		agentDir: scratchDir(),
		config: c,
		ledger,
		entries: ledger.gating(),
		command: "git commit",
	});

	assert.equal(decision.allow, false);
	assert.equal(ledger.gating().length, 1);
});

test("attestation fallback accepts a substantive answer and rejects a short one", async () => {
	const long =
		"If the admin check is inverted, non-admin users reach the delete endpoint and can remove other tenants' invoices, which is unrecoverable without a restore.";

	{
		const c = config();
		const agentDir = scratchDir();
		const ledger = ledgerWith(c, ["src/auth/session.ts"]);
		// No model on the mock ctx, so quiz generation fails into `attest`.
		const { ctx } = mockCtx({ selects: ["Answer"], editors: [long] });

		const decision = await runGate({
			ctx,
			agentDir,
			config: c,
			ledger,
			entries: ledger.gating(),
			command: "git commit",
		});

		assert.equal(decision.allow, true, "a substantive attestation should pass");
		assert.equal(ledger.gating().length, 0);
		const log = fs.readFileSync(path.join(agentDir, "cognitive-guard-audit.jsonl"), "utf-8");
		assert.match(log, /"event":"attestation"/);
	}

	{
		const c = config();
		const ledger = ledgerWith(c, ["src/auth/session.ts"]);
		const { ctx } = mockCtx({ selects: ["Answer"], editors: ["idk"] });

		const decision = await runGate({
			ctx,
			agentDir: scratchDir(),
			config: c,
			ledger,
			entries: ledger.gating(),
			command: "git commit",
		});

		assert.equal(decision.allow, false, "a token attestation should be refused");
		assert.match(decision.reason ?? "", /too short/);
		assert.equal(ledger.gating().length, 1);
	}
});

test("fallback=block refuses without asking for an attestation", async () => {
	const c = config();
	c.gate.fallback = "block";
	const ledger = ledgerWith(c, ["src/auth/session.ts"]);
	const { ctx } = mockCtx({ selects: ["Answer"] });

	const decision = await runGate({
		ctx,
		agentDir: scratchDir(),
		config: c,
		ledger,
		entries: ledger.gating(),
		command: "git commit",
	});

	assert.equal(decision.allow, false);
	assert.match(decision.reason ?? "", /could not generate/);
});

test("viewing the diff counts as engagement and returns to the menu", async () => {
	const c = config();
	const ledger = ledgerWith(c, ["src/auth/session.ts"]);
	const entries = ledger.gating();
	// First choose "Show me the diff", then cancel out of the second menu.
	const { ctx } = mockCtx({ selects: ["Show me", "Cancel"], editors: ["(read)"] });

	await runGate({ ctx, agentDir: scratchDir(), config: c, ledger, entries, command: "git commit" });

	assert.ok(entries[0].delta.engagement.userInspected, "reading the diff should be credited");
});
