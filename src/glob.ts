/**
 * Minimal, dependency-free glob matcher.
 *
 * Supports the subset of glob syntax that path rules actually need:
 *   `**` (any number of segments), `*` / `?` (within one segment), `{a,b}`
 *   alternation. Anything else is matched literally.
 *
 * Kept in-tree rather than pulling in `minimatch`: extensions load on every
 * Pi startup, so a dependency here is a dependency in the user's hot path.
 */

const REGEX_SPECIALS = /[.+^$()|[\]\\]/g;

function escapeLiteral(char: string): string {
	return char.replace(REGEX_SPECIALS, "\\$&");
}

/** Compile a glob to an anchored RegExp matching POSIX-style relative paths. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	let braceDepth = 0;
	let i = 0;

	while (i < glob.length) {
		const char = glob[i];

		if (char === "*") {
			if (glob[i + 1] === "*") {
				i += 2;
				// `**/` collapses to "zero or more leading segments" so that
				// `**/auth/**` still matches `auth/session.ts` at the root.
				if (glob[i] === "/") {
					i += 1;
					source += "(?:[^/]+/)*";
				} else {
					source += ".*";
				}
			} else {
				i += 1;
				source += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			i += 1;
			continue;
		}

		if (char === "{") {
			braceDepth += 1;
			source += "(?:";
			i += 1;
			continue;
		}

		if (char === "}" && braceDepth > 0) {
			braceDepth -= 1;
			source += ")";
			i += 1;
			continue;
		}

		if (char === "," && braceDepth > 0) {
			source += "|";
			i += 1;
			continue;
		}

		source += escapeLiteral(char);
		i += 1;
	}

	// An unbalanced `{` would produce an invalid pattern; close it out.
	source += ")".repeat(braceDepth);

	return new RegExp(`^${source}$`, "i");
}

/**
 * Normalize a path for matching: POSIX separators, no leading `./` or `/`.
 * Absolute paths are made relative to `root` when they live underneath it.
 */
export function normalizePath(filePath: string, root?: string): string {
	let normalized = filePath.replace(/\\/g, "/");

	if (root) {
		const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
		if (normalized.startsWith(`${normalizedRoot}/`)) {
			normalized = normalized.slice(normalizedRoot.length + 1);
		}
	}

	return normalized.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Cache compiled patterns: the same rule set is matched on every tool call. */
const cache = new Map<string, RegExp>();

export function matchesGlob(glob: string, normalizedPath: string): boolean {
	let regex = cache.get(glob);
	if (!regex) {
		regex = globToRegExp(glob);
		cache.set(glob, regex);
	}
	return regex.test(normalizedPath);
}
