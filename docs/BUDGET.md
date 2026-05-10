# Budget — the triple-budget loop

This is the 1.0.0 reference for goal-mode's three-axis budget. The user
sets the caps at `/goal-start`; the engine re-checks all three on every
Stop-hook turn; whichever axis hits its cap first triggers a graceful exit.

For the schema field shapes see [PLAN-FORMAT.md](./PLAN-FORMAT.md). For
how reviewers interact with the budget loop see
[REVIEW-AGENTS.md](./REVIEW-AGENTS.md). For how the engine defends against
budget evasion see [ANTI-PATTERNS.md](./ANTI-PATTERNS.md).

---

## 1. Why three independent budgets?

Each axis bounds a different runaway mode. Any single one is insufficient:

- **Iterations** are the cheapest signal but blind to per-turn size. A
  single 50k-token turn can blow a project's daily quota with
  `--max-iter 200` set conservatively. Iteration limits stop "how many
  back-and-forths" but not "how expensive each was".
- **Tokens** are the truest cost proxy but require parsing the session
  JSONL on every Stop turn (`engine/budget.mjs:29-51`). Reading the
  transcript catches the runaway-cost mode that iterations cannot see.
- **Wall-clock** catches stuck loops where the agent spins without burning
  much: waits, prompts the user, idle review-pending. A two-day silent
  loop is still a runaway. Wall-clock is the deadline-style cap.

Hitting **any** of the three triggers `lifecycle = "budget-limited"` and a
graceful exit (see §7). The schema shape is at
`engine/state.mjs:104-117` (`TripleBudgetSchema`).

```ts
{
  iterations: { used: int, max: int },
  tokens:     { used: int, max: int },
  wallclock:  { started_at: ISO-8601, max_seconds: int }
}
```

## 2. `tallyTokens` — what counts as a token

The token tally is recomputed on every Stop turn from the session JSONL —
the engine does not maintain its own running total. Implementation at
`engine/budget.mjs:29-51`.

The tally sums three usage fields across **assistant** rows in the
transcript (`engine/budget.mjs:44-47`):

```text
total += input_tokens + output_tokens + cache_creation_input_tokens
```

`cache_read_input_tokens` is **excluded by design**
(`engine/budget.mjs:8-10`). The reasoning:

- Cache-read input tokens are billed at a fraction of the input rate
  (Anthropic prices cache reads cheaper than fresh input).
- Counting them at full weight would over-count cost on long sessions
  with high cache hit rates and force users to set artificially large
  `--token-budget` values to compensate.
- Excluding them means the tally tracks the "expensive prefix" cost
  proxy, not the literal billing total.

### Tally vs billing — the documented gap

The token tally is a **rough cost proxy**, not a precise billing dollar
figure. Two known sources of drift:

- Long sessions with high cache hit rates may consume more real billing
  dollars than the tally reports (because cache reads are still billed,
  just at a lower rate, and the tally ignores them).
- Anthropic billing rates can change independently of the tally formula.

This is the design spec's R7 risk (§13 of the spec). The mitigation is
documented behaviour: users who need a hard cost cap should rely on
**iterations + wall-clock** rather than tokens alone, and tune
`--token-budget` empirically based on observed billing on their first few
runs. Tightening cache-read cost-precision is deferred to post-1.0.0.

### Defensive reads

`tallyTokens` is defensive against a missing or unreadable transcript
(`engine/budget.mjs:30-38`):

- ENOENT (transcript file not found) → returns 0.
- EACCES, EISDIR, rotation race → returns 0.
- Malformed JSON lines → silently skipped (`engine/budget.mjs:48`).
- Never throws.

The "returns 0" behaviour matches `engine/transcript.mjs::readLastAssistantText`.
Returning 0 keeps the loop running rather than crashing the Stop hook
on transient transcript issues.

## 3. `checkLimits` — priority and "no limit" semantics

`checkLimits(budget, now?)` returns the name of the first exhausted axis
or `null` if all three are within budget. Priority order is
**iterations → tokens → wallclock** (`engine/budget.mjs:53-71`):

```js
if (budget.iterations.max > 0 && budget.iterations.used >= budget.iterations.max) return 'iterations';
if (budget.tokens.max > 0 && budget.tokens.used >= budget.tokens.max)             return 'tokens';
if (budget.wallclock.max_seconds > 0) { /* wallclock check */ }
return null;
```

The first axis to satisfy `used >= max` wins. The Stop hook calls
`checkLimits` at `engine/stop-hook.mjs:123` after incrementing
`iterations.used` and re-tallying tokens.

### `max=0` means "no limit"

Each axis treats `max=0` as "no limit on that axis"
(`engine/budget.mjs:54,57,60`). This is how a user configures
"only iterations matter" or "only wall-clock matters":

```text
/goal-start --max-iter 100 --token-budget 0 --time-budget 0
```

The above gives a hard 100-iteration cap with no token or wall-clock
limit. See §6 for valid combinations.

## 4. Default values

The CLI defaults are at `engine/start-goal-cli.mjs:26`:

```js
let maxIter = 100, tokenBudget = 2_000_000, timeBudgetSeconds = 14400;
```

In human terms:

| Axis | Default | Source |
|---|---|---|
| `--max-iter` | 100 | `engine/start-goal-cli.mjs:26` |
| `--token-budget` | 2,000,000 | `engine/start-goal-cli.mjs:26` |
| `--time-budget` | 14,400 seconds (4 hours) | `engine/start-goal-cli.mjs:26` |

These match the design spec §9.1 ("Defaults if omitted: max-iter=100,
token-budget=2_000_000, time-budget=4h").

The `--time-budget` flag accepts either bare seconds, `Nm` (minutes), or
`Nh` (hours): `engine/start-goal-cli.mjs:31-37` parses the suffix.

## 5. Recommended ranges per goal size

These are heuristics. Every project differs. Tune empirically after the
first run.

### Small — single-feature, ≤5 tasks

```text
/goal-start --max-iter 30 --token-budget 500000 --time-budget 1h
```

For a tightly-scoped change: one or two files, no review-gate, validation
by a single shell command. 30 iterations is enough for ~5 tasks at ~5
turns each.

### Medium — sprint-shaped, ~15 tasks

```text
/goal-start --max-iter 100 --token-budget 2000000 --time-budget 4h
```

These are the defaults. Suits a coherent sprint: ~15 tasks, a handful of
review-gates, validate commands per task. Most goals fit here.

### Large — multi-sprint, ~50+ tasks

```text
/goal-start --max-iter 300 --token-budget 8000000 --time-budget 12h
```

For a multi-sprint plan that you intend to leave running overnight or
across a full work-session. Note that wall-clock here is the **session**
wall-clock — pause/resume does not extend the cap.

### Plan-bootstrap suggestion

`/goal-plan` itself prints a suggested budget at the end of the bootstrap
turn (`prompts/plan-bootstrap.md:62-64`):

> Suggested budget for `/goal-start`: based on task count, estimate
> (max-iter ≈ tasks × 4, token-budget ≈ tasks × 50000, time-budget ≈
> tasks × 30 minutes; round up).

This is a starting heuristic; the user is expected to adjust based on the
specific work fronts, the number of review-gates, and the historical cost
of similar goals on the same project.

## 6. Hard floors and `max=0`

Setting any axis's max to `0` disables that axis. The CLI accepts this:
`engine/start-goal-cli.mjs:18` validates only that the value is a
non-negative integer (`n >= 0`).

| Setting | Effect |
|---|---|
| `--max-iter 0` | No iteration limit. |
| `--token-budget 0` | No token limit. |
| `--time-budget 0` | No wall-clock limit. |

Use cases for `max=0`:

- Free-form exploratory goals where you want only your own wall-clock
  (closing the laptop) to bound the session — set all three caps to
  unboundedly large numbers, or zero out the two you do not care about.
- Long single-task goals where you trust the validate-command to stop
  the loop and want only iterations as a backstop.

The design spec §9.1 advises against setting all three to zero
simultaneously ("All three can be set to `0` to disable that single check
— not all three at once"). The current CLI does not enforce this — if all
three are zero, `checkLimits` will return `null` forever and the loop
runs until you pause, abandon, or clear it. Treat the all-zero
configuration as "I will manage the loop manually."

## 7. Graceful exit on budget exhaustion

When `checkLimits` returns a non-null axis name, the Stop hook executes
the budget-exhaustion path at `engine/stop-hook.mjs:123-157`:

1. Sets `state.lifecycle = "budget-limited"`
   (`engine/stop-hook.mjs:126`).
2. Sets `state.ended_at` and `state.ended_reason = "<axis> budget
   exhausted"` (`engine/stop-hook.mjs:127-128`).
3. Appends a `budget-exhausted` history event with payload
   `{ kind: "iterations" | "tokens" | "wallclock" }`
   (`engine/stop-hook.mjs:129-135`). The `kind` value is exactly the
   string `checkLimits` returned.
4. Saves state atomically (`engine/stop-hook.mjs:136`).
5. Renders `prompts/budget-limit.md` with the budget context
   (`engine/stop-hook.mjs:138-148`).
6. Returns `{ decision: "block", reason: <rendered>, systemMessage: "🟡
   <axis> budget exhausted" }` (`engine/stop-hook.mjs:149-156`).

The agent gets one final turn to summarize. The `budget-limit.md`
template explicitly forbids the agent from declaring fake achievement
(`prompts/budget-limit.md:14-16`):

> Do not emit `<task-status>achieved</task-status>` for any task that is
> not actually finished. The engine will mark this run `budget-limited`
> regardless of what you claim.

Crucially, the budget-exhaustion path **does not parse tags from this
turn**. The Stop hook returns immediately after rendering
`budget-limit.md` (`engine/stop-hook.mjs:149-156`) — no
`applyMutations`, no evidence accumulation, no cursor advance. This is
the I-4 evidence-gate working in concert with the budget gate: the agent
cannot escape budget exhaustion by claiming achievement on the final turn.

On the next Stop turn, `state.lifecycle` is no longer `pursuing`, so the
hook returns immediately at `engine/stop-hook.mjs:115` and the loop
ends.

### Resuming after a budget hit

The user has two choices:

- **`/goal-resume`** — refuses if any budget axis is still exhausted.
  Bumping the budget requires either editing `state.json` directly or
  using `/goal-start --force` to restart the budget counter (which
  preserves cursor and tree but resets `started_at`, `iterations.used`,
  and rebases the wall-clock).
- **`/goal-clear --archive`** — snapshots the goal to
  `.claude/goals/archive/` and starts fresh.

## 8. Defensive against corrupt state

The wall-clock check is defensive against hand-edited or corrupt
`started_at` (`engine/budget.mjs:60-68`):

```js
const wallStart = new Date(budget.wallclock.started_at).getTime();
if (Number.isNaN(wallStart)) return null;
```

If `started_at` is unparseable as a date (`NaN`), the wall-clock axis is
treated as "no limit" — the engine refuses to crash on hand-edited state.

This is intentional, but it is documented behaviour: future readers
should not assume the wall-clock check always fires. The companion helper
`wallclockMinutes` (`engine/wallclock.mjs:17-21`) clamps to 0 minutes
elapsed under the same condition, so `/goal-status` and the continuation
prompts also tolerate corrupt timestamps.

Schema-level corruption of `state.json` (entire fields missing,
type-mismatched) is caught earlier at `loadState` time
(`engine/state.mjs:155-167`): the broken state is preserved as
`state.json.broken-<ts>-<seq>` for forensic recovery and `loadState`
returns `null`, which makes the Stop hook silently exit at
`engine/stop-hook.mjs:113`. The loop ends; the user notices on the next
`/goal-status`.

## 9. See also

- [PLAN-FORMAT.md](./PLAN-FORMAT.md) — the schema fields the budget
  reads from.
- [REVIEW-AGENTS.md](./REVIEW-AGENTS.md) — review-pending iterations
  count against the iteration budget.
- [ANTI-PATTERNS.md](./ANTI-PATTERNS.md) — budget evasion as a failure
  mode and how the engine defends against it.
- [SMOKE-TEST.md](./SMOKE-TEST.md) — manual recipe that exercises a
  small budget end-to-end (`--max-iter 5 --token-budget 100000
  --time-budget 5m`).
