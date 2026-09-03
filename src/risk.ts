/**
 * Risk scoring.
 *
 * The premise, from practice: cognitive surrender risk is not proportional to
 * how much code was generated. Five hundred lines of conventional Terraform
 * you can validate with `plan` is safer to not-read than three lines inside a
 * session-refresh path. The model therefore makes three primary judgments:
 * blast radius, opacity, and observed human engagement. Volume is only a
 * bounded modifier, not an independent reason to gate:
 *
 *     rawSizeFactor = clamp(1 + log2(1 + lines / sizeReference), 1, maxSizeFactor)
 *     sizeFactor    = 1 + (rawSizeFactor - 1)
 *                         x ((1 - sizeCoupling) + sizeCoupling x criticality)
 *     opacity       = max(1 - familiarity, contentOpacityFloor)
 *     risk          = clamp(criticality x sizeFactor x opacity
 *                           x (1 - engagement), 0, 1)
 *
 * `criticality` answers "what breaks if this is wrong". `opacity` answers "do
 * I need to hold this in my head, or is it a shape I already trust".
 * `engagement` answers "did the human actually look"; its complement is the
 * remaining-unreviewed fraction. Multiplication means no single primary
 * judgment gates by itself. With the default sizeCoupling of 1, line count
 * only amplifies the score in proportion to criticality. The final value is a
 * prioritization score, not a probability that the change is wrong.
 */

import { matchesGlob } from "./glob.ts";
import type { GuardConfig } from "./config.ts";

export interface RiskScore {
	/** Final 0..1 risk. */
	risk: number;
	criticality: number;
	familiarity: number;
	opacity: number;
	sizeFactor: number;
	engagement: number;
	/** Human-readable drivers, most significant first. Used in UI and prompts. */
	reasons: string[];
}

/** Advisory second opinion from a model, blended into the static score. */
export interface JudgeVerdict {
	/** 0..1 — how much this looks like known-shape boilerplate. */
	familiarity: number;
	/** 0..1 — how much blast radius the model thinks this has. */
	criticality: number;
	rationale: string;
}

export type DeltaKind = "edit" | "write" | "opaque-bash";

export interface EngagementState {
	/** When the change landed. Dwell is measured from here. */
	observedAt: number;
	/** Accumulated ms between the change and the user's next input. */
	dwellMs: number;
	/** User ran `git diff`, opened the file, etc. Strongest signal. */
	userInspected: boolean;
	/** A later user prompt referenced this file or a symbol from the change. */
	discussed: boolean;
	/** The file was re-read after the change (weak proxy). */
	agentReread: boolean;
	/** The user's next message was a bare approval. Penalized. */
	rubberStamped: boolean;
}

export interface Delta {
	id: string;
	/** Normalized, repo-relative, POSIX-separated. */
	path: string;
	kind: DeltaKind;
	linesChanged: number;
	/** Newly added text only. Content markers match against this. */
	addedText: string;
	/** Unified diff when available, for quiz generation. */
	diff?: string;
	engagement: EngagementState;
	judged?: JudgeVerdict;
	/** Set once the change has been verified; verified deltas stop gating. */
	verifiedAt?: number;
	verifiedBy?: "quiz" | "attest" | "override";
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Compile-once cache for content marker regexes. */
const markerCache = new Map<string, RegExp>();

function markerRegex(pattern: string): RegExp | undefined {
	let regex = markerCache.get(pattern);
	if (!regex) {
		try {
			regex = new RegExp(pattern, "i");
		} catch {
			return undefined;
		}
		markerCache.set(pattern, regex);
	}
	return regex;
}

export function computeEngagement(state: EngagementState, linesChanged: number, config: GuardConfig): number {
	const settings = config.engagement;
	if (!settings.enabled) return 0;

	const weights = settings.weights;

	// Dwell is credited against the time a change of this size plausibly needs
	// to read. Capped so large diffs do not demand implausible attention.
	const requiredMs = Math.min(settings.maxDwellCreditMs, Math.max(1, linesChanged) * settings.dwellMsPerLine);
	const dwell = clamp(state.dwellMs / requiredMs, 0, 1);

	let score =
		weights.dwell * dwell +
		weights.userInspected * (state.userInspected ? 1 : 0) +
		weights.discussed * (state.discussed ? 1 : 0) +
		weights.agentReread * (state.agentReread ? 1 : 0);

	if (state.rubberStamped) {
		score -= weights.rubberStampPenalty;
	}

	return clamp(score, 0, 1);
}

export function scoreDelta(delta: Delta, config: GuardConfig): RiskScore {
	const reasons: string[] = [];

	// --- criticality: blast radius, from path rules and content markers ---
	let criticality = delta.kind === "opaque-bash" ? config.opaqueBashCriticality : config.baselineCriticality;
	if (delta.kind === "opaque-bash") {
		reasons.push("file changed via shell (diff not observed)");
	}

	for (const rule of config.criticalPaths) {
		if (!matchesGlob(rule.glob, delta.path)) continue;
		if (rule.weight > criticality) {
			criticality = rule.weight;
			reasons.unshift(rule.label);
		} else {
			reasons.push(rule.label);
		}
	}

	// --- opacity: how much of this must live in your head ---
	let familiarity = config.baselineFamiliarity;
	let familiarLabel: string | undefined;
	for (const rule of config.familiarPaths) {
		if (!matchesGlob(rule.glob, delta.path)) continue;
		if (rule.familiarity > familiarity) {
			familiarity = rule.familiarity;
			familiarLabel = rule.label;
		}
	}

	let opacityFloor = 0;
	for (const rule of config.contentMarkers) {
		const regex = markerRegex(rule.pattern);
		if (!regex || !regex.test(delta.addedText)) continue;

		if (rule.weight > criticality) {
			criticality = rule.weight;
			reasons.unshift(rule.label);
		} else {
			reasons.push(rule.label);
		}
		// A dangerous marker overrides "this file is boilerplate": an IAM
		// wildcard buried in conventional Terraform still has to be understood.
		if (rule.opacityFloor && rule.opacityFloor > opacityFloor) {
			opacityFloor = rule.opacityFloor;
		}
	}

	// --- optional model second opinion, blended rather than authoritative ---
	if (delta.judged) {
		const weight = clamp(config.llmJudge.weight ?? 0.5, 0, 1);
		criticality = criticality * (1 - weight) + clamp(delta.judged.criticality, 0, 1) * weight;
		familiarity = familiarity * (1 - weight) + clamp(delta.judged.familiarity, 0, 1) * weight;
		if (delta.judged.rationale) reasons.push(`model: ${delta.judged.rationale}`);
	}

	if (familiarLabel && familiarity > 0.5) {
		reasons.push(`dampened as ${familiarLabel}`);
	}

	const opacity = Math.max(1 - familiarity, opacityFloor);

	// --- size: sub-linear, and scaled by what is actually at stake ---
	// Volume is the weakest signal available, so it gets the weakest role:
	// it amplifies criticality rather than standing in for it. Without the
	// coupling term, a 200-line reformat of a helper would out-score a
	// three-line change to a permission check purely on bulk.
	const rawSizeFactor = clamp(
		1 + Math.log2(1 + Math.max(0, delta.linesChanged) / Math.max(1, config.sizeReference)),
		1,
		config.maxSizeFactor,
	);
	const coupling = clamp(config.sizeCoupling, 0, 1);
	const sizeFactor = 1 + (rawSizeFactor - 1) * (coupling * criticality + (1 - coupling));

	const engagement = computeEngagement(delta.engagement, delta.linesChanged, config);
	if (engagement > 0.5) reasons.push("you engaged with this change");
	if (delta.engagement.rubberStamped) reasons.unshift("approved without review");

	const risk = clamp(criticality * sizeFactor * opacity * (1 - engagement), 0, 1);

	// A path rule and a content marker can carry the same label; keep the
	// first (highest-priority) mention of each.
	return {
		risk,
		criticality,
		familiarity,
		opacity,
		sizeFactor,
		engagement,
		reasons: [...new Set(reasons)],
	};
}

/** Count lines a change touches, treating a rewrite as max(before, after). */
export function countChangedLines(oldText: string, newText: string): number {
	const oldLines = oldText ? oldText.split("\n").length : 0;
	const newLines = newText ? newText.split("\n").length : 0;
	return Math.max(oldLines, newLines);
}
