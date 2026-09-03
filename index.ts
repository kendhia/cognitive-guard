/**
 * cognitive-guard — a Pi extension against cognitive surrender.
 *
 * Cognitive surrender is the point where the model's output becomes your
 * output and there is nothing left that you feel you need to check. This
 * extension watches for it and, when you try to publish work you have not
 * engaged with, makes you demonstrate that you understand it first.
 *
 * The design premise is that risk is not volume. Five hundred lines of
 * conventional infrastructure config you can validate with `plan` is safer to
 * ship unread than three lines inside a session-refresh path. See `src/risk.ts`
 * for the scoring model, and README.md for how to retune it.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type GuardConfig, type LoadedConfig, loadConfig } from "./src/config.ts";
import { audit, isGatedCommand, runGate } from "./src/gate.ts";
import { judgeDelta } from "./src/judge.ts";
import { Ledger, type LedgerSnapshot, type ScoredDelta } from "./src/ledger.ts";
import { countChangedLines } from "./src/risk.ts";

const LEDGER_ENTRY_TYPE = "cognitive-guard-ledger";

/** Upper bound on parallel judge calls per gate, to bound cost and latency. */
const MAX_JUDGE_CALLS = 6;

/**
 * `/guard` reports are sent as custom messages, which means they enter LLM
 * context. That is a deliberate trade: they are user-initiated, bounded to a
 * few lines, and a model that can see which files are unverified gives better
 * answers when asked about them. The always-on injection in
 * `before_agent_start` is the thing kept strictly minimal; this is not it.
 *
 * Session-only entries would avoid the context cost, but rendering them needs
 * `@earendil-works/pi-tui`, which is not resolvable from a standalone
 * extension package.
 */
const STATE_MESSAGE_TYPE = "cognitive-guard";

export default function cognitiveGuard(pi: ExtensionAPI) {
	// Real config is loaded on `session_start`; defaults keep the handlers
	// safe if an event somehow arrives first.
	let loaded: LoadedConfig = { config: structuredClone(DEFAULT_CONFIG), sources: [], problems: [] };
	const ledger = new Ledger(loaded.config);

	// ---------------------------------------------------------------- config

	function reloadConfig(ctx: ExtensionContext): void {
		loaded = loadConfig({
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
		ledger.setConfig(loaded.config);
	}

	const config = (): GuardConfig => loaded.config;

	pi.on("session_start", async (event, ctx) => {
		reloadConfig(ctx);

		if (loaded.problems.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`cognitive-guard config: ${loaded.problems[0]}`, "warning");
		}

		// Restore the ledger so a resumed or reloaded session does not forget
		// what it has already flagged. Fork intentionally starts clean.
		if (event.reason === "resume" || event.reason === "reload" || event.reason === "startup") {
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === LEDGER_ENTRY_TYPE) {
					ledger.restore(entry.data as LedgerSnapshot);
				}
			}
		}

		updateStatus(ctx);
	});

	// ------------------------------------------------------- change tracking

	pi.on("tool_result", async (event, ctx) => {
		if (ledger.disabled || event.isError) return;

		if (event.toolName === "edit") {
			const input = event.input as { path?: string; edits?: { oldText?: string; newText?: string }[] };
			if (!input.path || !Array.isArray(input.edits)) return;

			const lines = input.edits.reduce(
				(total, edit) => total + countChangedLines(edit.oldText ?? "", edit.newText ?? ""),
				0,
			);
			const details = event.details as { patch?: string; diff?: string } | undefined;

			ledger.record({
				id: event.toolCallId,
				filePath: input.path,
				kind: "edit",
				linesChanged: lines,
				addedText: input.edits.map((edit) => edit.newText ?? "").join("\n"),
				diff: details?.patch ?? details?.diff,
				cwd: ctx.cwd,
			});
			updateStatus(ctx);
			return;
		}

		if (event.toolName === "write") {
			const input = event.input as { path?: string; content?: string };
			if (!input.path) return;

			ledger.record({
				id: event.toolCallId,
				filePath: input.path,
				kind: "write",
				linesChanged: countChangedLines("", input.content ?? ""),
				addedText: input.content ?? "",
				cwd: ctx.cwd,
			});
			updateStatus(ctx);
			return;
		}

		if (event.toolName === "read") {
			const input = event.input as { path?: string };
			if (input.path) ledger.noteRead(input.path, ctx.cwd);
			return;
		}

		// Shell mutations produce no diff we can score, so record them
		// pessimistically rather than letting them slip through untracked.
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";
			if (!command || isGatedCommand(command, config())) return;

			const mutates = config().opaqueBashPatterns.some((pattern) => {
				try {
					return new RegExp(pattern, "i").test(command);
				} catch {
					return false;
				}
			});
			if (!mutates) return;

			ledger.record({
				id: event.toolCallId,
				filePath: guessBashTarget(command) ?? "(shell mutation)",
				kind: "opaque-bash",
				linesChanged: 0,
				addedText: command,
				diff: `# executed: ${command}`,
				cwd: ctx.cwd,
			});
			updateStatus(ctx);
		}
	});

	// ------------------------------------------------------ engagement input

	pi.on("input", async (event) => {
		if (!ledger.disabled) ledger.noteUserInput(event.text);
		return undefined;
	});

	pi.on("user_bash", async (event, ctx) => {
		if (!ledger.disabled) {
			ledger.noteUserCommand(event.command, ctx.cwd);
			updateStatus(ctx);
		}
		return undefined;
	});

	// ------------------------------------------------------------- the gate

	pi.on("tool_call", async (event, ctx) => {
		if (ledger.disabled || event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: string }).command ?? "";
		if (!isGatedCommand(command, config())) return undefined;

		const entries = await resolveGatingEntries(ctx);
		if (entries.length === 0) return undefined;

		const decision = await runGate({
			ctx,
			agentDir: getAgentDir(),
			config: config(),
			ledger,
			entries,
			command,
		});

		if (decision.notice && ctx.hasUI) {
			ctx.ui.notify(`cognitive-guard: ${decision.notice}`, decision.noticeLevel ?? "info");
		}
		updateStatus(ctx);

		if (decision.allow) return undefined;
		return { block: true, reason: decision.reason ?? "Blocked by cognitive-guard." };
	});

	/**
	 * Deltas that should gate this publish. The model judge runs here rather
	 * than on every edit: it is the one moment the cost is clearly worth it,
	 * and it can move a change in either direction before we act on it.
	 */
	async function resolveGatingEntries(ctx: ExtensionContext): Promise<ScoredDelta[]> {
		const settings = config().llmJudge;

		if (settings.enabled && ctx.model) {
			// `pending()` is sorted by risk, so capping the fan-out spends the
			// budget on the changes most likely to matter. Verdicts are cached
			// on the delta, so a retried commit does not pay again.
			const candidates = ledger
				.pending()
				.filter((entry) => entry.score.risk >= settings.minRiskToConsult && !entry.delta.judged)
				.slice(0, MAX_JUDGE_CALLS);

			await Promise.all(
				candidates.map(async (entry) => {
					const verdict = await judgeDelta(ctx, config(), entry);
					if (verdict) entry.delta.judged = verdict;
				}),
			);
		}

		return ledger.gating();
	}

	// -------------------------------------------------------- prompt inject

	/**
	 * Injected context is deliberately tiny and only present when something is
	 * actually pending. A guard that permanently costs tokens and attention in
	 * the system prompt would be its own form of noise.
	 */
	pi.on("before_agent_start", async (event) => {
		if (ledger.disabled || !config().promptInjection.enabled) return undefined;

		const gating = ledger.gating();
		const warning = ledger.warning();
		if (gating.length === 0 && warning.length === 0) return undefined;

		const { maxFiles, maxChars } = config().promptInjection;
		const entries = gating.length > 0 ? gating : warning;

		const describe = (count: number) =>
			entries
				.slice(0, count)
				.map(({ delta, score }) => `${delta.path} (${score.reasons[0] ?? "unreviewed"})`)
				.join(", ");

		const build = (count: number) => {
			const body =
				gating.length > 0
					? [
							`Unverified risky changes: ${describe(count)}.`,
							"A commit/push gate will quiz the user on these. When you touch or discuss them, lead with the failure mode in one line; do not summarize the diff.",
						]
					: [`Changes worth a second look: ${describe(count)}.`];
			return ["<cognitive-guard>", ...body, "</cognitive-guard>"].join("\n");
		};

		// Fit the budget by naming fewer files rather than by slicing the text,
		// which would otherwise cut the closing tag off mid-string.
		let injection = build(Math.min(maxFiles, entries.length));
		for (let count = Math.min(maxFiles, entries.length); count > 1 && injection.length > maxChars; count--) {
			injection = build(count - 1);
		}

		return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
	});

	// ---------------------------------------------------------- persistence

	// Snapshots are append-only session entries, so write one only when the
	// ledger actually moved. Otherwise a long session accumulates identical
	// copies of the same state.
	let lastSnapshot = "";

	pi.on("agent_settled", async (_event, ctx) => {
		if (ledger.all().length > 0) {
			const snapshot = ledger.snapshot();
			const serialized = JSON.stringify(snapshot);
			if (serialized !== lastSnapshot) {
				lastSnapshot = serialized;
				pi.appendEntry<LedgerSnapshot>(LEDGER_ENTRY_TYPE, snapshot);
			}
		}
		updateStatus(ctx);
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (ledger.disabled) {
			ctx.ui.setStatus("cognitive-guard", undefined);
			return;
		}

		const gating = ledger.gating().length;
		const warning = ledger.warning().length;

		if (gating === 0 && warning === 0) {
			ctx.ui.setStatus("cognitive-guard", undefined);
			return;
		}

		ctx.ui.setStatus("cognitive-guard", gating > 0 ? `guard ${gating}!` : `guard ${warning}?`);
	}

	// ------------------------------------------------------------- commands

	pi.registerCommand("guard", {
		description: "cognitive-guard: status | config | check | explain <file> | override | reset | on | off",
		getArgumentCompletions: (prefix) =>
			["status", "config", "check", "explain", "override", "reset", "on", "off"]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),

		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const argument = rest.join(" ");

			switch (subcommand) {
				case "on":
					ledger.setSessionDisabled(false);
					ctx.ui.notify("cognitive-guard enabled for this session", "info");
					updateStatus(ctx);
					return;

				case "off":
					ledger.setSessionDisabled(true);
					ctx.ui.notify("cognitive-guard disabled for this session", "warning");
					updateStatus(ctx);
					return;

				case "reset":
					ledger.clear();
					ctx.ui.notify("cognitive-guard ledger cleared", "info");
					updateStatus(ctx);
					return;

				case "config": {
					reloadConfig(ctx);
					const { config: current, sources, problems } = loaded;
					pi.sendMessage(
						{
							customType: STATE_MESSAGE_TYPE,
							display: true,
							content: [
								"cognitive-guard configuration",
								`  sources: ${sources.join(" -> ")}`,
								`  thresholds: quiz >= ${current.thresholds.quiz}, warn >= ${current.thresholds.warn}`,
								`  sizeReference: ${current.sizeReference} lines, maxSizeFactor: ${current.maxSizeFactor}`,
								`  rules: ${current.criticalPaths.length} critical paths, ${current.familiarPaths.length} familiar paths, ${current.contentMarkers.length} content markers`,
								`  quiz: ${current.quiz.questions} question(s), pass >= ${Math.round(current.quiz.passScore * 100)}%, freeform ${current.quiz.freeform ? "on" : "off"}`,
								`  llmJudge: ${current.llmJudge.enabled ? `on (weight ${current.llmJudge.weight}, min risk ${current.llmJudge.minRiskToConsult})` : "off"}`,
								`  engagement: ${current.engagement.enabled ? "on" : "off"}`,
								`  non-interactive: ${current.gate.nonInteractive}, fallback: ${current.gate.fallback}`,
								problems.length > 0 ? `  problems:\n${problems.map((p) => `    - ${p}`).join("\n")}` : "",
							]
								.filter(Boolean)
								.join("\n"),
						},
						{ triggerTurn: false },
					);
					return;
				}

				case "explain": {
					const pending = ledger.pending();
					const matches = argument
						? pending.filter((entry) => entry.delta.path.includes(argument))
						: pending.slice(0, 1);

					if (matches.length === 0) {
						ctx.ui.notify(argument ? `No pending change matching "${argument}"` : "Nothing pending", "info");
						return;
					}

					pi.sendMessage(
						{
							customType: STATE_MESSAGE_TYPE,
							display: true,
							content: matches.map(({ delta, score }) =>
								[
									`${delta.path}  risk ${score.risk.toFixed(2)}`,
									`  criticality ${score.criticality.toFixed(2)} x size ${score.sizeFactor.toFixed(2)} x opacity ${score.opacity.toFixed(2)} x (1 - engagement ${score.engagement.toFixed(2)})`,
									`  ${delta.linesChanged} lines changed, ${delta.kind}`,
									`  drivers: ${score.reasons.join("; ") || "none"}`,
								].join("\n"),
							).join("\n\n"),
						},
						{ triggerTurn: false },
					);
					return;
				}

				case "override": {
					const entries = ledger.gating();
					if (entries.length === 0) {
						ctx.ui.notify("Nothing to override", "info");
						return;
					}
					const reason = argument || (await ctx.ui.input("Override reason", "why is this safe to ship unread?")) || "";
					if (reason.trim().length < 8) {
						ctx.ui.notify("Override needs a reason", "warning");
						return;
					}
					audit(getAgentDir(), config(), {
						event: "override",
						command: "/guard override",
						reason: reason.trim(),
						files: entries.map(({ delta }) => delta.path),
					});
					ledger.markVerified(entries.map((entry) => entry.delta.id), "override");
					ctx.ui.notify(`Overrode ${entries.length} change(s) — recorded in the audit log`, "warning");
					updateStatus(ctx);
					return;
				}

				case "check": {
					const entries = await resolveGatingEntries(ctx);
					if (entries.length === 0) {
						ctx.ui.notify("Nothing needs verification", "info");
						return;
					}
					const decision = await runGate({
						ctx,
						agentDir: getAgentDir(),
						config: config(),
						ledger,
						entries,
						command: "/guard check",
					});
					if (decision.notice) ctx.ui.notify(`cognitive-guard: ${decision.notice}`, decision.noticeLevel ?? "info");
					updateStatus(ctx);
					return;
				}

				default: {
					const pending = ledger.pending();
					if (pending.length === 0) {
						ctx.ui.notify(
							ledger.disabled ? "cognitive-guard is off for this session" : "cognitive-guard: nothing pending",
							"info",
						);
						return;
					}

					const { quiz, warn } = config().thresholds;
					pi.sendMessage(
						{
							customType: STATE_MESSAGE_TYPE,
							display: true,
							content: [
								`cognitive-guard: ${pending.length} unverified change(s)`,
								...pending.map(({ delta, score }) => {
									const marker = score.risk >= quiz ? "GATE" : score.risk >= warn ? "warn" : "  ok";
									return `  [${marker}] ${score.risk.toFixed(2)}  ${delta.path}  (${score.reasons.slice(0, 3).join(", ") || "no markers"})`;
								}),
								"",
								"/guard explain <file> for the score breakdown, /guard check to verify now.",
							].join("\n"),
						},
						{ triggerTurn: false },
					);
				}
			}
		},
	});
}

/** Best-effort guess at which file a shell mutation targeted, for display. */
function guessBashTarget(command: string): string | undefined {
	const redirect = command.match(/>>?\s*([^\s|&>]+)/);
	if (redirect) return redirect[1].replace(/^["']|["']$/g, "");

	const inPlace = command.match(/\b(?:sed|perl)\s+(?:-[^\s]+\s+)*(?:'[^']*'|"[^"]*"|\S+)\s+([^\s|&>]+)/);
	if (inPlace) return inPlace[1].replace(/^["']|["']$/g, "");

	return undefined;
}
