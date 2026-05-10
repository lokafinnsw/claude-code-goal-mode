# Review Agents — declaring per-node reviewers

This document is the 1.0.0 reference for `review[]`, the per-node array on
each `tree.json` node that lists which subagents must independently approve
the task before the cursor advances. For the schema field shape see
[PLAN-FORMAT.md §3](./PLAN-FORMAT.md). For the budget axes that bound the
review loop see [BUDGET.md](./BUDGET.md).

---

## 1. What is a reviewer?

A **reviewer** in goal-mode is a `subagent_type` string the engine pipes
into the Agent tool when a task transitions to `review-pending`. The engine
itself never knows what a reviewer does — it just dispatches the names that
appear in the plan and waits for the agent to return `<audit-verdict>` tags.

Concretely:

- The plan declares `review: [<name>, ...]` on each node that needs
  approval (`engine/state.mjs:35`).
- When the agent emits `<task-status>achieved</task-status>` AND every
  acceptance criterion is covered, `applyMutations` transitions the cursor
  to `review-pending` and emits a `review-requested` history event
  (`engine/apply-mutations.mjs:152-155`).
- On the next iteration, the Stop hook renders
  `prompts/continuation-review.md` (`engine/stop-hook.mjs:201`) which
  instructs the agent to invoke the Agent tool once per reviewer, passing
  the body of `prompts/audit-instructions.md` as the prompt
  (`prompts/continuation-review.md:7-23`).
- The agent collects verdicts and emits one `<audit-verdict agent="..."
  status="GO|NOGO|REVISE">...</audit-verdict>` per reviewer.
- `applyMutations` consumes the verdict batch
  (`engine/apply-mutations.mjs:176-223`): all-GO advances the cursor; any
  NOGO or REVISE returns the node to `pursuing` and increments
  `review_attempts`. At ≥3 attempts, the node auto-blocks
  (`engine/apply-mutations.mjs:212-216`).

The engine's contract with reviewers is **opaque-string-only**. It never
imports, constructs, or hard-codes any reviewer name.

## 2. How to declare a reviewer

In `tree.json`, the `review` field on each node is a string array
(`engine/state.mjs:35`). Each entry is a `subagent_type` name that Claude
Code recognizes when the agent invokes the Agent tool.

```json
{
  "id": "sprint-1.epic-1.task-1",
  "type": "task",
  "title": "Tune the boss-fight encounter",
  "review": ["rpg-game-designer", "aaa-art-director"],
  ...
}
```

In `plan.md` (the human view — see [PLAN-FORMAT.md §4](./PLAN-FORMAT.md#4-planmd-markdown-convention)),
the same field is rendered as a comma-separated list inside square brackets:

```markdown
**Review:** [rpg-game-designer, aaa-art-director]
```

When the agent emits the request to enter the review-gate, it uses the
self-closed `<review-request>` tag with a comma-separated `agents` attr
(`engine/parse-tags.mjs:122-128`):

```text
<review-request agents="rpg-game-designer, aaa-art-director" />
```

The same comma-separated form is what the continuation prompt expects; the
parser splits on `,` and trims each name (`engine/parse-tags.mjs:126`).

Empty `review[]` (or omitting the line in `plan.md`) means **no review-gate**
— the task advances on its own as soon as criteria are covered
(`engine/apply-mutations.mjs:147-151`).

## 3. Discovery — what `/goal:approve-plan` checks

The plugin tries to give the user advance warning when they declare a
reviewer that is not installed in the current environment.
`/goal:approve-plan` calls `discoverReviewers()` at
`engine/approve-plan-cli.mjs:29-40`, which reads each of:

- `~/.claude/skills/`
- `~/.claude/agents/`
- `<cwd>/.claude/agents/`
- `<cwd>/.claude/skills/`

(see `engine/approve-plan-cli.mjs:42-49`) and builds a `Set<string>` of all
names that appear as direct entries (skill or agent directories named after
their `subagent_type`).

The set is passed into `validatePlan(tree, { availableReviewers })` at
`engine/approve-plan-cli.mjs:75-76`. The validator walks every node and, for
each `review[]` entry not in the set, emits a **warning** — never an error
— at `engine/validate-plan.mjs:74-80`. The CLI prints warnings before
errors at `engine/approve-plan-cli.mjs:135-138`.

**Why warning, not error?** The discovery walk is a heuristic. Some users
keep agents in non-default locations, behind dynamic loaders, or invoke them
with a different name than the directory. A hard refusal would force the
user to fight the validator. The plan author is expected to read the
warnings and either (a) fix the name in `plan.md` and re-run
`/goal:approve-plan`, or (b) accept the warning and manually approve at
runtime via `/goal:approve` (see §4).

## 4. Manual override — `/goal:approve`

When a required reviewer is unavailable in the user's environment (or the
agent emits a NOGO that the user disagrees with after manual inspection),
the user can issue a synthetic GO verdict from the CLI.

The implementation is `engine/manual-approve.mjs:60-140`.

Behaviour:

- Refuses unless `state.lifecycle === 'pursuing'` and the cursor node is
  in `review-pending` status (`engine/manual-approve.mjs:62-75`).
- Writes one audit JSON file at
  `.claude/goals/active/audits/<node-id>-<ts>-manual.json` with
  `{ ts, node_id, kind: "audit-verdict", agent: "manual", status: "GO",
  text: <reason>, manual: true }` (`engine/manual-approve.mjs:80-96`).
- Marks the node `achieved`, advances the cursor (or transitions
  `lifecycle` to `achieved` if this was the last task)
  (`engine/manual-approve.mjs:98-134`).
- Appends `review-verdict` and `cursor-advanced` history events
  (`engine/manual-approve.mjs:108-121`).
- **Does not increment `iterations.used`** — manual approve is a user
  action between iterations, not an iteration of agent work
  (`engine/manual-approve.mjs:102-107` for the design note).

CLI usage:

```text
/goal:approve --reason "reviewer not installed in this environment"
```

The `--reason` text is preserved in the audit file and the history payload.

The continuation prompt itself instructs the agent to fall back to manual
approve when a `subagent_type` is unavailable — see
`prompts/continuation-review.md:36`:

> If a requested reviewer's `subagent_type` is unavailable in this
> environment, emit `<audit-verdict agent="<reviewer>"
> status="REVISE">unavailable; user must run /goal:approve</audit-verdict>`
> so the user is asked to manually approve.

## 5. Three concrete examples

The reviewer names below are illustrative — pick what your project has
installed. The point is shape, not the specific names.

### 5.1 Phaser / JavaScript game (Mancelot-shaped)

Visual art and game design need independent verdicts. Engine code can
self-validate via shell.

```json
{
  "id": "sprint-2.epic-1.task-3",
  "type": "task",
  "title": "Land the boiler-ledge map prop integration",
  "review": ["aaa-art-director", "rpg-game-designer"],
  "validate": "node tests/run.mjs map-load.test.mjs"
}
```

`aaa-art-director` reviews the rendered runtime screenshot;
`rpg-game-designer` reviews the encounter pacing.

### 5.2 Rust backend service

A leaf task that lands a critical-path security change wants a security
reviewer plus a senior Rust reviewer.

```json
{
  "id": "sprint-1.epic-2.task-1",
  "type": "task",
  "title": "Land the JWT verification middleware",
  "review": ["rust-reviewer", "security-reviewer"],
  "validate": "cargo test --package auth -- --include-ignored"
}
```

`cargo test` is the engine-side validation; the human-judgment review
covers crypto-correctness and idiomatic Rust.

### 5.3 Python ML pipeline

A model-training task wants both an ML reviewer (architecture, data
leakage) and a dataops reviewer (pipeline correctness).

```json
{
  "id": "sprint-3.epic-1.task-2",
  "type": "task",
  "title": "Retrain churn classifier with new features",
  "review": ["ml-reviewer", "dataops-reviewer"],
  "validate": "pytest tests/test_churn_pipeline.py -k feature_drift"
}
```

`pytest` proves the pipeline runs; the human-judgment reviewers catch
domain-specific failure modes (overfitting, leakage, misaligned holdouts)
that pytest cannot.

### Important caveat

These names — `aaa-art-director`, `rpg-game-designer`, `rust-reviewer`,
`security-reviewer`, `ml-reviewer`, `dataops-reviewer` — are **placeholder
names**. There is nothing canonical about them. The user can name a
reviewer anything that matches a `subagent_type` they have installed; the
engine treats every name as an opaque string.

## 6. Why opaque?

This is invariant **I1** of the design (the "stack-agnostic engine"
invariant). The argument is straightforward: a goal-mode plugin that
hard-coded reviewer names would force every project to use those names.
A Rust backend has no business with `aaa-art-director`. A Phaser game
has no business with `rust-reviewer`. By treating `review[]` as opaque
strings, the engine adapts trivially to any stack — the plan declares
what to dispatch; the user wires the actual reviewer behind the
`subagent_type`.

The price is that bad names slip past the validator. The `discoverReviewers`
warning at `/goal:approve-plan` time and the manual-approve fallback at
runtime are both there because of this trade-off.

The opacity also means the engine has zero say in **what** the reviewer
checks. The reviewer decides — the engine just records the verdict tag.
The body of `prompts/audit-instructions.md` is what each reviewer sees; it
asks them to map evidence to criteria and rule GO / NOGO / REVISE
(`prompts/audit-instructions.md:19-33`).

## 7. See also

- [PLAN-FORMAT.md](./PLAN-FORMAT.md) — schema reference for `review[]` and
  the surrounding node fields.
- [BUDGET.md](./BUDGET.md) — how `review_attempts` interacts with the
  budget loop.
- [ANTI-PATTERNS.md](./ANTI-PATTERNS.md) — proxy-signal collapse and the
  NOGO/REVISE oscillation defense (3-cycle escalation).
- [SMOKE-TEST.md](./SMOKE-TEST.md) §9 — manual recipe for exercising the
  review-gate end-to-end, including the `/goal:approve` manual override.
