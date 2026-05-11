# ADR 0004 — Plan-as-code TypeScript DSL

- **Status:** Proposed
- **Date:** 2026-05-10
- **Tags:** v2.0.0, feature, new-package, typescript, opt-in
- **Supersedes:** None
- **Depends on:** ADR 0001 (event log) — DSL output is consumed via `goal-created` event
- **Original label:** D5 (v2 brainstorm 2026-05-10)

## Context

v1.x has two plan-authoring paths:

1. **LLM bootstrap** (`/goal-plan <mission>`): the LLM surveys the project and writes plan.md + tree.json. Best for fresh missions where you don't know the shape yet.
2. **Markdown import** (`/goal-plan-from-file <path>`): the LLM converts an existing handwritten Markdown plan into the goal-mode schema. Best for plans you've already sketched in your favorite editor.

Both paths produce JSON. Both rely on the LLM for the conversion. Both work — but **for large or programmatically-derived plans, both have hit limits in practice**:

### Limit 1: Plan size and LLM accuracy

A 400-task plan (real Mancelot MVP scale) stresses the LLM's ability to produce a fully consistent JSON tree in one Write call. We've seen real issues:
- Cross-references between tasks (one task references another by ID) get mis-typed.
- The 7-strikes anti-truncation discipline (`prompts/plan-from-file.md` Hard Rule #2) forces single-write but a 400-task plan is ~80KB of JSON — within Claude's limit but at the edge of attention.
- Manual review of a 400-task tree.json in a code review tool is brutal.

### Limit 2: Programmatic plan construction

Mancelot's plan has patterns: "for each NPC, generate a sprint with the same 8 epics" (schedule, dialogue, quest, animations, etc.). Today: copy-paste the sprint template 11 times, edit IDs by hand. Error-prone, drift-prone, refactor-hostile.

Imagine:

```typescript
const NPCs = ['korz', 'reb', 'zoya', 'manselot', 'sasha', ...];

export default goal({
  id: 'mancelot-mvp-2026-05',
  mission: '...',
  sprints: NPCs.map(npc => sprint(`npc-${npc}`, {
    title: `NPC ${capitalize(npc)} full implementation`,
    epics: standardNpcEpics(npc),
  })),
});
```

This is impossible in Markdown and verbose in raw JSON. A code-based DSL handles it natively.

### Limit 3: Refactor safety

Today, renaming a task ID requires a global search across plan.md, tree.json, and any user-side scripts that reference it. The LLM can do this, but it's prone to false-positive replaces. With a TS DSL, the rename is a single-symbol refactor in any modern IDE.

### Limit 4: Schema drift

If goal-mode v2 adds a new task field (e.g., `priority: 1..10`), every plan.md and tree.json in user projects becomes potentially stale. With a TS DSL, the user updates the `@goal-mode/plan-dsl` dependency, TypeScript flags the new required field at compile time, the user fixes their plan, ships.

### What ADR 0001 (event log) enables

With the event-log architecture, the plan input format is not load-bearing for the engine. The engine consumes a `goal-created` event with a tree skeleton in its payload. **The DSL's job is to emit a valid `goal-created` event.** It's a new authoring layer, not a new engine layer.

## Decision

We ship `@goal-mode/plan-dsl` as a **separate npm package** colocated in the same git repo (`packages/plan-dsl/`). The DSL provides typed builder functions; users author plans in `plan.ts`; a compile step (`npx goal-mode-compile plan.ts`) produces a `goal-created` event written into `.claude/goals/<id>/events.jsonl`. The existing `/goal-plan` and `/goal-plan-from-file` flows remain — DSL is opt-in.

### DSL surface

The core builders:

```typescript
import { goal, sprint, epic, task, criterion, validate, review } from '@goal-mode/plan-dsl';

export default goal({
  id: 'auth-jwt-migration',
  mission: 'Migrate auth from session cookies to JWT',
  budget: {                                       // optional defaults for /goal-start
    iterations: 200,
    tokens: 5_000_000,
    wallclock_minutes: 480,
  },
  sprints: [
    sprint('jwt-issuance', {
      title: 'JWT issuance and verification',
      epics: [
        epic('signing-keys', {
          title: 'Signing keys and jose dependency',
          tasks: [
            task('add-jose-dep', {
              title: 'Add jose npm dep and create signing keys',
              goal: 'jose@^5.0 wired with two RS256 signing keys',
              acceptance: [
                criterion('jose@^5.0 in package.json'),
                criterion('JWT_SIGNING_KEY env var documented in .env.example'),
                criterion('Key rotation policy noted in docs/auth.md'),
              ],
              validate: validate('npm test -- src/auth/keys.test.ts'),
              review: review([]),                  // empty = no review gate
              work_front: 'engine',
            }),
            // ...
          ],
        }),
      ],
    }),
  ],
});
```

### Helpers, conventions, and type checks

The DSL provides:

- **Typed builders.** `task()` requires `acceptance: Criterion[]` non-empty; TypeScript errors at compile time if missing.
- **ID uniqueness check.** The `goal()` builder validates that every ID is unique across the whole tree (compile-time via a `unique` brand, OR runtime in the compile step with a clear error).
- **Cross-reference helpers.** `taskRef('add-jose-dep')` returns a typed reference; if the target task is later renamed, the reference is auto-updated (in IDE refactor mode).
- **Standard libraries.** `tdd(taskId, { test, impl })` builds a paired test-first / impl task. `forEach(items, fn)` builds N parallel sprints/epics/tasks.
- **Reviewer types.** `review` accepts subagent_type strings AND known constants (`r.AAA_ART_DIRECTOR`, `r.RPG_GAME_DESIGNER`, etc.) so typos are caught at compile time.

### Compile step

```bash
npx goal-mode-compile plan.ts
# Reads plan.ts via tsx (no separate compilation step needed)
# Validates via zod (same schema as engine — shared in `packages/schema/`)
# Emits a `goal-created` event into .claude/goals/<goal.id>/events.jsonl
# Bootstraps a .active pointer if no other goal is active
```

The compile step is **idempotent** — re-running it after editing plan.ts emits a `plan-replaced` event (a v2 event kind that updates the in-memory tree without invalidating in-progress evidence on shared task IDs). If the user changes a task ID, the existing evidence does NOT transfer — to migrate evidence to a renamed task, the user would explicitly use `/goal-evidence-migrate <old-id> <new-id>`. This is restrictive on purpose: silent evidence transfer would mask plan changes that should require re-review.

### Schema package

The zod schema currently in `engine/state.mjs` is the boundary contract between authoring and engine. We extract it into `packages/schema/`:

```
packages/
├── schema/                              ← shared zod schemas (used by engine + DSL)
│   ├── package.json                     ← name: "@goal-mode/schema"
│   ├── src/index.ts
│   └── ...
├── plan-dsl/                            ← TS DSL
│   ├── package.json                     ← name: "@goal-mode/plan-dsl"
│   ├── src/
│   │   ├── index.ts                     ← entry: goal, sprint, epic, task, ...
│   │   ├── helpers.ts                   ← tdd, forEach, etc.
│   │   └── reviewer-constants.ts        ← AAA_ART_DIRECTOR, etc.
│   ├── README.md
│   └── ...
└── engine/                              ← existing engine code (moved into packages/)
    ├── package.json                     ← name: "@goal-mode/engine"
    └── src/
```

This is a **monorepo split**. v2.0.0 introduces the packages/ structure. The engine continues to be importable as `engine/*.mjs` for compatibility with Claude Code plugin install. Schema is published to npm so the DSL package can depend on it without a workspace link.

### Distribution

- `@goal-mode/schema`: published to npm. ~5KB. Depends on zod.
- `@goal-mode/plan-dsl`: published to npm. Depends on @goal-mode/schema and tsx (peer). ~30KB.
- `goal-mode-compile` CLI: shipped with plan-dsl.
- The Claude Code plugin install (the `claude-code-goal-mode` repo): unchanged; vendors zod still; doesn't depend on plan-dsl. DSL is purely an authoring-side tool.

## Consequences

### Positive

- **Programmatic plan construction.** N-NPC patterns, derived sprints, conditional epics — all become real code with abstraction.
- **Compile-time correctness.** Task ID typos, missing criteria, dangling references, unknown reviewer names — all caught before the engine sees the plan.
- **IDE-friendly.** Autocomplete, refactor-rename, jump-to-definition, type-check-on-save — all native.
- **Schema versioning isolated.** Schema changes propagate to plan-dsl users via npm dep bump. Users see TypeScript errors pointing at exactly which lines need updating.
- **Plan reviewability.** A 400-task plan in TS is a 1000-line file with clear structure; in JSON it's an 80KB unreadable blob.
- **Cleaner mental model.** "The plan is code" matches "the goal is data". Code authors a plan; data drives the engine. Today's mixed model (plan is half markdown, half JSON) goes away for users who opt in.

### Negative

- **TypeScript dependency for authors.** Users who want the DSL must `npm install -D @goal-mode/plan-dsl tsx`. That's a TS+Node project setup. Most goal-mode users already have this; greenfield Python/Rust/Go users do not.
- **Monorepo split is a structural change.** Moving engine code under `packages/engine/` touches every import. Compat shim required to preserve `import { ... } from '../../engine/state.mjs'`-style absolute paths from outside the package (e.g., in CLAUDE_PLUGIN_ROOT-rooted bash scripts).
- **Two authoring paths to maintain.** LLM-driven (`/goal-plan`) and DSL-driven. Both must emit the same event schema. Documentation has to explain both clearly.
- **Plan-replacement edge cases.** Re-compiling plan.ts when the goal is mid-pursuit: how to handle existing evidence on tasks whose IDs/criteria changed? Decision: existing evidence preserved only for same-ID-same-criterion-count tasks; otherwise refuse without `--force-replan`. This is conservative; can be relaxed later.

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| **YAML with JSON schema** | Compile-time type checking poor; refactor unsafe; no programmatic construction. |
| **Python DSL** | Python is great but adds a runtime to the auth pipeline. Most users of an LLM coding tool live in Node already. TS is the closer mental model. |
| **Custom DSL syntax (like Bazel's Starlark)** | All the friction of building a language; none of the IDE support. TS gives us everything for free. |
| **JSON Schema + JSON literal authoring** | No abstraction (loops, helpers). The "programmatic construction" goal is unattainable. |
| **Reuse Markdown but enrich with structured comments** | Two parsers, two failure modes, no IDE support. Already shipped in `/goal-plan-from-file`; this would just be marginally better. |
| **Skip DSL, double down on LLM bootstrap** | LLM bootstrap remains a great workflow; this ADR adds a second workflow for users who'd rather author in code. The two coexist. |

## Migration

The DSL ships as a **net-new feature**. No existing plan needs to change. Existing v1.x plans (Markdown + tree.json) continue to work indefinitely.

### Phase A — Schema extraction (`v2.0.0-rc1`)

1. Move zod schemas from `engine/state.mjs` to `packages/schema/src/index.ts`. Engine imports them from the new location.
2. Publish `@goal-mode/schema@v2.0.0-rc1` to npm.
3. Ship goal-mode v2.0.0-rc1 (engine still works unchanged).

### Phase B — DSL package (`v2.0.0-rc2`)

1. Build `packages/plan-dsl/` with builders + helpers + reviewer constants + compile CLI.
2. Tests: build a 100-task plan via DSL, compile to event, feed to engine, verify same behavior as equivalent JSON plan.
3. Documentation: `docs/PLAN-AS-CODE.md` walking through DSL authoring.
4. Publish `@goal-mode/plan-dsl@v2.0.0-rc2`.

### Phase C — Mancelot dogfooding (`v2.0.0-rc3`)

1. Author the Mancelot MVP roadmap as `plan.ts`; compare to existing tree.json.
2. Catch issues from real usage; iterate on DSL ergonomics.
3. Update `docs/PLAN-AS-CODE.md` with patterns learned.

### Phase D — `v2.0.0`

1. Ship general availability. DSL is opt-in; LLM paths unchanged.

## Open questions

- **Q1.** Versioning. `@goal-mode/schema` and `@goal-mode/plan-dsl` use independent semver. Engine pins schema as `^X.Y.0`. Patch updates flow freely; minor bumps in schema require engine to relax (additive only) or major-bump together.
- **Q2.** Should the DSL emit raw events.jsonl entries, or call into the engine's reducer for validation? Initial decision: emit events; engine validates on load. Keeps the DSL pure-functional.
- **Q3.** Plan-DSL → Markdown round-trip. Useful for compatibility with `/goal-plan-from-file` reverse path. Defer to post-2.0.0; today the canonical plan-md is rendered from tree.json (one-way).
- **Q4.** Programmatic acceptance criteria (e.g., `criterion.fromFile('checklist.md', 'line 5')`)? Tempting but couples to user filesystem. Defer.
- **Q5.** Reviewer constants — where does the list come from? Initially hardcoded from the `~/.claude/skills/` survey at compile time. Long-term: a separate `@goal-mode/reviewer-registry` package per project.

## References

- TypeScript zod-inferred type pattern (`type X = z.infer<typeof XSchema>`)
- `tsx` runtime for executing plan.ts without a tsc build step
- ADR 0001 (event log) — DSL's `goal-created` event flows through the event reducer
- `engine/state.mjs` — schema source to be extracted into `packages/schema/`
- `prompts/plan-from-file.md` — existing markdown-authoring path; coexists with DSL
- `docs/EXAMPLES/feature-auth-jwt.tree.json` — example shape the DSL produces
