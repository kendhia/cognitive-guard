# cognitive-guard

A [Pi](https://pi.dev) extension that stops you shipping code you don't understand.

[Cognitive surrender](https://addyosmani.com/blog/cognitive-surrender/) is the point where the
model's output becomes *your* output and there is nothing left that you feel you need to check.
This extension watches for it, and when you try to commit or push work you never engaged with,
it makes you demonstrate that you understand it first.

## The premise: risk is not volume

Most "AI guardrail" tooling counts lines. That is the wrong axis, and anyone who has actually
worked this way knows it:

- You ask for an infrastructure-as-code module. You get 500 lines of boilerplate. You do not need
  to hold it in your head — `plan` validates it and the shape is conventional. **Not risky.**
- You ask for a small fix. You get a 3-line change inside a session-refresh path. Miss it and you
  have a silent auth bug. **Very risky.**

So `cognitive-guard` makes three primary judgments — stakes, opacity, and human engagement —
and treats size as a bounded modifier rather than a fourth source of risk. In full, the score is:

```text
rawSizeFactor = clamp(1 + log2(1 + lines / sizeReference), 1, maxSizeFactor)
sizeFactor    = 1 + (rawSizeFactor - 1) * ((1 - sizeCoupling) + sizeCoupling * criticality)
opacity       = max(1 - familiarity, contentOpacityFloor)
risk          = clamp(criticality * sizeFactor * opacity * (1 - engagement), 0, 1)
```

With the default `sizeCoupling = 1`, the second line simplifies to:

```text
sizeFactor = 1 + (rawSizeFactor - 1) * criticality
```

| term | question it answers | comes from |
|---|---|---|
| `criticality` | what breaks if this is subtly wrong? | path rules + content markers + model judge |
| `opacity` | must I hold this in my head, or is it a shape I already trust? | familiar-path rules, floored by dangerous content markers |
| `engagement` | did a human actually look at this? | dwell time, `git diff`, discussion, rubber-stamp detection |
| `sizeFactor` | how much is there to review? | line count, logarithmic, bounded, and coupled to criticality |

The multiplication is deliberate. High stakes alone should not gate familiar output that has
already been inspected; opacity alone should not gate an unfamiliar but harmless file; and a lack
of engagement should matter most when the unread change is both consequential and non-routine.
`1 - engagement` is the remaining-unreviewed fraction: no observed engagement leaves the score
unchanged, while stronger evidence of review pushes it toward zero.

Size is different. It can amplify the score, but it is logarithmic and capped. With the default
coupling, even that amplification is proportional to criticality. This prevents sheer bulk from
turning a low-stakes change into a gate while still distinguishing a three-line critical edit from
a 300-line critical edit. Setting `sizeCoupling` to `0` removes that protection and applies the size
multiplier uniformly.

The final value is a prioritization score, not a probability that the code is wrong. Values at or
above `thresholds.quiz` gate publishing; values at or above `thresholds.warn` are only surfaced.
Under the shipped defaults, a 400-line reformat of a generic helper does not gate, while a
three-line change to a permission check does.

For example, an unreviewed three-line auth change starts with criticality `0.95` and opacity
`0.90`. Its raw size factor is `1.07`; coupling size to criticality makes that `1.07` after rounding.
The result is `clamp(0.95 x 1.07 x 0.90 x 1, 0, 1) = 0.91`, above the default `0.55` quiz threshold.
A 500-line plain Terraform change has criticality `0.25` and opacity `0.30`. Although its raw size
factor hits the cap of `4.00`, coupling reduces the effective factor to `1.75`, giving
`0.25 x 1.75 x 0.30 = 0.13`: below even the warning threshold.

### Calibration with the shipped defaults

| change | risk | verdict |
|---|---|---|
| 3-line auth session change | 0.91 | **gate** |
| 500-line plain Terraform | 0.13 | quiet |
| 500-line Terraform with `actions = ["*"]` | 1.00 | **gate** |
| 40-line payments change | 1.00 | **gate** |
| ...same change, after you ran `git diff` | 0.07 | quiet |
| 10-line `firestore.rules` with `if true` | 1.00 | **gate** |
| 1-line `DROP TABLE` | 0.95 | **gate** |
| 400-line test file | 0.07 | quiet |
| 5000-line lockfile | 0.01 | quiet |
| 200-line generic util | 0.34 | warn |

Reproduce this table any time with `node --test test/scenarios.ts` — the cases above are asserted,
so a retune that breaks the premise fails the suite.

## Install

```bash
pi install /path/to/cognitive-guard          # from a local clone
# or, for one run:
pi -e /path/to/cognitive-guard/index.ts
```

Or symlink it into `~/.pi/agent/extensions/cognitive-guard`.

## What you'll see

Nothing, until something risky is pending. Then:

- A footer indicator: `guard 2!` (gating) or `guard 3?` (worth a look).
- A short, conditional system-prompt injection — capped at 420 characters and **absent entirely
  when nothing is pending**, so it never becomes background noise:

  ```
  <cognitive-guard>
  Unverified risky changes: src/auth/session.ts (authentication/session).
  A commit/push gate will quiz the user on these. When you touch or discuss them, lead with the
  failure mode in one line; do not summarize the diff.
  </cognitive-guard>
  ```

- When the agent runs `git commit` / `git push` / `gh pr create`, a gate:

  ```
  cognitive-guard: 2 change(s) need verification before git commit -m 'fix session'
    > Answer 3 question(s) about these changes
      Show me the diff first
      Cancel — do not commit
      Override — ship without reviewing (recorded)
  ```

  Questions are generated from the actual diff and ask about *consequences* — what breaks, which
  call sites are affected, what the change silently permits. Pass and the commit proceeds. Fail and
  the commit is blocked, with the missed points fed back to the agent so it explains them to you
  rather than retrying.

## Commands

| command | what it does |
|---|---|
| `/guard` | pending changes with risk scores and verdicts |
| `/guard explain <file>` | full score breakdown for one change |
| `/guard config` | effective config and which files it came from |
| `/guard check` | run the comprehension check now, before committing |
| `/guard override [reason]` | clear the gate explicitly; recorded to the audit log |
| `/guard reset` | clear the ledger |
| `/guard off` / `/guard on` | disable/enable for this session |

## Configuration

Layered, later overriding earlier:

1. built-in defaults
2. `~/.pi/agent/cognitive-guard.json` — your personal calibration
3. `<project>/.pi/cognitive-guard.json` — team calibration (trusted projects only)

Rule arrays **append** to inherited rules, so a project adds to the defaults rather than restating
them. Set `"replaceRules": true` in a layer to start from scratch. See
[`examples/cognitive-guard.json`](examples/cognitive-guard.json).

### The knobs that matter most

`criticalPaths` is the highest-leverage setting. The defaults cover auth, payments, permissions,
migrations, IAM, database security rules, crypto, webhooks and concurrency — but *your* critical
paths are specific to your codebase. Add them:

```json
{
  "criticalPaths": [
    { "glob": "services/billing/**", "weight": 0.98, "label": "billing service" }
  ]
}
```

`familiarPaths` is the counterweight: code whose correctness you verify with tooling rather than by
reading. Generated clients, lockfiles, scaffolding. High `familiarity` means low opacity means low
risk, however many lines it is.

`contentMarkers` catch what paths cannot. Each has a `weight` (criticality) and an optional
`opacityFloor` — a floor that survives the familiarity dampener, which is how an IAM wildcard buried
in otherwise-boilerplate Terraform still gates.

### Full reference

| setting | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `thresholds.quiz` | `0.55` | risk at or above this gates commit/push |
| `thresholds.warn` | `0.3` | risk at or above this is surfaced, not gated |
| `sizeReference` | `60` | changed lines treated as one unit of review effort |
| `maxSizeFactor` | `4` | cap on the size multiplier |
| `sizeCoupling` | `1` | how much size is scaled by criticality; set `0` to let bulk gate on its own |
| `baselineCriticality` | `0.25` | criticality for files matching no rule |
| `baselineFamiliarity` | `0.1` | familiarity for files matching no rule |
| `opaqueBashCriticality` | `0.5` | criticality for file mutations made through the shell |
| `opaqueBashPatterns` | `sed -i`, redirects, ... | shell commands that change files without a reviewable diff |
| `engagement.enabled` | `true` | track whether you actually looked |
| `engagement.dwellMsPerLine` | `400` | reading time credited per changed line |
| `engagement.maxDwellCreditMs` | `120000` | cap, so huge diffs don't demand implausible attention |
| `engagement.weights` | see below | contribution of each engagement signal |
| `engagement.rubberStampPatterns` | `ok`, `lgtm`, `go ahead`, ... | messages that count as approving without reading |
| `engagement.inspectionPatterns` | `git diff`, `cat`, `$EDITOR`, ... | commands that count as you inspecting a change |
| `gate.commands` | `git commit`, `git push`, `gh pr create`, ... | commands to gate |
| `gate.nonInteractive` | `"block"` | behaviour with no UI (`-p`, `--mode json`): `block` / `warn` / `allow` |
| `gate.fallback` | `"attest"` | when no quiz can be generated: `attest` / `block` / `allow` |
| `gate.attestMinChars` | `80` | minimum length of a written attestation |
| `gate.auditOverrides` | `true` | append decisions to `~/.pi/agent/cognitive-guard-audit.jsonl` |
| `quiz.questions` | `3` | multiple-choice questions per gate |
| `quiz.passScore` | `0.7` | fraction of points needed to pass |
| `quiz.freeform` | `true` | also require a written "what breaks if this is wrong" |
| `quiz.model` | `null` | `"provider/model-id"`, or the session model |
| `quiz.maxDiffChars` | `12000` | diff budget sent to the generator |
| `llmJudge.enabled` | `true` | ask a model whether a change is boilerplate or load-bearing |
| `llmJudge.minRiskToConsult` | `0.35` | only consult for changes already scoring this high |
| `llmJudge.weight` | `0.5` | how much the model's opinion moves the static score |
| `promptInjection.enabled` | `true` | inject pending-risk context |
| `promptInjection.maxFiles` | `5` | files named in the injection |
| `promptInjection.maxChars` | `420` | hard cap on injected characters |

Engagement weights (`engagement.weights`): `userInspected` 0.4 (you ran `git diff` — strongest
signal), `dwell` 0.3, `discussed` 0.25 (a later prompt referenced the file or a symbol from it),
`agentReread` 0.15 (weak proxy), `rubberStampPenalty` 0.5 (subtracted).

## Design notes

**Cost.** The model judge and the quiz generator only run at the moment you try to publish — never
on every edit. Static scoring, gating, and attestation all work with no model available at all.

**The system prompt stays small.** The injection is conditional and hard-capped. A guard that
permanently costs tokens and attention would be its own form of noise.

**Repeated edits to one file are one review unit.** A file the agent touched five times produces one
quiz, not five. A fresh edit resets accrued attention, because you read the *old* version.

**Engagement is a proxy, not proof.** Dwell time is the weakest of the signals and can be turned off
(`engagement.enabled: false`) if you find it noisy. `git diff` is the signal that actually carries
weight.

**There is always an override.** Friction that cannot be escaped gets ripped out. `Override` is
always offered, always requires a written reason, and is always recorded to
`~/.pi/agent/cognitive-guard-audit.jsonl`. A pattern of overrides is itself the thing worth
reviewing later.

**Non-interactive runs block by default.** A `-p` or CI invocation that ships unreviewed auth
changes is precisely the failure mode this exists to prevent. Set `gate.nonInteractive` to `"warn"`
or `"allow"` if that does not fit your pipeline.

## Development

```bash
npm install
npm run verify        # typecheck + all tests
npm run check         # typecheck only
npm test              # tests only
```

| suite | covers |
|---|---|
| `test/scenarios.ts` | the risk model, the glob matcher, ledger and engagement tracking |
| `test/gate.ts` | the gate paths that work with no model: non-interactive block, override, attestation |
| `test/load.ts` | loading through Pi's own extension loader, plus a full edit -> injection -> blocked-commit pass |

`test/scenarios.ts` asserts the design premise directly — that a 3-line auth change outranks 500
lines of boilerplate, that bulk alone never gates, that a dangerous content marker defeats the
familiarity dampener. Retune the defaults freely, but keep those green.

## Layout

| file | role |
|---|---|
| `index.ts` | event wiring, prompt injection, `/guard` commands |
| `src/config.ts` | schema, defaults, layered loading |
| `src/risk.ts` | the scoring model |
| `src/ledger.ts` | pending changes and engagement tracking |
| `src/gate.ts` | commit/push interception, quiz flow, attestation, override |
| `src/judge.ts` | model calls: second opinion, quiz generation, grading |
| `src/glob.ts` | dependency-free glob matching |
