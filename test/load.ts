/**
 * Loads the extension through Pi's own loader.
 *
 * The unit tests exercise the scoring and gate logic directly, which cannot
 * catch a packaging fault: an unresolvable import, a syntax form jiti rejects,
 * or a factory that throws on registration. This test runs the real loader and
 * asserts the extension registered what it claims to.
 *
 * Run with: node --test test/load.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const extensionPath = path.resolve(import.meta.dirname, "..", "index.ts");

test("loads under Pi's extension loader with no errors", async () => {
	// Scratch agentDir and cwd so discovery finds nothing but our own path,
	// keeping the assertion about this extension rather than the environment.
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-guard-load-"));
	const result = await discoverAndLoadExtensions([extensionPath], scratch, scratch);

	assert.deepEqual(result.errors, [], "extension must load without errors");
	assert.equal(result.extensions.length, 1);

	const extension = result.extensions[0];

	// The /guard command and its subcommand completions.
	assert.ok(extension.commands.has("guard"), "should register the /guard command");
	const guard = extension.commands.get("guard");
	assert.match(guard?.description ?? "", /cognitive-guard/);
	const completions = await guard?.getArgumentCompletions?.("o");
	assert.deepEqual(
		completions?.map((item) => item.value).sort(),
		["off", "on", "override"],
		"subcommand completions should filter by prefix",
	);

	// Every event the design depends on must actually be subscribed.
	for (const event of [
		"session_start",
		"tool_result",
		"tool_call",
		"input",
		"user_bash",
		"before_agent_start",
		"agent_settled",
	]) {
		assert.ok(extension.handlers.has(event), `should subscribe to ${event}`);
	}

	// It is a guard, not a tool provider: it must not add tools to the prompt.
	assert.equal(extension.tools.size, 0, "should register no LLM-facing tools");
});

/**
 * Drive the loaded extension end to end through its real handlers: an edit
 * lands, the injection appears, and a commit is refused. This is the closest
 * thing to a live session that runs without a model.
 */
test("end to end: risky edit -> concise injection -> blocked commit", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-guard-e2e-"));
	const result = await discoverAndLoadExtensions([extensionPath], scratch, scratch);
	assert.deepEqual(result.errors, []);

	const extension = result.extensions[0];
	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];

	const ctx = {
		// Starts interactive so the footer path is exercised; dropped to
		// non-interactive below to assert the headless gate behaviour.
		hasUI: true,
		mode: "tui",
		cwd: scratch,
		model: undefined,
		signal: undefined,
		isProjectTrusted: () => false,
		sessionManager: { getEntries: () => [] },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
		},
		// biome-ignore lint/suspicious/noExplicitAny: deliberate structural mock
	} as any;

	const fire = async (event: string, payload: unknown) => {
		const handlers = extension.handlers.get(event) ?? [];
		const results = [];
		for (const handler of handlers) results.push(await handler(payload, ctx));
		return results;
	};

	await fire("session_start", { type: "session_start", reason: "startup" });

	// Nothing pending yet, so nothing should be injected.
	const quiet = await fire("before_agent_start", {
		type: "before_agent_start",
		prompt: "hi",
		systemPrompt: "BASE",
		systemPromptOptions: {},
	});
	assert.equal(quiet[0], undefined, "must inject nothing when nothing is pending");

	// A three-line change inside an auth path: the canonical risky case.
	await fire("tool_result", {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		isError: false,
		content: [],
		details: { patch: "@@ -1 +1 @@\n-if (t.expiresAt < now)\n+if (t.expiresAt <= now)" },
		input: {
			path: `${scratch}/src/auth/session.ts`,
			edits: [{ oldText: "if (t.expiresAt < now)", newText: "if (t.expiresAt <= now)" }],
		},
	});

	const injected = (await fire("before_agent_start", {
		type: "before_agent_start",
		prompt: "commit it",
		systemPrompt: "BASE",
		systemPromptOptions: {},
	}))[0] as { systemPrompt?: string } | undefined;

	assert.ok(injected?.systemPrompt, "must inject once something risky is pending");
	const addition = injected.systemPrompt.replace(/^BASE\s*/, "");
	assert.match(addition, /<cognitive-guard>/);
	assert.match(addition, /src\/auth\/session\.ts/);
	assert.ok(
		addition.length <= 420,
		`injection must stay within its 420-char budget (was ${addition.length})`,
	);

	// The footer should flag it while a UI is attached.
	assert.match(statuses.get("cognitive-guard") ?? "", /guard 1!/);

	// Headless from here: no UI means the gate cannot quiz anyone.
	ctx.hasUI = false;

	// A read-only git command must pass straight through.
	const statusCall = await fire("tool_call", {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-2",
		input: { command: "git status --porcelain" },
	});
	assert.equal(statusCall[0], undefined, "git status must not be gated");

	// The commit must be refused, with a reason the agent can act on.
	const commitCall = (await fire("tool_call", {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-3",
		input: { command: "git add -A && git commit -m 'fix session'" },
	}))[0] as { block?: boolean; reason?: string } | undefined;

	assert.equal(commitCall?.block, true, "the commit must be blocked");
	assert.match(commitCall?.reason ?? "", /src\/auth\/session\.ts/);
	assert.match(commitCall?.reason ?? "", /Do not retry/);
});

test("injection stays inside its budget without severing the closing tag", async () => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cognitive-guard-cap-"));
	const result = await discoverAndLoadExtensions([extensionPath], scratch, scratch);
	const extension = result.extensions[0];

	const ctx = {
		hasUI: false,
		mode: "print",
		cwd: scratch,
		model: undefined,
		signal: undefined,
		isProjectTrusted: () => false,
		sessionManager: { getEntries: () => [] },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false },
		ui: { notify: () => {}, setStatus: () => {} },
		// biome-ignore lint/suspicious/noExplicitAny: deliberate structural mock
	} as any;

	const fire = async (event: string, payload: unknown) => {
		const results = [];
		for (const handler of extension.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	};

	await fire("session_start", { type: "session_start", reason: "startup" });

	// Deliberately awkward: many risky files with very long paths.
	for (let i = 0; i < 12; i++) {
		const file = `${scratch}/services/deeply/nested/monorepo/packages/platform-${i}/src/auth/session-refresh-handler-${i}.ts`;
		await fire("tool_result", {
			type: "tool_result",
			toolName: "edit",
			toolCallId: `call-${i}`,
			isError: false,
			content: [],
			input: { path: file, edits: [{ oldText: "a", newText: "b" }] },
		});
	}

	const injected = (await fire("before_agent_start", {
		type: "before_agent_start",
		prompt: "commit",
		systemPrompt: "BASE",
		systemPromptOptions: {},
	}))[0] as { systemPrompt?: string } | undefined;

	const addition = (injected?.systemPrompt ?? "").replace(/^BASE\s*/, "");
	assert.ok(addition.length > 0, "should still inject something");
	assert.ok(addition.endsWith("</cognitive-guard>"), `closing tag must survive: ${JSON.stringify(addition.slice(-40))}`);
	assert.ok(addition.length <= 420, `must respect the 420-char budget (was ${addition.length})`);
});
