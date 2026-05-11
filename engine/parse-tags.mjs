/**
 * Pure tag parser for agent-emitted continuation output.
 *
 * Given an agent's text output, returns a typed array of tag objects in the
 * order the parser visits them. No I/O, no side effects, no global state —
 * suitable for unit testing without fixtures.
 *
 * Supported tags:
 *   - <evidence file="..." line="N" criterion="i" note="..." command="..."
 *               exit_code="N" />                                  (self-closed)
 *   - <evidence ...>note-body</evidence>                          (paired)
 *   - <task-status>pursuing|achieved|blocked</task-status>
 *       Only these three values are accepted; unknown values are skipped.
 *   - <blocker>reason</blocker>
 *       Reason is trimmed; empty/whitespace-only blockers are skipped.
 *   - <review-request agents="a,b" />                             (self-closed)
 *       Comma-separated agent list. Paired form is NOT supported.
 *   - <audit-verdict agent="x" status="GO|NOGO|REVISE">verdict text</audit-verdict>
 *       `agent` attr required; `status` restricted to the three values above.
 *
 * Skip semantics — silent skip on validation failure, never throws:
 *   - Missing or non-integer `criterion` on <evidence>.
 *   - Empty (`criterion=""`) attribute treated as missing.
 *   - Unknown <task-status> value.
 *   - Empty / whitespace-only <blocker> body.
 *   - Empty `agents=""` on <review-request>.
 *   - Missing or unknown `status`, or missing `agent`, on <audit-verdict>.
 *
 * Body-vs-attr precedence on <evidence>: body wins if non-empty, otherwise
 * `note` attr, otherwise empty string. (`note = body || attrs.note || ''`).
 *
 * Order semantics: matching tags are emitted in the order the parser visits
 * them — that is, all <evidence> first, then all <task-status>, then
 * <blocker>, then <review-request>, then <audit-verdict>. Within a kind,
 * source order is preserved. Consumers decide on merge/conflict (e.g. with
 * multiple <task-status> tags, the consumer's `tags.find(...)` picks the
 * first by parser-visit order).
 *
 * Attribute parsing:
 *   - Both double-quoted (a="x") and single-quoted (a='x') values are accepted.
 *   - Attribute values may contain `>` — the attr-region matcher is
 *     quote-aware so `<evidence note="size > 5" criterion="0" />` parses
 *     as a single tag.
 *   - Attribute values may NOT contain a literal embedded `"` (no escape
 *     support); use single quotes around values containing double quotes.
 *   - Duplicate attribute names use last-wins semantics.
 *
 * Negative integers in `criterion`, `line`, `exit_code` are accepted as
 * numeric values; range-checking against `acceptance_criteria.length` is
 * the consumer's responsibility (see `apply-mutations.mjs`).
 *
 * Explicit non-features:
 *   - No Markdown awareness. Tags inside fenced code blocks (```xml ... ```)
 *     ARE parsed. Callers should pre-scope the input region (e.g., strip
 *     fences) if they want to ignore example/illustrative tags. The Phase-4
 *     Stop-hook owns this scoping decision.
 *   - No paired <review-request agents="..."></review-request> — must use
 *     self-closed form (per `prompts/continuation-review.md` convention).
 *   - No HTML escape decoding (&lt; etc.) — values are interpreted as-is.
 *   - No nested-tag awareness — agents must not emit <evidence> containing
 *     another <evidence>, etc.
 *
 * Pure: no I/O, no globals.
 */

// Match name="value" or name='value'.
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Attribute region: any number of either quoted runs ("..." or '...') or
// non-> non-quote characters. Matches everything between an opening `<tag`
// and its closing `>` or `/>`, even when an attribute value contains `>`.
const ATTRS_REGION = `(?:"[^"]*"|'[^']*'|[^>"'])*?`;

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1]] = m[2] ?? m[3] ?? '';
  return out;
}

function intOrNull(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

const STATUS_VALUES = new Set(['pursuing', 'achieved', 'blocked']);
const VERDICT_VALUES = new Set(['GO', 'NOGO', 'REVISE']);

export function parseTags(text) {
  const out = [];

  // <evidence>
  const evRe = new RegExp(`<evidence\\b(${ATTRS_REGION})(?:\\/>|>([\\s\\S]*?)<\\/evidence>)`, 'g');
  for (const m of text.matchAll(evRe)) {
    const attrs = parseAttrs(m[1]);
    const body = (m[2] || '').trim();
    const criterion = intOrNull(attrs.criterion);
    if (criterion === null) continue;
    out.push({
      kind: 'evidence',
      file: attrs.file ?? null,
      line: intOrNull(attrs.line),
      criterion,
      note: body || attrs.note || '',
      command: attrs.command ?? null,
      exit_code: intOrNull(attrs.exit_code),
    });
  }

  // <task-status>value</task-status>
  // Case-normalised to lowercase: LLMs sometimes emit "ACHIEVED" or
  // "Achieved" instead of "achieved", and a strict-case match would silently
  // drop those into "no task-status tag" which stalls the engine. Bug M7 fix.
  for (const m of text.matchAll(/<task-status>([\s\S]*?)<\/task-status>/g)) {
    const v = m[1].trim().toLowerCase();
    if (STATUS_VALUES.has(v)) out.push({ kind: 'task-status', value: v });
  }

  // <blocker>reason</blocker>
  for (const m of text.matchAll(/<blocker>([\s\S]*?)<\/blocker>/g)) {
    const reason = m[1].trim();
    if (reason) out.push({ kind: 'blocker', reason });
  }

  // <review-request agents="a,b" />
  const reviewReqRe = new RegExp(`<review-request\\b(${ATTRS_REGION})\\/>`, 'g');
  for (const m of text.matchAll(reviewReqRe)) {
    const attrs = parseAttrs(m[1]);
    const agents = (attrs.agents ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (agents.length > 0) out.push({ kind: 'review-request', agents });
  }

  // <audit-verdict agent="x" status="GO">text</audit-verdict>
  // Status is case-normalised to uppercase: real LLMs emit lowercase ("go") as
  // often as uppercase ("GO"), and a strict-case match silently drops lowercase
  // verdicts, hanging the review loop until the 3-NOGO escalation kicks in and
  // forces lifecycle to "unmet" without a real reason.
  const auditVerdictRe = new RegExp(`<audit-verdict\\b(${ATTRS_REGION})>([\\s\\S]*?)<\\/audit-verdict>`, 'g');
  for (const m of text.matchAll(auditVerdictRe)) {
    const attrs = parseAttrs(m[1]);
    const status = (attrs.status ?? '').toUpperCase();
    if (!VERDICT_VALUES.has(status)) continue;
    if (!attrs.agent) continue;
    out.push({ kind: 'audit-verdict', agent: attrs.agent, status, text: m[2].trim() });
  }

  return out;
}
