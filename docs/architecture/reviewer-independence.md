# Reviewer independence enforcement

## The rule

> An `<audit-verdict agent="X" status="...">` tag is **accepted** only if at
> least one `Agent(subagent_type="X")` tool_use block exists in the transcript
> between the most recent `cursor-advanced` event for the current cursor and
> the current turn's assistant message. Otherwise the verdict is **rejected**
> and a history entry is recorded with `event: review-verdict`, `payload.rejected: true`.
> Rejected verdicts do not advance the cursor.

## Why

The original protocol trusted the agent to dispatch independent reviewer
subagents (via the `Agent` tool) and then transcribe their verdicts as
`<audit-verdict>` tags. This was a cooperative honesty model: a stuck or
cost-conscious agent could fabricate a `status="GO"` verdict without actually
running the reviewer. The cursor advances, the task ships, no human ever
saw the work.

Enforcement closes that loophole. The engine now grounds every verdict in
verifiable transcript evidence — a real Agent tool_use block — instead of
trusting the verdict tag alone.

## How

`engine/transcript.mjs` exposes `scanAgentInvocations(transcriptPath, sinceTs)`
which streams the JSONL transcript and returns a `Set<string>` of distinct
`subagent_type` values invoked since `sinceTs`.

`engine/apply-mutations.mjs` calls this scanner once per Stop hook fire and,
for every `<audit-verdict agent="X">` tag, asserts that `X` appears in the
returned set. If not, the verdict is rejected — same history-event kind
(`review-verdict`) but with `payload.rejected = true` and
`payload.reason = "no Agent dispatch detected"`. The cursor does not advance
on a rejected verdict.

## Failure modes prevented

1. **Fabricated GO** — agent writes `<audit-verdict status="GO">` without
   dispatching the reviewer. Rejected; cursor stays; the agent gets a
   continuation-blocked prompt and must actually dispatch.

2. **Wrong-reviewer GO** — agent dispatches `Agent(subagent_type="general-purpose")`
   to get a verdict for a task requiring `subagent_type="art-director"`. The
   `Agent` call exists but the type doesn't match. Verdict rejected.

3. **Stale dispatch** — agent reuses an old Agent invocation from a previous
   task. The `sinceTs` cutoff excludes invocations from before the current
   task's `cursor-advanced` event, so this is rejected.

## What this is NOT

This is **not** a verification of the reviewer's verdict quality. The engine
trusts the assistant to transcribe the reviewer's output faithfully into the
`<audit-verdict>` body. We only verify that the reviewer was actually invoked.
A higher-fidelity check (e.g., comparing the verdict body against the agent
output text) is out of scope for this rule.
