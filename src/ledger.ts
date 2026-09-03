/**
 * The ledger: which changes this session has produced, and how much attention
 * each one actually received.
 *
 * Deltas accumulate as the agent edits files and are retired when the user
 * demonstrates understanding (quiz, attestation) or explicitly overrides.
 * Engagement signals are folded in as they arrive, so the same change can
 * fall below the gate threshold simply because the user went and read it.
 */

import { normalizePath } from "./glob.ts";
import type { GuardConfig } from "./config.ts";
import { type Delta, type DeltaKind, type RiskScore, scoreDelta } from "./risk.ts";

export interface ScoredDelta {
	delta: Delta;
	score: RiskScore;
}

/** Serializable ledger snapshot, persisted as a Pi custom session entry. */
export interface LedgerSnapshot {
	version: 1;
	deltas: Delta[];
}

const RUBBER_STAMP_WINDOW_MS = 5 * 60_000;

export class Ledger {
	private deltas = new Map<string, Delta>();
	/** Deltas awaiting the user's next input, for dwell/rubber-stamp scoring. */
	private pendingAttention = new Set<string>();
	private sessionDisabled = false;
	private config: GuardConfig;

	constructor(config: GuardConfig) {
		this.config = config;
	}

	setConfig(config: GuardConfig): void {
		this.config = config;
	}

	get disabled(): boolean {
		return this.sessionDisabled || !this.config.enabled;
	}

	setSessionDisabled(disabled: boolean): void {
		this.sessionDisabled = disabled;
	}

	/** Record (or merge into) a change to `filePath`. */
	record(options: {
		id: string;
		filePath: string;
		kind: DeltaKind;
		linesChanged: number;
		addedText: string;
		diff?: string;
		cwd: string;
	}): Delta {
		const path = normalizePath(options.filePath, options.cwd);
		const existing = this.findUnverifiedByPath(path);

		if (existing) {
			// Successive edits to the same file are one review unit: merge so a
			// change hand-edited five times does not demand five quizzes.
			existing.linesChanged += options.linesChanged;
			existing.addedText = `${existing.addedText}\n${options.addedText}`.slice(-200_000);
			existing.diff = options.diff ? `${existing.diff ?? ""}\n${options.diff}`.slice(-200_000) : existing.diff;
			// Once any part of the review unit was changed opaquely, keep the
			// pessimistic classification. A later observed edit does not reveal
			// what the earlier shell command changed, and an opaque mutation must
			// not be hidden merely because the file already had a normal delta.
			existing.kind =
				existing.kind === "opaque-bash" || options.kind === "opaque-bash"
					? "opaque-bash"
					: options.kind;
			existing.engagement.observedAt = Date.now();
			// A fresh change invalidates prior attention: you read the old version.
			existing.engagement.dwellMs = 0;
			existing.engagement.agentReread = false;
			existing.engagement.rubberStamped = false;
			existing.judged = undefined;
			this.pendingAttention.add(existing.id);
			return existing;
		}

		const delta: Delta = {
			id: options.id,
			path,
			kind: options.kind,
			linesChanged: options.linesChanged,
			addedText: options.addedText.slice(-200_000),
			diff: options.diff?.slice(-200_000),
			engagement: {
				observedAt: Date.now(),
				dwellMs: 0,
				userInspected: false,
				discussed: false,
				agentReread: false,
				rubberStamped: false,
			},
		};

		this.deltas.set(delta.id, delta);
		this.pendingAttention.add(delta.id);
		return delta;
	}

	private findUnverifiedByPath(path: string): Delta | undefined {
		for (const delta of this.deltas.values()) {
			if (delta.path === path && !delta.verifiedAt) return delta;
		}
		return undefined;
	}

	/** The agent re-read a file after changing it. Weak engagement signal. */
	noteRead(filePath: string, cwd: string): void {
		const path = normalizePath(filePath, cwd);
		for (const delta of this.deltas.values()) {
			if (delta.path === path && !delta.verifiedAt) delta.engagement.agentReread = true;
		}
	}

	/**
	 * The user ran a command themselves. `git diff`, opening the file in an
	 * editor, or `git blame` is the strongest available signal that a human
	 * actually looked at the change.
	 */
	noteUserCommand(command: string, cwd: string): void {
		const inspects = this.config.engagement.inspectionPatterns.some((pattern) => {
			try {
				return new RegExp(pattern, "i").test(command);
			} catch {
				return false;
			}
		});
		if (!inspects) return;

		// A bare `git diff` covers everything outstanding; a command naming a
		// specific file only credits that file.
		const named = [...this.deltas.values()].filter(
			(delta) => !delta.verifiedAt && commandMentionsPath(command, delta.path, cwd),
		);
		const targets = named.length > 0 ? named : [...this.deltas.values()].filter((delta) => !delta.verifiedAt);

		for (const delta of targets) delta.engagement.userInspected = true;
	}

	/**
	 * Fold the user's latest prompt into engagement: credit dwell time, detect
	 * rubber stamps, and detect substantive discussion of a changed file.
	 */
	noteUserInput(text: string): void {
		const now = Date.now();
		const trimmed = text.trim();
		const isRubberStamp = this.config.engagement.rubberStampPatterns.some((pattern) => {
			try {
				return new RegExp(pattern, "i").test(trimmed);
			} catch {
				return false;
			}
		});

		for (const delta of this.deltas.values()) {
			if (delta.verifiedAt) continue;

			if (this.pendingAttention.has(delta.id)) {
				const elapsed = now - delta.engagement.observedAt;
				// Ignore implausibly long gaps: the user went to lunch, they did
				// not spend two hours reading a 12-line diff.
				if (elapsed < RUBBER_STAMP_WINDOW_MS) {
					delta.engagement.dwellMs += elapsed;
					if (isRubberStamp) delta.engagement.rubberStamped = true;
				}
			}

			if (!isRubberStamp && mentionsDelta(trimmed, delta)) {
				delta.engagement.discussed = true;
			}
		}

		this.pendingAttention.clear();
	}

	/** All unverified deltas, scored, highest risk first. */
	pending(): ScoredDelta[] {
		return [...this.deltas.values()]
			.filter((delta) => !delta.verifiedAt)
			.map((delta) => ({ delta, score: scoreDelta(delta, this.config) }))
			.sort((a, b) => b.score.risk - a.score.risk);
	}

	/** Unverified deltas at or above the gating threshold. */
	gating(): ScoredDelta[] {
		return this.pending().filter((entry) => entry.score.risk >= this.config.thresholds.quiz);
	}

	/** Unverified deltas worth surfacing but not gating. */
	warning(): ScoredDelta[] {
		const { warn, quiz } = this.config.thresholds;
		return this.pending().filter((entry) => entry.score.risk >= warn && entry.score.risk < quiz);
	}

	get(id: string): Delta | undefined {
		return this.deltas.get(id);
	}

	all(): Delta[] {
		return [...this.deltas.values()];
	}

	markVerified(ids: string[], by: NonNullable<Delta["verifiedBy"]>): void {
		const now = Date.now();
		for (const id of ids) {
			const delta = this.deltas.get(id);
			if (!delta) continue;
			delta.verifiedAt = now;
			delta.verifiedBy = by;
		}
	}

	clear(): void {
		this.deltas.clear();
		this.pendingAttention.clear();
	}

	snapshot(): LedgerSnapshot {
		return { version: 1, deltas: this.all() };
	}

	restore(snapshot: LedgerSnapshot): void {
		if (snapshot?.version !== 1 || !Array.isArray(snapshot.deltas)) return;
		this.deltas.clear();
		for (const delta of snapshot.deltas) {
			if (delta && typeof delta.id === "string" && typeof delta.path === "string") {
				this.deltas.set(delta.id, delta);
			}
		}
	}
}

/** Does `command` reference this delta's file? */
function commandMentionsPath(command: string, deltaPath: string, cwd: string): boolean {
	const normalized = normalizePath(deltaPath, cwd);
	if (command.includes(normalized)) return true;
	const basename = normalized.split("/").pop();
	return basename ? command.includes(basename) : false;
}

/**
 * Does the user's prompt engage with this change? Matching the basename, or a
 * distinctive identifier introduced by the change, is a reasonable proxy for
 * "they are talking about this code" rather than nodding it through.
 */
function mentionsDelta(text: string, delta: Delta): boolean {
	if (text.length < 12) return false;

	const lower = text.toLowerCase();
	const basename = delta.path.split("/").pop()?.toLowerCase();
	if (basename && lower.includes(basename)) return true;

	const stem = basename?.replace(/\.[^.]+$/, "");
	if (stem && stem.length >= 4 && lower.includes(stem)) return true;

	for (const symbol of extractSymbols(delta.addedText)) {
		if (lower.includes(symbol.toLowerCase())) return true;
	}
	return false;
}

/** Pull declared identifiers out of added text, as discussion anchors. */
function extractSymbols(addedText: string): string[] {
	const symbols = new Set<string>();
	const declaration =
		/\b(?:function|class|const|let|var|def|struct|interface|type|enum|fn|func)\s+([A-Za-z_][A-Za-z0-9_]{3,})/g;

	for (const match of addedText.matchAll(declaration)) {
		symbols.add(match[1]);
		if (symbols.size >= 40) break;
	}
	return [...symbols];
}
