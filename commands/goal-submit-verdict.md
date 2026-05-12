---
description: "Record a reviewer verdict (GO|NOGO|REVISE) after dispatching a subagent (v3 explicit CLI)"
argument-hint: "--agent <subagent_type> --status <GO|NOGO|REVISE> --text \"...\""
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/submit-verdict.sh:*)"]
---

# Goal Submit Verdict

Records a verdict for a reviewer that you dispatched via the Agent tool. The CLI enforces reviewer-independence: it scans the current session transcript for a real `Agent(subagent_type=<name>)` invocation BEFORE accepting the verdict.

Workflow:
1. Run `/goal-mode:goal-achieve` to enter review-pending.
2. For each required reviewer, dispatch via Agent tool with the audit-instructions prompt.
3. For each verdict received, call this command:

```
/goal-mode:goal-submit-verdict --agent aaa-art-director --status GO --text "all criteria covered"
```

Parse user arguments from the message and dispatch:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/submit-verdict.sh" <parsed-args>
```

Print the script output. Exit code semantics:
- 0: verdict accepted (cursor advanced if all-GO).
- 1: independence violation (no Agent dispatch found in transcript) OR precondition failure.
- 2: bad argument.
