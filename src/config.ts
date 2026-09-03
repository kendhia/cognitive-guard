/**
 * Configuration: schema, defaults, and layered loading.
 *
 * Layers, later overriding earlier:
 *   1. built-in defaults (below)
 *   2. `~/.pi/agent/cognitive-guard.json`      (personal calibration)
 *   3. `<project>/.pi/cognitive-guard.json`    (team calibration, trusted projects only)
 *
 * Merge is deep for objects. Arrays of rules are *appended* by default so a
 * project can add rules without restating the defaults; set
 * `"replaceRules": true` in a layer to discard inherited rules instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** A path rule raises criticality for files whose path matches `glob`. */
export interface CriticalPathRule {
	glob: string;
	/** 0..1 — how much blast radius a change here has. */
	weight: number;
	/** Shown to the user and to the quiz generator, e.g. "authentication". */
	label: string;
}

/** A path rule marks files as known-shape code you can safely not memorize. */
export interface FamiliarPathRule {
	glob: string;
	/** 0..1 — how boilerplate/predictable this file is. */
	familiarity: number;
	label: string;
}

/** A content rule inspects the changed text itself, not the path. */
export interface ContentMarkerRule {
	/** JavaScript regex source, matched case-insensitively against added text. */
	pattern: string;
	/** 0..1 — criticality this marker implies. */
	weight: number;
	/**
	 * 0..1 — floor on opacity. Guarantees a marker survives a high
	 * `familiarity` score: an IAM wildcard inside otherwise-boilerplate
	 * Terraform is still something you must understand.
	 */
	opacityFloor?: number;
	label: string;
}

export interface EngagementConfig {
	enabled: boolean;
	/** Dwell time credited per changed line before a change counts as "read". */
	dwellMsPerLine: number;
	/** Cap on required dwell, so a 2000-line diff does not demand 13 minutes. */
	maxDwellCreditMs: number;
	weights: {
		dwell: number;
		userInspected: number;
		discussed: number;
		agentReread: number;
		/** Subtracted when the user's next message is a bare approval. */
		rubberStampPenalty: number;
	};
	/** Regexes (whole-message, case-insensitive) that count as rubber stamps. */
	rubberStampPatterns: string[];
	/** Bash commands that count as the user inspecting changes themselves. */
	inspectionPatterns: string[];
}

export interface GateConfig {
	/** Regexes matched against bash commands that should be gated. */
	commands: string[];
	/** What to do when no interactive UI is available (`-p`, `--mode json`). */
	nonInteractive: "block" | "warn" | "allow";
	/** What to do when the quiz cannot be generated (no model, API failure). */
	fallback: "attest" | "block" | "allow";
	/** Minimum characters for a free-text answer to count in `attest` mode. */
	attestMinChars: number;
	/** Append override decisions to `~/.pi/agent/cognitive-guard-audit.jsonl`. */
	auditOverrides: boolean;
}

export interface QuizConfig {
	/** Number of multiple-choice questions to generate. */
	questions: number;
	/** 0..1 — fraction of points needed to pass. */
	passScore: number;
	/** Also require a free-text "what breaks if this is wrong" answer. */
	freeform: boolean;
	/** `"provider/model-id"` for quiz generation. Null uses the session model. */
	model: string | null;
	/** Diff budget sent to the quiz generator. */
	maxDiffChars: number;
}

export interface LlmJudgeConfig {
	/**
	 * Ask a model whether a change is known-shape boilerplate or load-bearing
	 * logic. This is the escape valve for cases static rules cannot see.
	 */
	enabled: boolean;
	/** Only consult the judge for changes already scoring at least this high. */
	minRiskToConsult: number;
	/**
	 * 0..1 — how much the model's opinion moves criticality and familiarity.
	 * The judge is advisory: at 0 it is ignored, at 1 it fully replaces the
	 * static path/content assessment. Default blends the two evenly.
	 */
	weight: number;
	model: string | null;
}

export interface PromptInjectionConfig {
	enabled: boolean;
	/** Cap files named in the injected prompt. Keeps the injection short. */
	maxFiles: number;
	/** Hard cap on injected characters. The injection must stay cheap. */
	maxChars: number;
}

export interface GuardConfig {
	enabled: boolean;
	thresholds: {
		/** Risk at or above this gates commit/push behind a quiz. */
		quiz: number;
		/** Risk at or above this is surfaced but not gated. */
		warn: number;
	};
	/**
	 * Changed-line count treated as "one unit" of review effort. Size enters
	 * the score logarithmically against this reference, which is what keeps
	 * 500 lines of known boilerplate below 3 lines of auth logic.
	 */
	sizeReference: number;
	/** Cap on the size multiplier. Beyond this, more lines add nothing. */
	maxSizeFactor: number;
	/**
	 * 0..1 — how much the size multiplier is scaled by criticality.
	 *
	 * At 1 (default) volume only counts in proportion to what is at stake, so
	 * a large change to a low-stakes file can never be promoted into gating on
	 * bulk alone. At 0, size applies uniformly and line count can gate by
	 * itself. This is the knob to turn if you *do* want big diffs challenged
	 * regardless of where they land.
	 */
	sizeCoupling: number;
	/** Criticality for files matching no rule. */
	baselineCriticality: number;
	/** Familiarity for files matching no rule. */
	baselineFamiliarity: number;
	/** Criticality assigned to file mutations made opaquely through bash. */
	opaqueBashCriticality: number;
	/**
	 * Bash commands that mutate files without producing a reviewable diff.
	 * These are tracked pessimistically: the guard never saw what changed.
	 */
	opaqueBashPatterns: string[];
	criticalPaths: CriticalPathRule[];
	familiarPaths: FamiliarPathRule[];
	contentMarkers: ContentMarkerRule[];
	engagement: EngagementConfig;
	gate: GateConfig;
	quiz: QuizConfig;
	llmJudge: LlmJudgeConfig;
	promptInjection: PromptInjectionConfig;
}

/**
 * Defaults are deliberately opinionated: they encode "risk is about blast
 * radius and opacity, not volume". Retune `criticalPaths` for your codebase —
 * that is the single highest-leverage knob.
 */
export const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	thresholds: { quiz: 0.55, warn: 0.3 },
	sizeReference: 60,
	maxSizeFactor: 4,
	sizeCoupling: 1,
	baselineCriticality: 0.25,
	baselineFamiliarity: 0.1,
	opaqueBashCriticality: 0.5,
	opaqueBashPatterns: [
		"\\bsed\\s+(-[a-z]*i|--in-place)",
		"\\bperl\\s+-[a-z]*i",
		"\\b(tee|truncate|dd)\\b",
		"\\b(patch|git\\s+apply)\\b",
		">>?\\s*[^\\s|&>]+",
		"\\b(mv|cp|install)\\s+[^|]*\\s+[^\\s|]+$",
		"\\bjq\\b[^|]*--in-place",
	],

	criticalPaths: [
		{ glob: "**/{auth,authn,authz,session,sessions}/**", weight: 0.95, label: "authentication/session" },
		{ glob: "**/*{auth,login,logout,token,jwt,oauth,password,credential}*.{ts,tsx,js,jsx,py,go,rs,java,rb}", weight: 0.9, label: "authentication" },
		{ glob: "**/{payment,payments,billing,invoice,invoicing,ledger,payout,payouts}/**", weight: 0.95, label: "payments/money" },
		{ glob: "**/*{payment,charge,refund,invoice,price,pricing,vat,tax,currency,amount}*.{ts,tsx,js,jsx,py,go,rs,java,rb}", weight: 0.85, label: "money math" },
		{ glob: "**/{permission,permissions,policy,policies,rbac,acl,roles}/**", weight: 0.9, label: "permissions" },
		{ glob: "**/{migration,migrations,alembic}/**", weight: 0.9, label: "schema migration" },
		{ glob: "**/*.sql", weight: 0.75, label: "SQL" },
		{ glob: "**/{firestore,database}.rules", weight: 0.95, label: "database security rules" },
		{ glob: "**/{firestore.indexes.json,storage.rules,firebase.json}", weight: 0.8, label: "Firebase config" },
		{ glob: "**/*{iam,role,policy}*.{tf,ts,py,json,yaml,yml}", weight: 0.85, label: "IAM" },
		{ glob: "**/{crypto,encryption,signing,secrets}/**", weight: 0.95, label: "cryptography/secrets" },
		{ glob: "**/*{webhook,callback}*.{ts,tsx,js,py,go}", weight: 0.7, label: "webhook handling" },
		{ glob: "**/{middleware,middlewares}/**", weight: 0.7, label: "request middleware" },
		{ glob: "**/*{concurren,lock,mutex,transaction,idempoten}*.*", weight: 0.8, label: "concurrency/idempotency" },
		{ glob: ".github/workflows/**", weight: 0.6, label: "CI pipeline" },
		{ glob: "**/{Dockerfile,docker-compose*.yml,docker-compose*.yaml}", weight: 0.55, label: "container config" },
	],

	familiarPaths: [
		{ glob: "**/*.{test,spec}.{ts,tsx,js,jsx,py,go,rb}", familiarity: 0.85, label: "tests" },
		{ glob: "**/{test,tests,__tests__,spec,e2e}/**", familiarity: 0.8, label: "tests" },
		{ glob: "**/*.{md,mdx,txt,rst}", familiarity: 0.95, label: "docs" },
		{ glob: "**/{generated,__generated__,gen,codegen}/**", familiarity: 0.95, label: "generated code" },
		{ glob: "**/*.{gen,generated}.*", familiarity: 0.95, label: "generated code" },
		{ glob: "**/{package-lock.json,yarn.lock,poetry.lock,pnpm-lock.yaml,Cargo.lock,go.sum}", familiarity: 0.98, label: "lockfile" },
		{ glob: "**/__snapshots__/**", familiarity: 0.95, label: "snapshots" },
		{ glob: "**/*.stories.{ts,tsx,js,jsx}", familiarity: 0.85, label: "stories" },
		{ glob: "**/{fixtures,mocks,__mocks__,testdata}/**", familiarity: 0.85, label: "fixtures" },
		// Infrastructure scaffolding: verbose, conventional, and usually
		// validated by `plan`/`apply` rather than by reading. Content markers
		// below pull the dangerous parts back up via `opacityFloor`.
		{ glob: "**/*.tf", familiarity: 0.7, label: "Terraform boilerplate" },
		{ glob: "**/*.{tfvars,tfstate}", familiarity: 0.7, label: "Terraform vars" },
		{ glob: "**/{types,interfaces}/**", familiarity: 0.7, label: "type declarations" },
		{ glob: "**/*.d.ts", familiarity: 0.85, label: "type declarations" },
		{ glob: "**/*.{css,scss,less}", familiarity: 0.8, label: "styles" },
		{ glob: "**/{i18n,locales,translations}/**", familiarity: 0.9, label: "translations" },
	],

	contentMarkers: [
		{ pattern: "\\bDROP\\s+(TABLE|COLUMN|DATABASE|SCHEMA)\\b", weight: 0.98, opacityFloor: 0.95, label: "destructive DDL" },
		{ pattern: "\\bTRUNCATE\\b|\\bDELETE\\s+FROM\\b(?![\\s\\S]{0,80}WHERE)", weight: 0.95, opacityFloor: 0.9, label: "unscoped delete" },
		{ pattern: "\\b(rm\\s+-rf|force_destroy|prevent_destroy\\s*=\\s*false|deletion_protection\\s*=\\s*false)\\b", weight: 0.95, opacityFloor: 0.9, label: "resource destruction" },
		{ pattern: "\"Action\"\\s*:\\s*\"\\*\"|\"Resource\"\\s*:\\s*\"\\*\"|actions\\s*=\\s*\\[\\s*\"\\*\"", weight: 0.95, opacityFloor: 0.9, label: "IAM wildcard" },
		{ pattern: "\\biam:PassRole\\b|\\bsts:AssumeRole\\b|\\bAdministratorAccess\\b", weight: 0.9, opacityFloor: 0.85, label: "privilege escalation surface" },
		{ pattern: "allow\\s+read,\\s*write\\s*:\\s*if\\s+true|allow\\s+.*:\\s*if\\s+true", weight: 0.95, opacityFloor: 0.9, label: "open security rule" },
		{ pattern: "verify\\s*=\\s*False|rejectUnauthorized\\s*:\\s*false|InsecureSkipVerify\\s*:\\s*true|NODE_TLS_REJECT_UNAUTHORIZED", weight: 0.95, opacityFloor: 0.9, label: "TLS verification disabled" },
		{ pattern: "\\beval\\s*\\(|new\\s+Function\\s*\\(|\\bexec\\s*\\(|os\\.system\\s*\\(|shell\\s*=\\s*True", weight: 0.85, opacityFloor: 0.8, label: "dynamic code execution" },
		{ pattern: "\\bpickle\\.loads?\\b|yaml\\.load\\s*\\((?![^)]*Safe)", weight: 0.85, opacityFloor: 0.8, label: "unsafe deserialization" },
		{ pattern: "--force\\b|--no-verify\\b|force:\\s*true|\\bforce_push\\b", weight: 0.7, opacityFloor: 0.6, label: "forced operation" },
		{ pattern: "\\bchmod\\s+777\\b|\\b0o?777\\b", weight: 0.8, opacityFloor: 0.8, label: "permissive file mode" },
		{ pattern: "publicly_accessible\\s*=\\s*true|\"PublicAccessBlockConfiguration\"|acl\\s*=\\s*\"public", weight: 0.9, opacityFloor: 0.85, label: "public exposure" },
		{ pattern: "\\bexcept\\s*:|\\bcatch\\s*\\(\\s*\\)\\s*\\{\\s*\\}|except\\s+Exception\\s*:\\s*pass", weight: 0.6, opacityFloor: 0.6, label: "swallowed error" },
		{ pattern: "\\bTODO\\b|\\bFIXME\\b|\\bHACK\\b|\\bXXX\\b", weight: 0.45, label: "unfinished marker" },
		{ pattern: "@ts-(ignore|expect-error)|# type:\\s*ignore|\\bas\\s+any\\b|:\\s*any\\b|# noqa", weight: 0.5, opacityFloor: 0.5, label: "type escape hatch" },
		{ pattern: "\\bawait\\s+.*\\bPromise\\.all\\b|asyncio\\.gather|\\bThread\\b|\\bgoroutine\\b|\\bgo\\s+func\\b", weight: 0.6, label: "concurrency" },
		{ pattern: "\\b(secret|api_key|apikey|password|token|private_key)\\s*[:=]\\s*[\"'][^\"'$\\{]{8,}", weight: 0.95, opacityFloor: 0.95, label: "possible hardcoded credential" },
		{ pattern: "\\bfloat\\b.*\\b(price|amount|total|cost)\\b|\\b(price|amount|total)\\b.*\\bparseFloat\\b", weight: 0.85, opacityFloor: 0.8, label: "float money arithmetic" },
		{ pattern: "\\bMath\\.random\\b|\\brandom\\.random\\b", weight: 0.6, label: "non-cryptographic randomness" },
		{ pattern: "\\bretry\\b|\\bbackoff\\b|\\btimeout\\b", weight: 0.5, label: "retry/timeout policy" },
	],

	engagement: {
		enabled: true,
		dwellMsPerLine: 400,
		maxDwellCreditMs: 120_000,
		weights: {
			dwell: 0.3,
			userInspected: 0.4,
			discussed: 0.25,
			agentReread: 0.15,
			rubberStampPenalty: 0.5,
		},
		rubberStampPatterns: [
			"^\\s*(ok|okay|k|kk)\\s*[.!]*$",
			"^\\s*(y|ya|yes|yep|yup|sure|fine)\\s*[.!]*$",
			"^\\s*(go|go ahead|proceed|continue|next|carry on)\\s*[.!]*$",
			"^\\s*(lgtm|sgtm|ship it|looks good|looks fine|great|perfect|nice|cool|awesome)\\s*[.!]*$",
			"^\\s*(thanks|thank you|ty|thx)\\s*[.!]*$",
			"^\\s*(do it|just do it|apply|apply it|commit|commit it|push|push it)\\s*[.!]*$",
			"^\\s*(sounds good|makes sense|agreed|\\+1)\\s*[.!]*$",
		],
		inspectionPatterns: [
			"\\bgit\\s+(diff|show|log\\s+-p|add\\s+-p)\\b",
			"\\b(cat|bat|less|more|head|tail|view)\\b",
			"\\b(code|vim|nvim|nano|emacs|subl|idea)\\b",
			"\\bgit\\s+blame\\b",
		],
	},

	gate: {
		commands: [
			"\\bgit\\s+commit\\b",
			"\\bgit\\s+push\\b",
			"\\bgit\\s+merge\\b",
			"\\bgh\\s+pr\\s+(create|merge|ready)\\b",
			"\\bglab\\s+mr\\s+(create|merge)\\b",
		],
		nonInteractive: "block",
		fallback: "attest",
		attestMinChars: 80,
		auditOverrides: true,
	},

	quiz: {
		questions: 3,
		passScore: 0.7,
		freeform: true,
		model: null,
		maxDiffChars: 12_000,
	},

	llmJudge: {
		enabled: true,
		minRiskToConsult: 0.35,
		weight: 0.5,
		model: null,
	},

	promptInjection: {
		enabled: true,
		maxFiles: 5,
		maxChars: 420,
	},
};

export const CONFIG_FILENAME = "cognitive-guard.json";

export interface LoadedConfig {
	config: GuardConfig;
	/** Files that contributed, in application order. For `/guard config`. */
	sources: string[];
	/** Non-fatal problems (bad JSON, bad regex) to surface to the user. */
	problems: string[];
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge a config layer. Objects merge key-by-key; arrays either append to
 * or replace the inherited value depending on the layer's `replaceRules` flag.
 */
function mergeLayer<T>(base: T, layer: Json, replaceRules: boolean): T {
	if (!isPlainObject(base)) return (layer as unknown as T) ?? base;

	const result: Json = { ...(base as unknown as Json) };

	for (const [key, value] of Object.entries(layer)) {
		if (key === "replaceRules") continue;

		const current = result[key];

		if (Array.isArray(value)) {
			result[key] = replaceRules || !Array.isArray(current) ? value : [...current, ...value];
			continue;
		}

		if (isPlainObject(value) && isPlainObject(current)) {
			result[key] = mergeLayer(current, value, replaceRules);
			continue;
		}

		result[key] = value;
	}

	return result as unknown as T;
}

/** Drop rules whose regex does not compile, rather than failing the load. */
function validate(config: GuardConfig, problems: string[]): GuardConfig {
	const checkPatterns = <T extends { pattern?: string; label?: string }>(rules: T[], origin: string): T[] =>
		rules.filter((rule) => {
			if (!rule.pattern) return true;
			try {
				new RegExp(rule.pattern, "i");
				return true;
			} catch (error) {
				problems.push(`${origin}: invalid regex ${JSON.stringify(rule.pattern)} (${(error as Error).message})`);
				return false;
			}
		});

	const checkRawPatterns = (patterns: string[], origin: string): string[] =>
		patterns.filter((pattern) => {
			try {
				new RegExp(pattern, "i");
				return true;
			} catch (error) {
				problems.push(`${origin}: invalid regex ${JSON.stringify(pattern)} (${(error as Error).message})`);
				return false;
			}
		});

	config.contentMarkers = checkPatterns(config.contentMarkers, "contentMarkers");
	config.gate.commands = checkRawPatterns(config.gate.commands, "gate.commands");
	config.engagement.rubberStampPatterns = checkRawPatterns(
		config.engagement.rubberStampPatterns,
		"engagement.rubberStampPatterns",
	);
	config.engagement.inspectionPatterns = checkRawPatterns(
		config.engagement.inspectionPatterns,
		"engagement.inspectionPatterns",
	);
	config.opaqueBashPatterns = checkRawPatterns(config.opaqueBashPatterns, "opaqueBashPatterns");

	return config;
}

function readLayer(filePath: string, problems: string[]): Json | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (!isPlainObject(parsed)) {
			problems.push(`${filePath}: expected a JSON object`);
			return undefined;
		}
		return parsed;
	} catch (error) {
		problems.push(`${filePath}: ${(error as Error).message}`);
		return undefined;
	}
}

/** Walk up from `cwd` looking for a `.pi/cognitive-guard.json`. */
function findProjectConfig(cwd: string, configDirName: string): string | undefined {
	let dir = cwd;
	for (;;) {
		const candidate = path.join(dir, configDirName, CONFIG_FILENAME);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function loadConfig(options: {
	agentDir: string;
	configDirName: string;
	cwd: string;
	projectTrusted: boolean;
}): LoadedConfig {
	const problems: string[] = [];
	const sources: string[] = ["built-in defaults"];

	// Structured-clone the defaults so array appends never mutate them.
	let config: GuardConfig = structuredClone(DEFAULT_CONFIG);

	const globalPath = path.join(options.agentDir, CONFIG_FILENAME);
	const globalLayer = readLayer(globalPath, problems);
	if (globalLayer) {
		config = mergeLayer(config, globalLayer, globalLayer.replaceRules === true);
		sources.push(globalPath);
	}

	// Project config is executable-adjacent trust: it changes what gets gated,
	// so respect the same trust boundary Pi uses for project extensions.
	const projectPath = findProjectConfig(options.cwd, options.configDirName);
	if (projectPath) {
		if (options.projectTrusted) {
			const projectLayer = readLayer(projectPath, problems);
			if (projectLayer) {
				config = mergeLayer(config, projectLayer, projectLayer.replaceRules === true);
				sources.push(projectPath);
			}
		} else {
			problems.push(`${projectPath}: ignored (project is not trusted)`);
		}
	}

	return { config: validate(config, problems), sources, problems };
}
