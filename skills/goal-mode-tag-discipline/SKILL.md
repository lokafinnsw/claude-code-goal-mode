---
name: goal-mode-tag-discipline
description: Use when you need exact regex/format details for goal-mode tag emission (parse-tags.mjs semantics, code-fence stripping, attribute quoting, escape-hatch regex, edge cases). Use BEFORE emitting a complex/long verdict or evidence block to verify the tag is parseable.
---

# Goal-mode tag emission — exact semantics

This skill is the precise reference for the parser in `engine/parse-tags.mjs`. Use it when you need to know:

- Which exact regex matches a tag
- How code regions are stripped (`engine/stop-hook.mjs::stripCodeRegions`)
- What attribute quoting rules apply
- What the parser silently drops
- How escape-hatch is detected

For high-level behavior + when-to-emit guidance, use the `using-goal-mode` skill instead.

## Pre-parse: code-region stripping

Before parsing tags, `engine/stop-hook.mjs` strips:

```js
text.replace(/```[\s\S]*?```/g, '')   // fenced blocks (multiline)
    .replace(/`[^`\n]+`/g, '');       // inline spans (single line)
```

Implication:
- Tags inside ``` fenced blocks ARE removed before parsing.
- Tags inside `inline backticks` ARE removed before parsing.
- Tags inside `<details>...</details>` are NOT stripped — these are HTML, not Markdown code.

**Rule for emission:** put your machine-parsed tags in prose or inside `<details>` blocks. Never inside code fences.

## Tag inventory + exact regexes

### `<evidence>`

```
Self-closed:  <evidence file="..." line="N" criterion="i" note="..." command="..." exit_code="N"/>
Paired:       <evidence ...>note-body</evidence>
```

Regex: `<evidence\b(${ATTRS_REGION})(?:\/>|>([\s\S]*?)<\/evidence>)` (global)

Where `ATTRS_REGION = (?:"[^"]*"|'[^']*'|[^>"'])*?` — matches attribute name=value pairs in any order with double OR single quoting.

**Validation:**
- `criterion="N"` — integer required. Missing or non-integer → tag silently dropped.
- `line`, `exit_code` — optional integers. `intOrNull(v)` returns null on missing/non-int.
- `file`, `command`, `note` — optional strings, default null/empty.
- Body wins over `note` attribute: `note = body.trim() || attrs.note || ''`.

**Out-of-range criterion:** if `criterion >= acceptance_criteria.length`, the tag is recorded in cursor's evidence list but doesn't count toward coverage. The criterion at index N must exist in the task.

### `<task-status>`

```
<task-status>pursuing|achieved|blocked</task-status>
```

Regex: `<task-status>([\s\S]*?)<\/task-status>` (global)

**Validation:**
- Value is **case-insensitive (v2.0.3+)**: trimmed + lowercased → must be `pursuing`, `achieved`, or `blocked`.
- Pre-v2.0.3: case-sensitive (silently dropped `ACHIEVED`).
- Unknown values: silently dropped.

**Multi-tag:** if multiple `<task-status>` tags are emitted in one turn, `applyMutations` uses `tags.find(t => t.kind === 'task-status')` — first one wins.

### `<blocker>`

```
<blocker>reason text</blocker>
```

Regex: `<blocker>([\s\S]*?)<\/blocker>` (global)

**Validation:**
- Empty / whitespace-only reason → tag silently dropped.
- Only consumed when paired with `<task-status>blocked</task-status>`.

### `<review-request>`

```
<review-request agents="reviewer-1,reviewer-2"/>
```

Regex: `<review-request\b(${ATTRS_REGION})\/>` (self-closed only)

**Validation:**
- `agents` attribute required; comma-separated list, each trimmed; empty strings filtered out.
- Empty agents list → tag silently dropped.
- **Paired form NOT supported** — must be self-closed.
- Triggers `pursuing → review-pending` transition ONLY when all criteria covered AND task is currently `pursuing`.

### `<audit-verdict>`

```
<audit-verdict agent="reviewer-x" status="GO|NOGO|REVISE">
  <verdict body text>
</audit-verdict>
```

Regex: `<audit-verdict\b(${ATTRS_REGION})>([\s\S]*?)<\/audit-verdict>` (global)

**Validation:**
- `agent` attribute required (non-empty string).
- `status` attribute required; **case-normalized to UPPERCASE** before enum check; must be `GO`, `NOGO`, or `REVISE`.
- Missing/unknown agent or status → silently dropped.

**Reviewer-independence check (v2.0.0+):** the engine reads the same turn's transcript and collects `Agent(subagent_type=X)` invocations. If `agent` in the verdict doesn't match any actually-dispatched subagent_type, the verdict is rejected (`payload.rejected: true`, `payload.reason: 'no Agent dispatch detected — reviewer-independence violation'`) and does NOT advance the cursor.

## Escape-hatch detection (v2.0.1 + v2.0.4)

Specific to `<audit-verdict>` when the reviewer's subagent_type is unavailable:

```
Pattern: status="REVISE" AND text matches /^\s*unavailable\b/i
```

Code: `engine/apply-mutations.mjs`:
```js
const ESCAPE_HATCH_RE = /^\s*unavailable\b/i;
const isEscapeHatch = (v) => v.status === 'REVISE' && ESCAPE_HATCH_RE.test(v.text || '');
```

**Examples that match:**
- `<audit-verdict status="REVISE">unavailable; user must run /goal-approve</audit-verdict>` ✓
- `<audit-verdict status="REVISE">UNAVAILABLE in environment</audit-verdict>` ✓
- `<audit-verdict status="REVISE">  unavailable, please approve</audit-verdict>` ✓ (leading whitespace OK)

**Examples that DON'T match:**
- `<audit-verdict status="NOGO">unavailable evidence</audit-verdict>` ✗ (wrong status)
- `<audit-verdict status="REVISE">timing data is unavailable</audit-verdict>` ✗ (substring, not prefix)
- `<audit-verdict status="REVISE">Couldn't dispatch the agent</audit-verdict>` ✗ (doesn't start with "unavailable")

**What escape-hatch does:**
- Cursor → `blocked` immediately
- State.lifecycle → `awaiting-manual-approval` (v2.0.4)
- `cursor.blocker_reason` filled with the unavailable agent names + recovery hint
- Stop hook renders `continuation-blocked.md` ONCE, then suppresses

## Attribute parsing nuances

### Quoting

```
file="path/with spaces.ts"    ✓  (double quotes)
file='path/with spaces.ts'    ✓  (single quotes)
file=path-no-quotes           ✗  (silently parses as empty)
note="contains a > char"      ✓  (attr-region matcher is quote-aware)
note="contains "quoted" text" ✗  (embedded `"` breaks parsing; use single quotes around the value)
note="contains 'quoted' text" ✓  (mix)
```

### Duplicate attributes

```
<evidence file="a" file="b" criterion="0"/>
```
Last-wins semantics: `file="b"`.

### Numeric attributes

`criterion`, `line`, `exit_code` — parsed via `intOrNull(v)`:
- `""` (empty) → null
- Non-numeric → null
- Negative integers ACCEPTED at parse time (range-checking is the consumer's job; out-of-range `criterion` is silently filtered from coverage)

### HTML escapes

NOT decoded. `&lt;tag&gt;` passes through as-is. If your verdict body contains `<` or `>`, just write them — the attr-region matcher and body regex are quote-aware.

### Nested tags

The parser is flat. Don't nest `<evidence>` inside `<evidence>` or `<audit-verdict>` inside `<audit-verdict>`. The outer parse will consume up to the first matching close tag, leaving the inner tag orphaned.

## Tag visit order (within one turn's parse output)

`parseTags()` emits tags in this order:

1. All `<evidence>` (in source order)
2. All `<task-status>` (in source order)
3. All `<blocker>` (in source order)
4. All `<review-request>` (in source order)
5. All `<audit-verdict>` (in source order)

`applyMutations` then processes them in this order with kind-specific rules:

1. **Evidence loop** — all `<evidence>` tags push onto cursor's evidence array.
2. **Task-status** (first only via `find()`) — `achieved` checks coverage, transitions to `review-pending` or `achieved`. `blocked` increments `review_attempts`. `pursuing` resets to pursuing.
3. **Review-request** — if cursor is pursuing AND all criteria covered, transitions to `review-pending`.
4. **Audit-verdicts** — only consumed when cursor is `review-pending`. Filter by reviewer-independence (v2.0.0+) and escape-hatch (v2.0.1+).
5. **Terminal lifecycle checks** — `achieved` / `unmet` / `budget-limited` transitions.

## What happens to malformed tags

| Defect | Result |
|---|---|
| `<task-status>frobnicate</task-status>` | Silently dropped (not in `STATUS_VALUES`) |
| `<evidence note="no criterion"/>` | Silently dropped (criterion required) |
| `<evidence criterion="abc"/>` | Silently dropped (non-integer) |
| `<evidence criterion="0" file="x">body</evidence>` with empty body and no note attr | Recorded with `note=""` |
| `<audit-verdict agent="x">no status</audit-verdict>` | Silently dropped (status required) |
| `<audit-verdict status="GO">no agent</audit-verdict>` | Silently dropped (agent required) |
| `<review-request/>` (no agents) | Silently dropped |
| `<blocker></blocker>` (empty) | Silently dropped |

Silent drops are intentional — the parser is fail-permissive so a single malformed tag doesn't break a multi-tag turn. The cost: no error message tells you what was dropped. **Always preview your emission by re-reading the prose you generated, looking specifically at each tag.**

## Common emission mistakes

### Mistake: tags inside fenced code

```markdown
Here's my evidence:
\`\`\`
<evidence file="a" criterion="0"/>
<task-status>achieved</task-status>
\`\`\`
```

→ `stripCodeRegions` removes the entire fenced block before parsing. Tags lost. Engine fires same prompt next turn.

### Mistake: paired review-request

```html
<review-request agents="x">narrative text</review-request>
```

→ Parser only accepts self-closed form. Tag dropped.

### Mistake: status string case

Pre-v2.0.3:
```html
<task-status>Achieved</task-status>
```
→ Silently dropped.

v2.0.3+: normalized to `achieved`, accepted.

### Mistake: fabricated audit-verdict

```html
<audit-verdict agent="my-reviewer" status="GO">trust me, the code is correct</audit-verdict>
```

Without an `Agent({subagent_type: "my-reviewer", ...})` call in the same turn's transcript:
- v1.x: would have been accepted (bug).
- v2.0.0+: rejected with `payload.rejected: true`. Cursor doesn't advance. Engine surfaces "rejected verdicts" in the next Stop-hook prompt.

### Mistake: wrong escape-hatch wording

```html
<audit-verdict agent="x" status="REVISE">cannot dispatch this reviewer</audit-verdict>
```

→ Text doesn't start with "unavailable". Treated as a regular REVISE → fabricated (no Agent dispatch) → rejected. Does NOT trigger the v2.0.4 escape-hatch path.

Correct:
```html
<audit-verdict agent="x" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>
```

## When to use this skill

Invoke `goal-mode-tag-discipline` skill:

- Before emitting a complex verdict (especially when relaying long subagent output through `<audit-verdict>` body).
- When you've emitted tags but the engine fired the same prompt again — your tags may have been silently dropped; check the rules here.
- When constructing the escape-hatch verdict.
- When designing prompt templates for reviewer subagents — to know what format their output should take so it can be relayed cleanly.

Companion skill `using-goal-mode` covers the high-level behavior (when to do what, lifecycle states, recovery paths).
