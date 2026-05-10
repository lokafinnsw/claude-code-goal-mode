# Anti-patterns — failure modes goal-mode defends against

Long-horizon agent loops fail in well-known ways. This is the 1.0.0
catalogue of those failure modes and the engine-level defenses goal-mode
applies. Each entry has the same shape: **what it is**, **why it
happens**, **how the engine defends**, and **what to do if it slips
through**.

For the surface these defenses run on top of, see
[PLAN-FORMAT.md](./PLAN-FORMAT.md), [REVIEW-AGENTS.md](./REVIEW-AGENTS.md),
and [BUDGET.md](./BUDGET.md).

---

## 1. Proxy-signal collapse

**What it is.** The agent declares the task achieved on the basis of a
proxy signal — "tests pass", "the file exists", "the lint check is
silent" — without verifying that acceptance criterion #N is actually met.
This is the single most common failure mode of long-horizon loops and
the headline risk in the design spec (R2, §13).

**Why it happens.** Models trained on developer trajectories pattern-match
"work is done" to "tests pass". When acceptance criteria are the user's
real intent and tests are a proxy for them, the model satisfies the
proxy and stops.

**Defense.** `applyMutations` requires that **every** entry in
`acceptance_criteria[]` have at least one `<evidence>` tag with a
matching `criterion_index` before `<task-status>achieved</task-status>`
advances the cursor. The check is `allCriteriaCovered` at
`engine/apply-mutations.mjs:98-106`; the gate is at
`engine/apply-mutations.mjs:145`. If criteria are not all covered, the
node remains in `pursuing` status (`engine/apply-mutations.mjs:157`) and
the next continuation re-emphasizes the missing criteria.

**Recovery if it slips through.** Review-gates are a second independent
check: `prompts/audit-instructions.md:33` explicitly tells reviewers "Do
not accept 'tests passed' by itself as evidence — verify the test
actually exercises the criterion." If a reviewer rules NOGO, the cursor
returns to `pursuing` (`engine/apply-mutations.mjs:209-211`).

## 2. False promises (Ralph-style escape phrases)

**What it is.** The Ralph Loop plugin uses `<promise>X</promise>` to
signal completion. A model that has seen Ralph patterns may emit
`<promise>` (or other escape phrases like `<done>`, `<complete>`,
`<finished>`) hoping the engine will accept them and stop the loop.

**Why it happens.** The same loop primitives across plugins lead to the
agent generalizing "magic completion tag" as a category.

**Defense.** The parser only recognizes the documented tag set —
`<evidence>`, `<task-status>`, `<blocker>`, `<review-request>`,
`<audit-verdict>`. Anything else is silently ignored
(`engine/parse-tags.mjs:89-141`). `<promise>`, `<done>`, `<complete>`,
`<finished>` and any other escape phrase produces zero parser output and
zero state mutation. The continuation prompt also explicitly tells the
agent not to emit them (`prompts/continuation.md:41` — "Do not output a
`<promise>` tag or any other escape phrase. The engine ignores them.").

**Recovery if it slips through.** It cannot — the parser's tag set is
closed. If the agent emits no recognized tags, the cursor stays exactly
where it was and the next iteration's continuation re-emphasizes what
the agent should be emitting.

## 3. Criteria laundering

**What it is.** The agent rewrites `acceptance_criteria[]` mid-run to be
easier to satisfy (e.g., changes "function returns correct values for
inputs A, B, C" to "function compiles"), then declares achievement.

**Why it happens.** When criteria are visible to the agent and the agent
has file-write capability, the path of least resistance is to weaken the
spec rather than meet it.

**Defense.** The plan tree is **locked** at `/goal:approve-plan`
(`engine/approve-plan-cli.mjs:94-118`). `applyMutations` does not modify
`node.acceptance_criteria` anywhere — its mutation surface covers only
runtime fields (`status`, `evidence`, `review_attempts`,
`blocker_reason`, cursor advancement). The continuation prompt also
explicitly forbids direct edits to the state files
(`prompts/continuation.md:39` — "Do not edit
`.claude/goals/active/tree.json` or `state.json` directly. Emit tags;
the engine will mutate state.").

If the agent does directly edit `tree.json` despite the prompt,
the next `loadTree` re-validates against the schema. A schema-breaking
edit (missing field, wrong type, empty `acceptance_criteria` on a task,
empty `id` or `title`) causes the broken file to be preserved as
`tree.json.broken-<ts>-<seq>` (`engine/state.mjs:155-167`) and
`loadTree` returns `null` — the Stop hook silently exits at
`engine/stop-hook.mjs:117-118`.

**Recovery if it slips through.** A semantically-bad edit that still
passes the schema (e.g., the agent rewrites a criterion's text to be
trivial) is not caught at load time. The user notices on `/goal:status`
or by reading `plan.md` and reverts the edit before re-running. This
is the design spec's R2 residual risk — the review-gate is the
defense-in-depth.

## 4. Scope creep mid-run

**What it is.** While pursuing task A, the agent decides to also do task
B (it noticed something related and figured "while I'm here"). The
result: task B is partially done with no evidence trail, the cursor is
still on A, and history shows ambiguous mutations.

**Why it happens.** Helpful-agent training. "Notice and address" is a
strong prior.

**Defense.** The cursor is **single-task at a time**.
`applyMutations` operates only on the cursor node — it captures
`cursorNode = findNodeById(tree, state.cursor)` at the start of the
function (`engine/apply-mutations.mjs:114`) and every evidence
tag, every status mutation, every blocker reason lands on that node
(`engine/apply-mutations.mjs:121-167`). Tags emitted about other nodes
have no addressable target — there is no "node_id" attribute on
`<evidence>` or `<task-status>`. The parser does not even accept one.

**Recovery if it slips through.** If the agent does work on task B
without emitting any tags about B, the work happens but is invisible to
the engine. When the cursor eventually reaches B, the agent should
discover the existing work via `Read`/`Bash` and emit retroactive
evidence. This is graceful degradation, not catastrophe — the work is
not lost, just unattributed until the cursor catches up.

## 5. Code-fenced example tags triggering real mutations

**What it is.** The continuation prompts contain illustrative example
tags inside code fences — e.g., `prompts/continuation.md:26-28` shows
`<evidence file="path" line="N" criterion="i" note="..." />` as a
syntax example. An agent that paraphrases the prompt back into its
response (a common pattern) would have the parser pick up the example
tags as real evidence.

**Why it happens.** "Repeat the instructions" is a recurring agent
behaviour, especially when the prompt is long.

**Defense.** `engine/stop-hook.mjs::stripCodeRegions` at
`engine/stop-hook.mjs:97-101` strips both fenced blocks (```` ``` ```` …
```` ``` ````) and inline backtick spans (\`...\`) from the agent's text
**before** parsing tags. The convention is: **canonical tags live in
prose, never inside backticks or fences**. The continuation prompts
themselves obey this convention — the example tags are inside fences,
so when the agent quotes them, they are also inside fences and stripped
out.

This is the Phase-4 I-1 hardening fix-up; the comment at
`engine/stop-hook.mjs:85-95` documents the rationale.

**Recovery if it slips through.** If an agent emits a real evidence tag
inside backticks, the parser will not see it — but neither will it
trigger spurious mutations from example tags. The defense is symmetric.
The agent's next iteration's continuation will re-emphasize that
criteria are not yet covered.

## 6. NOGO/REVISE oscillation

**What it is.** The agent submits work, the reviewer rules NOGO, the
agent re-submits identical work, the reviewer rules NOGO again, and so
on. Without escalation, this is an infinite loop.

**Why it happens.** When the reviewer's verdict text is vague or the
agent does not understand which criterion failed, the agent's "address
concerns" pass produces no real change.

**Defense.** Three-cycle escalation. `cursorNode.review_attempts`
increments on every audit-verdict batch containing NOGO or REVISE
(`engine/apply-mutations.mjs:209-211`). At `review_attempts >= 3` the
node auto-blocks (`engine/apply-mutations.mjs:212-216`). The same
counter is also incremented on `<task-status>blocked</task-status>`
(`engine/apply-mutations.mjs:161`), and the lifecycle escalation gate
at `engine/apply-mutations.mjs:240-248` transitions
`state.lifecycle` to `unmet` when the cursor's node is blocked with
`review_attempts >= 3`.

**Recovery if it slips through.** It cannot — the counter is
authoritative. If the user wants to give the agent more attempts, they
can manually edit `state.json` to reset `review_attempts` (against the
recommendation) or use `/goal:approve --reason "..."` to manually
override the verdict (`engine/manual-approve.mjs:60-140`).

## 7. Cursor regression / state corruption attacks

**What it is.** Manual edits to `state.json` to roll back the cursor
("retry the previous task"), zero out `review_attempts`, or change
`lifecycle`. These can be hand-edits by the user or hostile-agent
attempts to escape blocking.

**Why it happens.** `state.json` is plain JSON in the project's
`.claude/goals/active/`. It is editable.

**Defense.** Every load goes through `GoalStateSchema.parse` via
`readWithBackup` at `engine/state.mjs:141-167`. Schema-violating edits
(missing fields, wrong types, invalid enum values) cause the file to be
preserved as `state.json.broken-<ts>-<seq>` for forensic recovery
(`engine/state.mjs:159-165`) and `loadState` returns `null`. The Stop
hook then silently exits at `engine/stop-hook.mjs:113`. The loop ends
cleanly rather than running on corrupt state.

The sequence-suffix on the broken-file name (`engine/state.mjs:160-164`)
prevents collisions when multiple corrupt loads happen within the same
millisecond (tight crash loops) — without it the broken file would be
silently overwritten and forensic data lost.

**Recovery if it slips through.** A semantically-bad but
schema-conforming edit (e.g., `cursor` rolled back to a prior task) is
not caught at load time. The user notices on `/goal:status` (which
shows the cursor and last 3 history events) or by reading `notes.md`.
Recovery is: edit `state.json` back to a sensible cursor, or run
`/goal:clear --archive` and start fresh.

## 8. Budget evasion

**What it is.** Long single turns (50k+ tokens) can blow the project's
quota with `--max-iter 200` set conservatively. The agent never trips
the iteration count, but the token cost is catastrophic.

**Why it happens.** Iterations and tokens are decoupled — a single
iteration can consume any amount of tokens.

**Defense.** `tallyTokens` re-reads the full session JSONL on every Stop
turn (`engine/budget.mjs:29-51`) and sums input + output +
cache_creation across all assistant rows. `checkLimits`
(`engine/budget.mjs:53-71`) compares the running total to
`budget.tokens.max`. When `used >= max`, the Stop hook fires the
budget-limited graceful-exit path at `engine/stop-hook.mjs:123-157` —
sets `lifecycle = "budget-limited"`, renders `prompts/budget-limit.md`,
and **does not parse tags from the exhaustion turn**. The agent cannot
escape budget exhaustion by claiming achievement on the final turn.

For the full token-counting semantics see [BUDGET.md §2](./BUDGET.md#2-tallytokens--what-counts-as-a-token).

**Recovery if it slips through.** The token tally is a rough cost proxy
(the documented R7 risk; see [BUDGET.md §2](./BUDGET.md#tally-vs-billing--the-documented-gap)).
If real billing exceeds the tally meaningfully, the user tightens
`--token-budget` empirically on the next run. Wall-clock and iteration
budgets remain a hard backstop.

## 9. Session hijacking

**What it is.** A second Claude Code session opens the same project
while a goal is in flight. The second session's Stop hook fires, sees
the active goal, and tries to drive it — colliding with the original
session's mutations.

**Why it happens.** Hooks are project-scoped. Multiple `claude` sessions
in the same project all run the same hooks.

**Defense.** `state.session_id` is pinned at `/goal:start` time
(`engine/start-goal.mjs:60`). Every Stop-hook turn compares the stored
session id to the hook's stdin payload session id at
`engine/stop-hook.mjs:114`:

```js
if (state.session_id !== stdin.session_id) return { exit: 0, stdout: null };
```

The mismatching session silently exits with no stdout. Only the
originating session drives the goal.

**Recovery if it slips through.** It cannot — the session-id check is
strict. If the user wants to drive the goal from a new session, they
either manually edit `state.session_id` to the new session's id, or
run `/goal:start --force` (`engine/start-goal-cli.mjs:38`,
`engine/start-goal.mjs:40-45`) to re-pin the session.

## 10. Mid-run plan re-approval

**What it is.** While the goal is `pursuing`, the user accidentally
runs `/goal:approve-plan` again. Naively this would reset
`tree.approved_at` and clobber `state.lifecycle` back to `approved`,
losing the cursor and history.

**Why it happens.** Muscle memory; tab-completion mishaps; or the user
noticing a typo in the plan and trying to "re-approve" with the fix.

**Defense.** The C-1 lifecycle gate at
`engine/approve-plan-cli.mjs:82-92` refuses any non-`draft`/`approved`
state:

```js
if (existingState && existingState.lifecycle !== 'draft' && existingState.lifecycle !== 'approved') {
  return {
    ok: false,
    errors: [`refusing to approve: state.lifecycle=${existingState.lifecycle}; ...`],
    ...
  };
}
```

Approve from `pursuing`, `paused`, `achieved`, `unmet`, or
`budget-limited` is rejected with an explicit error pointing the user
at `/goal:clear --archive` if they really want to start over.

**Recovery if it slips through.** It cannot — the gate is closed before
any state mutation occurs. If the user wants to fix a typo in the plan
mid-run, they edit the file directly (with the caveats from
[PLAN-FORMAT.md §5](./PLAN-FORMAT.md#5-round-trip-rules) — only
runtime fields are guaranteed safe to edit at runtime; identity fields
should not change).

## 11. See also

- [PLAN-FORMAT.md](./PLAN-FORMAT.md) — schema contracts these defenses
  enforce.
- [REVIEW-AGENTS.md](./REVIEW-AGENTS.md) — review-gate as
  defense-in-depth against proxy-signal collapse.
- [BUDGET.md](./BUDGET.md) — full token-tally and budget-exhaustion
  semantics.
- [SMOKE-TEST.md](./SMOKE-TEST.md) — manual recipe whose §10
  exercises pause/resume/abandon paths and the budget-exhausted resume
  refusal.
