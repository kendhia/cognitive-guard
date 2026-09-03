/**
 * Model-backed reasoning: the second opinion, the quiz, and the grader.
 *
 * Every call here is optional. Static scoring, gating, and attestation all
 * work with no model available; these functions upgrade the experience when
 * one is. Failures degrade to `undefined` and are handled by the caller
 * rather than surfacing as errors mid-commit.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardConfig } from "./config.ts";
import type { JudgeVerdict } from "./risk.ts";
import type { ScoredDelta } from "./ledger.ts";

export interface QuizQuestion {
	question: string;
	options: string[];
	/** Index into `options`. */
	correct: number;
	/** Shown after answering, right or wrong. */
	why: string;
}

export interface Quiz {
	questions: QuizQuestion[];
	/** Open question, graded by the model. Absent when disabled. */
	freeform?: string;
}

export interface FreeformGrade {
	score: number;
	feedback: string;
}

/** Resolve `"provider/model-id"`, falling back to the session's model. */
function resolveModel(ctx: ExtensionContext, spec: string | null) {
	if (spec) {
		const separator = spec.indexOf("/");
		if (separator > 0) {
			const found = ctx.modelRegistry.find(spec.slice(0, separator), spec.slice(separator + 1));
			if (found && ctx.modelRegistry.hasConfiguredAuth(found)) return found;
		}
	}
	return ctx.model;
}

async function complete(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
): Promise<string | undefined> {
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			},
			{ maxTokens, signal: ctx.signal, cacheRetention: "none", sessionId: randomUUID() },
		);

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		return text || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Extract the first JSON object or array from a model response, tolerating
 * fenced code blocks and surrounding prose.
 */
export function extractJson<T>(text: string): T | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates = [fenced?.[1], text].filter((value): value is string => typeof value === "string");

	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		try {
			return JSON.parse(trimmed) as T;
		} catch {
			// Fall through to substring scan.
		}

		const start = trimmed.search(/[{[]/);
		if (start === -1) continue;
		const opener = trimmed[start];
		const closer = opener === "{" ? "}" : "]";
		const end = trimmed.lastIndexOf(closer);
		if (end <= start) continue;

		try {
			return JSON.parse(trimmed.slice(start, end + 1)) as T;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/** Render deltas as a diff bundle within a character budget. */
export function renderDiffBundle(entries: ScoredDelta[], maxChars: number): string {
	const budgetPerEntry = Math.max(400, Math.floor(maxChars / Math.max(1, entries.length)));
	const sections: string[] = [];

	for (const { delta, score } of entries) {
		const body = (delta.diff ?? delta.addedText ?? "").slice(0, budgetPerEntry);
		sections.push(
			[
				`--- ${delta.path}`,
				`risk ${score.risk.toFixed(2)} | ${delta.linesChanged} lines changed | ${score.reasons.slice(0, 4).join(", ") || "no specific markers"}`,
				body,
			].join("\n"),
		);
	}

	return sections.join("\n\n").slice(0, maxChars);
}

const JUDGE_SYSTEM_PROMPT = `You assess whether a code change is something an engineer can safely ship without understanding it in detail.

Return ONLY a JSON object:
{"criticality": <0..1>, "familiarity": <0..1>, "rationale": "<max 12 words>"}

criticality = blast radius if this change is subtly wrong. High for auth, money, permissions, data migrations, concurrency, infrastructure deletion. Low for docs, tests, styling, logging.

familiarity = how far this is conventional, known-shape code whose correctness is verified by tooling rather than by reading. High for scaffolding, boilerplate resource definitions, generated code, mechanical refactors. Low for bespoke business logic and anything with non-obvious control flow.

Judge by what the change DOES, not by how many lines it is. A large block of conventional infrastructure config is high familiarity. A three-line change to a permission check is low familiarity and high criticality.`;

export async function judgeDelta(
	ctx: ExtensionContext,
	config: GuardConfig,
	entry: ScoredDelta,
): Promise<JudgeVerdict | undefined> {
	const model = resolveModel(ctx, config.llmJudge.model);
	if (!model) return undefined;

	const prompt = [
		`File: ${entry.delta.path}`,
		`Lines changed: ${entry.delta.linesChanged}`,
		`Static signals: ${entry.score.reasons.slice(0, 6).join(", ") || "none"}`,
		"",
		"Change:",
		(entry.delta.diff ?? entry.delta.addedText).slice(0, 6000),
	].join("\n");

	const response = await complete(ctx, model, JUDGE_SYSTEM_PROMPT, prompt, 300);
	if (!response) return undefined;

	const parsed = extractJson<Partial<JudgeVerdict>>(response);
	if (!parsed || typeof parsed.criticality !== "number" || typeof parsed.familiarity !== "number") {
		return undefined;
	}

	return {
		criticality: parsed.criticality,
		familiarity: parsed.familiarity,
		rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 120) : "",
	};
}

const QUIZ_SYSTEM_PROMPT = `You write short comprehension checks for an engineer about to commit code an AI wrote for them. The goal is to detect whether they understand the consequences of the change, not to test trivia.

Return ONLY a JSON object:
{"questions": [{"question": "...", "options": ["...", "...", "...", "..."], "correct": <index>, "why": "..."}], "freeform": "..."}

Rules:
- Each question must be answerable ONLY by someone who understood this specific change. Never ask anything answerable from general knowledge or from the file name.
- Ask about consequences: what breaks, what the failure mode is, which call sites are affected, what the change does at a boundary or edge case, what it silently permits or forbids.
- Never ask "how many lines changed" or anything about code style.
- Exactly one option is correct. The wrong options must be plausible to someone who skimmed the diff and accepted it, and wrong for a specific reason.
- "why" explains in one or two sentences why the correct answer is correct.
- "freeform" is one open question asking what would break in production if this change were subtly wrong. Omit the key if not requested.
- Options must be under 140 characters each.`;

export async function generateQuiz(
	ctx: ExtensionContext,
	config: GuardConfig,
	entries: ScoredDelta[],
): Promise<Quiz | undefined> {
	const model = resolveModel(ctx, config.quiz.model);
	if (!model) return undefined;

	const prompt = [
		`Write exactly ${config.quiz.questions} multiple-choice question(s)${config.quiz.freeform ? " and one freeform question" : ", and omit the freeform key"}.`,
		"",
		"These changes were flagged as risky to ship unread:",
		"",
		renderDiffBundle(entries, config.quiz.maxDiffChars),
	].join("\n");

	const response = await complete(ctx, model, QUIZ_SYSTEM_PROMPT, prompt, 2500);
	if (!response) return undefined;

	const parsed = extractJson<Quiz>(response);
	if (!parsed || !Array.isArray(parsed.questions)) return undefined;

	const questions = parsed.questions
		.filter(
			(question): question is QuizQuestion =>
				typeof question?.question === "string" &&
				Array.isArray(question.options) &&
				question.options.length >= 2 &&
				question.options.every((option) => typeof option === "string") &&
				typeof question.correct === "number" &&
				question.correct >= 0 &&
				question.correct < question.options.length,
		)
		.slice(0, Math.max(1, config.quiz.questions))
		.map((question) => ({ ...question, why: typeof question.why === "string" ? question.why : "" }));

	if (questions.length === 0) return undefined;

	return {
		questions,
		freeform: config.quiz.freeform && typeof parsed.freeform === "string" ? parsed.freeform : undefined,
	};
}

const GRADER_SYSTEM_PROMPT = `You grade an engineer's explanation of a code change they are about to commit.

Return ONLY a JSON object: {"score": <0..1>, "feedback": "<max 40 words>"}

Score on whether they identified a real, specific consequence of THIS change.
- 0.8-1.0: names a concrete failure mode or affected behaviour that follows from the change.
- 0.4-0.7: broadly correct direction but vague, or misses the main risk.
- 0.0-0.3: generic, evasive, restates the diff without consequence, or is wrong.

Feedback speaks directly to the engineer and, when the score is low, names the risk they missed.`;

export async function gradeFreeform(
	ctx: ExtensionContext,
	config: GuardConfig,
	entries: ScoredDelta[],
	question: string,
	answer: string,
): Promise<FreeformGrade | undefined> {
	const model = resolveModel(ctx, config.quiz.model);
	if (!model) return undefined;

	const prompt = [
		"Change under review:",
		renderDiffBundle(entries, Math.min(config.quiz.maxDiffChars, 8000)),
		"",
		`Question: ${question}`,
		`Their answer: ${answer}`,
	].join("\n");

	const response = await complete(ctx, model, GRADER_SYSTEM_PROMPT, prompt, 400);
	if (!response) return undefined;

	const parsed = extractJson<Partial<FreeformGrade>>(response);
	if (!parsed || typeof parsed.score !== "number") return undefined;

	return {
		score: Math.min(1, Math.max(0, parsed.score)),
		feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
	};
}
