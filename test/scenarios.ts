/**
 * Behavioural checks for the risk model.
 *
 * These encode the premise the extension is built on: risk tracks blast radius
 * and opacity, not line count. If a change here flips one of these cases,
 * the scoring model no longer matches its stated intent.
 *
 * Run with: node --test test/scenarios.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type GuardConfig } from "../src/config.ts";
import { globToRegExp, matchesGlob, normalizePath } from "../src/glob.ts";
import { Ledger } from "../src/ledger.ts";
import { type Delta, scoreDelta } from "../src/risk.ts";

const config: GuardConfig = structuredClone(DEFAULT_CONFIG);

function delta(overrides: Partial<Delta> & Pick<Delta, "path">): Delta {
	return {
		id: overrides.path,
		kind: "edit",
		linesChanged: 10,
		addedText: "",
		engagement: {
			observedAt: Date.now(),
			dwellMs: 0,
			userInspected: false,
			discussed: false,
			agentReread: false,
			rubberStamped: false,
		},
		...overrides,
	};
}

const risk = (d: Delta) => scoreDelta(d, config).risk;

test("every default regex compiles", () => {
	for (const rule of config.contentMarkers) new RegExp(rule.pattern, "i");
	for (const pattern of config.gate.commands) new RegExp(pattern, "i");
	for (const pattern of config.engagement.rubberStampPatterns) new RegExp(pattern, "i");
	for (const pattern of config.engagement.inspectionPatterns) new RegExp(pattern, "i");
	for (const pattern of config.opaqueBashPatterns) new RegExp(pattern, "i");
	for (const rule of config.criticalPaths) globToRegExp(rule.glob);
	for (const rule of config.familiarPaths) globToRegExp(rule.glob);
});

test("glob matching handles ** and braces", () => {
	assert.ok(matchesGlob("**/{auth,session}/**", "src/auth/token.ts"));
	assert.ok(matchesGlob("**/{auth,session}/**", "auth/token.ts"), "** should match zero leading segments");
	assert.ok(!matchesGlob("**/{auth,session}/**", "src/billing/token.ts"));
	assert.ok(matchesGlob("**/*.{test,spec}.ts", "src/a/b.test.ts"));
	assert.ok(!matchesGlob("**/*.tf", "main.tfvars"));
	assert.equal(normalizePath("/repo/src/a.ts", "/repo"), "src/a.ts");
	assert.equal(normalizePath("./src/a.ts"), "src/a.ts");
});

test("THE core premise: 3 lines of auth outranks 500 lines of boilerplate IaC", () => {
	const authChange = delta({
		path: "src/auth/session.ts",
		linesChanged: 3,
		addedText: "if (token.expiresAt < now) return refresh(token);",
	});
	const terraform = delta({
		path: "infra/vpc.tf",
		linesChanged: 500,
		addedText: 'resource "aws_subnet" "private" {\n  cidr_block = "10.0.1.0/24"\n}',
	});

	assert.ok(
		risk(authChange) > risk(terraform),
		`auth ${risk(authChange).toFixed(2)} should outrank terraform ${risk(terraform).toFixed(2)}`,
	);
	assert.ok(risk(authChange) >= config.thresholds.quiz, "a 3-line auth change must gate");
	assert.ok(risk(terraform) < config.thresholds.quiz, "500 lines of plain IaC must not gate");
});

test("a dangerous marker defeats the boilerplate dampener", () => {
	const wildcardIam = delta({
		path: "infra/vpc.tf",
		linesChanged: 500,
		addedText: 'resource "aws_iam_policy" "p" {\n  actions = ["*"]\n}',
	});
	assert.ok(risk(wildcardIam) >= config.thresholds.quiz, "an IAM wildcard inside boilerplate must still gate");
});

test("large test and doc changes stay quiet", () => {
	assert.ok(risk(delta({ path: "src/foo.test.ts", linesChanged: 400 })) < config.thresholds.warn);
	assert.ok(risk(delta({ path: "docs/guide.md", linesChanged: 900 })) < config.thresholds.warn);
	assert.ok(risk(delta({ path: "yarn.lock", linesChanged: 5000 })) < config.thresholds.warn);
});

test("engagement lowers risk; rubber-stamping raises it", () => {
	const base = delta({ path: "src/payments/charge.ts", linesChanged: 40, addedText: "const total = amount * qty;" });

	const engaged = structuredClone(base);
	engaged.engagement.userInspected = true;
	engaged.engagement.dwellMs = 120_000;
	engaged.engagement.discussed = true;

	const stamped = structuredClone(base);
	stamped.engagement.rubberStamped = true;

	assert.ok(risk(engaged) < risk(base), "inspecting a change must reduce its risk");
	assert.ok(risk(engaged) < config.thresholds.quiz, "a change you actually reviewed should not gate");
	assert.ok(risk(stamped) >= risk(base), "rubber-stamping must not reduce risk");
});

test("bulk alone never gates: volume only counts in proportion to stakes", () => {
	// The failure mode this guards against is the guard itself surrendering to
	// line count -- nagging about a large mechanical change in a low-stakes
	// file while a small change to a critical one slips past.
	const bigLowStakes = risk(delta({ path: "src/util/format.ts", linesChanged: 400 }));
	const smallCritical = risk(delta({ path: "src/auth/session.ts", linesChanged: 3 }));

	assert.ok(bigLowStakes < config.thresholds.quiz, `400 low-stakes lines must not gate (got ${bigLowStakes.toFixed(2)})`);
	assert.ok(smallCritical > bigLowStakes, "3 critical lines must outrank 400 low-stakes ones");
});

test("size is sub-linear: 10x the lines is far less than 10x the risk", () => {
	const small = risk(delta({ path: "src/util/format.ts", linesChanged: 20 }));
	const large = risk(delta({ path: "src/util/format.ts", linesChanged: 200 }));
	assert.ok(large > small, "more lines should still mean more risk");
	assert.ok(large < small * 3, `size factor grew too fast: ${small.toFixed(2)} -> ${large.toFixed(2)}`);
});

test("hardcoded credentials and destructive SQL gate regardless of location", () => {
	assert.ok(risk(delta({ path: "scripts/seed.js", linesChanged: 2, addedText: 'const token = "sk_live_abc12345xyz"' })) >= config.thresholds.quiz);
	assert.ok(risk(delta({ path: "scripts/cleanup.sql", linesChanged: 1, addedText: "DROP TABLE invoices;" })) >= config.thresholds.quiz);
});

test("ledger merges repeated edits to one file into a single review unit", () => {
	const ledger = new Ledger(config);
	ledger.record({ id: "a", filePath: "/repo/src/auth/x.ts", kind: "edit", linesChanged: 3, addedText: "a", cwd: "/repo" });
	ledger.record({ id: "b", filePath: "/repo/src/auth/x.ts", kind: "edit", linesChanged: 4, addedText: "b", cwd: "/repo" });

	const pending = ledger.pending();
	assert.equal(pending.length, 1, "same file should be one delta");
	assert.equal(pending[0].delta.linesChanged, 7);
	assert.equal(pending[0].delta.path, "src/auth/x.ts");
});

test("an opaque shell mutation stays opaque when merged with observed edits", () => {
	for (const kinds of [
		["edit", "opaque-bash"],
		["opaque-bash", "edit"],
	] as const) {
		const ledger = new Ledger(config);
		ledger.record({ id: "a", filePath: "/repo/src/util/x.ts", kind: kinds[0], linesChanged: 3, addedText: "a", cwd: "/repo" });
		ledger.record({ id: "b", filePath: "/repo/src/util/x.ts", kind: kinds[1], linesChanged: 4, addedText: "b", cwd: "/repo" });

		const [entry] = ledger.pending();
		assert.equal(entry.delta.kind, "opaque-bash", `${kinds.join(" then ")} must remain opaque`);
		assert.equal(entry.score.criticality, config.opaqueBashCriticality);
	}
});

test("ledger credits user inspection and penalizes rubber stamps", () => {
	const ledger = new Ledger(config);
	ledger.record({ id: "a", filePath: "src/auth/x.ts", kind: "edit", linesChanged: 5, addedText: "x", cwd: "/repo" });

	ledger.noteUserCommand("git diff", "/repo");
	assert.ok(ledger.pending()[0].delta.engagement.userInspected, "git diff should count as inspection");

	const other = new Ledger(config);
	other.record({ id: "a", filePath: "src/auth/x.ts", kind: "edit", linesChanged: 5, addedText: "x", cwd: "/repo" });
	other.noteUserInput("lgtm");
	assert.ok(other.pending()[0].delta.engagement.rubberStamped, "'lgtm' should be a rubber stamp");
});

test("verified deltas stop gating", () => {
	const ledger = new Ledger(config);
	ledger.record({ id: "a", filePath: "src/auth/x.ts", kind: "edit", linesChanged: 3, addedText: "x", cwd: "/repo" });
	assert.equal(ledger.gating().length, 1);
	ledger.markVerified(["a"], "quiz");
	assert.equal(ledger.gating().length, 0);
	assert.equal(ledger.pending().length, 0);
});

test("gate command patterns match real publish commands and not reads", () => {
	const matches = (command: string) =>
		config.gate.commands.some((pattern) => new RegExp(pattern, "i").test(command));

	assert.ok(matches("git commit -m 'fix'"));
	assert.ok(matches('git commit -am "x"'));
	assert.ok(matches("git push origin main"));
	assert.ok(matches("gh pr create --base master"));
	assert.ok(!matches("git status"));
	assert.ok(!matches("git diff HEAD"));
	assert.ok(!matches("git log --oneline"));
});
