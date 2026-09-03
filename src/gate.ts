/**
 * The gate: what happens when you try to commit or push.
 *
 * By the time this runs the ledger already knows which changes are risky and
 * unverified. The gate's job is to convert that into either understanding or
 * an explicit, recorded decision to ship without it — never into a silent pass.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardConfig } from "./config.ts";
import { type Quiz, gradeFreeform, generateQuiz, renderDiffBundle } from "./judge.ts";
import type { Ledger, ScoredDelta } from "./ledger.ts";

export interface GateDecision {
	allow: boolean;
	/** Returned to the model when blocking, so it explains instead of retrying. */
	reason?: string;
	/** Shown to the user via notify. */
	notice?: string;
	noticeLevel?: "info" | "warning" | "error";
}

const ALLOW: GateDecision = { allow: true };

/** Does this bash command look like publishing work? */
export function isGatedCommand(command: string, config: GuardConfig): boolean {
	return config.gate.commands.some((pattern) => {
		try {
			return new RegExp(pattern, "i").test(command);
		} catch {
			return false;
		}
	});
}

function auditPath(agentDir: string): string {
	return path.join(agentDir, "cognitive-guard-audit.jsonl");
}

/**
 * Append a decision to the audit trail. Overrides are the interesting record:
 * a pattern of them is itself the signal worth reviewing later.
 */
export function audit(
	agentDir: string,
	config: GuardConfig,
	record: Record<string, unknown>,
): void {
	if (!config.gate.auditOverrides) return;
	try {
		fs.appendFileSync(
			auditPath(agentDir),
			`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
			"utf-8",
		);
	} catch {
		// The audit log is best-effort; never fail a commit over it.
	}
}

function summarize(entries: ScoredDelta[], limit: number): string {
	return entries
		.slice(0, limit)
		.map(({ delta, score }) => `${delta.path} (${score.risk.toFixed(2)}: ${score.reasons[0] ?? "unreviewed"})`)
		.join(", ");
}

function shuffle<T>(items: T[]): { items: T[]; indexOf: number[] } {
	const order = items.map((_, index) => index);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return { items: order.map((index) => items[index]), indexOf: order };
}

async function showDiff(ctx: ExtensionContext, entries: ScoredDelta[]): Promise<void> {
	const body = [
		"# Changes pending verification",
		"",
		"Read these, close this view (Esc), then answer the questions.",
		"",
		renderDiffBundle(entries, 60_000),
	].join("\n");

	await ctx.ui.editor("Pending changes (read-only reference)", body);
}

/** Ask for and record an explicit override. */
async function requestOverride(
	ctx: ExtensionContext,
	agentDir: string,
	config: GuardConfig,
	ledger: Ledger,
	entries: ScoredDelta[],
	command: string,
): Promise<GateDecision> {
	const reason = await ctx.ui.input(
		"Override — why is it fine to ship this unreviewed?",
		"e.g. generated client, verified by contract tests",
	);

	if (!reason || reason.trim().length < 8) {
		return {
			allow: false,
			reason: "The user declined to record an override reason. Do not retry the commit. Explain the pending changes to them instead.",
			notice: "Override cancelled — nothing was committed",
			noticeLevel: "info",
		};
	}

	audit(agentDir, config, {
		event: "override",
		command,
		reason: reason.trim(),
		files: entries.map(({ delta, score }) => ({ path: delta.path, risk: Number(score.risk.toFixed(3)) })),
	});

	ledger.markVerified(
		entries.map((entry) => entry.delta.id),
		"override",
	);

	return { allow: true, notice: "Override recorded in the audit log", noticeLevel: "warning" };
}

/**
 * Attestation fallback: used when no model can generate a quiz. Weaker than a
 * quiz — it cannot check correctness — but it still forces articulation, which
 * is most of the value.
 */
async function runAttestation(
	ctx: ExtensionContext,
	agentDir: string,
	config: GuardConfig,
	ledger: Ledger,
	entries: ScoredDelta[],
	command: string,
): Promise<GateDecision> {
	const answer = await ctx.ui.editor(
		`Describe what breaks if these changes are wrong (min ${config.gate.attestMinChars} chars)`,
		`Files:\n${entries.map(({ delta }) => `  - ${delta.path}`).join("\n")}\n\n`,
	);

	const written = (answer ?? "")
		.replace(/^Files:[\s\S]*?\n\n/, "")
		.trim();

	if (written.length < config.gate.attestMinChars) {
		return {
			allow: false,
			reason: `Attestation was too short (${written.length}/${config.gate.attestMinChars} characters). Do not retry the commit. Walk the user through what these changes do and what their failure modes are: ${summarize(entries, 5)}.`,
			notice: "Attestation incomplete — nothing was committed",
			noticeLevel: "warning",
		};
	}

	audit(agentDir, config, {
		event: "attestation",
		command,
		attestation: written.slice(0, 2000),
		files: entries.map(({ delta }) => delta.path),
	});

	ledger.markVerified(
		entries.map((entry) => entry.delta.id),
		"attest",
	);

	return { allow: true, notice: "Attestation recorded", noticeLevel: "info" };
}

interface QuizOutcome {
	score: number;
	missed: string[];
	cancelled: boolean;
}

async function askQuiz(ctx: ExtensionContext, config: GuardConfig, quiz: Quiz, entries: ScoredDelta[]): Promise<QuizOutcome> {
	const missed: string[] = [];
	let earned = 0;
	let possible = 0;

	for (const [index, question] of quiz.questions.entries()) {
		possible += 1;
		const { items, indexOf } = shuffle(question.options);
		const labelled = items.map((option, position) => `${position + 1}. ${option}`);

		const choice = await ctx.ui.select(
			`Question ${index + 1} of ${quiz.questions.length}: ${question.question}`,
			labelled,
		);

		if (choice === undefined) return { score: 0, missed, cancelled: true };

		const chosenPosition = labelled.indexOf(choice);
		const originalIndex = chosenPosition === -1 ? -1 : indexOf[chosenPosition];

		if (originalIndex === question.correct) {
			earned += 1;
			ctx.ui.notify(`Correct. ${question.why}`.trim(), "info");
		} else {
			missed.push(`${question.question} -> ${question.options[question.correct]}${question.why ? ` (${question.why})` : ""}`);
			ctx.ui.notify("Not quite.", "warning");
		}
	}

	if (quiz.freeform) {
		const answer = await ctx.ui.editor(quiz.freeform, "");
		if (answer === undefined) return { score: possible > 0 ? earned / possible : 0, missed, cancelled: true };

		possible += 1;
		const grade = await gradeFreeform(ctx, config, entries, quiz.freeform, answer.trim());

		if (grade) {
			earned += grade.score;
			if (grade.feedback) {
				ctx.ui.notify(grade.feedback, grade.score >= 0.6 ? "info" : "warning");
			}
			if (grade.score < 0.6) missed.push(`Freeform answer scored ${grade.score.toFixed(2)}: ${grade.feedback}`);
		} else {
			// Grader unavailable: credit a substantive answer rather than
			// failing the user for an infrastructure problem.
			const substantive = answer.trim().length >= config.gate.attestMinChars;
			earned += substantive ? 1 : 0;
			if (!substantive) missed.push("Freeform answer was too short to count.");
		}
	}

	return { score: possible > 0 ? earned / possible : 1, missed, cancelled: false };
}

/**
 * Run the gate for a publishing command. Returns whether to let it through.
 */
export async function runGate(options: {
	ctx: ExtensionContext;
	agentDir: string;
	config: GuardConfig;
	ledger: Ledger;
	entries: ScoredDelta[];
	command: string;
}): Promise<GateDecision> {
	const { ctx, agentDir, config, ledger, entries, command } = options;

	if (entries.length === 0) return ALLOW;

	// Non-interactive runs cannot quiz anyone. Default to blocking: a CI or
	// `-p` invocation shipping unreviewed auth changes is the failure mode this
	// extension exists to prevent.
	if (!ctx.hasUI) {
		if (config.gate.nonInteractive === "allow") return ALLOW;
		if (config.gate.nonInteractive === "warn") {
			return { allow: true, notice: `cognitive-guard: shipping ${entries.length} unverified change(s)`, noticeLevel: "warning" };
		}
		return {
			allow: false,
			reason: `Blocked by cognitive-guard: ${entries.length} high-risk change(s) have not been reviewed and no interactive UI is available to verify them: ${summarize(entries, 5)}. Do not retry. Report this to the user.`,
		};
	}

	const TAKE = `Answer ${config.quiz.questions} question(s) about these changes`;
	const DIFF = "Show me the diff first";
	const CANCEL = "Cancel — do not commit";
	const OVERRIDE = "Override — ship without reviewing (recorded)";

	for (;;) {
		const choice = await ctx.ui.select(
			`cognitive-guard: ${entries.length} change(s) need verification before ${command.trim().slice(0, 60)}`,
			[TAKE, DIFF, CANCEL, OVERRIDE],
		);

		if (choice === undefined || choice === CANCEL) {
			return {
				allow: false,
				reason: `The user cancelled at the cognitive-guard gate. Do not retry the commit. Offer to walk them through: ${summarize(entries, 5)}.`,
				notice: "Commit cancelled",
				noticeLevel: "info",
			};
		}

		if (choice === OVERRIDE) {
			return requestOverride(ctx, agentDir, config, ledger, entries, command);
		}

		if (choice === DIFF) {
			await showDiff(ctx, entries);
			// Reading the diff is genuine engagement; record it either way.
			for (const { delta } of entries) delta.engagement.userInspected = true;
			continue;
		}

		break;
	}

	const quiz = await generateQuiz(ctx, config, entries);

	if (!quiz) {
		if (config.gate.fallback === "allow") {
			return { allow: true, notice: "cognitive-guard: quiz unavailable, allowing", noticeLevel: "warning" };
		}
		if (config.gate.fallback === "block") {
			return {
				allow: false,
				reason: `Blocked by cognitive-guard: could not generate a comprehension check (no model available) and fallback is set to "block". Do not retry.`,
				notice: "Quiz generation failed",
				noticeLevel: "error",
			};
		}
		return runAttestation(ctx, agentDir, config, ledger, entries, command);
	}

	const outcome = await askQuiz(ctx, config, quiz, entries);

	if (outcome.cancelled) {
		return {
			allow: false,
			reason: `The user abandoned the cognitive-guard check. Do not retry the commit. Explain these changes to them: ${summarize(entries, 5)}.`,
			notice: "Check abandoned",
			noticeLevel: "info",
		};
	}

	audit(agentDir, config, {
		event: "quiz",
		command,
		score: Number(outcome.score.toFixed(3)),
		passed: outcome.score >= config.quiz.passScore,
		files: entries.map(({ delta }) => delta.path),
	});

	if (outcome.score >= config.quiz.passScore) {
		ledger.markVerified(
			entries.map((entry) => entry.delta.id),
			"quiz",
		);
		return {
			allow: true,
			notice: `Passed (${Math.round(outcome.score * 100)}%) — proceeding`,
			noticeLevel: "info",
		};
	}

	return {
		allow: false,
		reason: [
			`Blocked by cognitive-guard: the user scored ${Math.round(outcome.score * 100)}% (needs ${Math.round(config.quiz.passScore * 100)}%) on a comprehension check about these changes.`,
			"Do not retry the commit and do not re-run the check.",
			"Explain the following to them concisely, focusing on failure modes rather than restating the diff:",
			...outcome.missed.map((item) => `- ${item}`),
			"Then let them decide what to do next.",
		].join("\n"),
		notice: `Did not pass (${Math.round(outcome.score * 100)}%) — commit blocked`,
		noticeLevel: "warning",
	};
}
