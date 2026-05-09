const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}

function intOrNull(v) {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

const STATUS_VALUES = new Set(['pursuing', 'achieved', 'blocked']);
const VERDICT_VALUES = new Set(['GO', 'NOGO', 'REVISE']);

export function parseTags(text) {
  const out = [];

  // <evidence>
  const evRe = /<evidence\b([^>]*?)(?:\/>|>([\s\S]*?)<\/evidence>)/g;
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
  for (const m of text.matchAll(/<task-status>([\s\S]*?)<\/task-status>/g)) {
    const v = m[1].trim();
    if (STATUS_VALUES.has(v)) out.push({ kind: 'task-status', value: v });
  }

  // <blocker>reason</blocker>
  for (const m of text.matchAll(/<blocker>([\s\S]*?)<\/blocker>/g)) {
    out.push({ kind: 'blocker', reason: m[1].trim() });
  }

  // <review-request agents="a,b" />
  for (const m of text.matchAll(/<review-request\b([^>]*?)\/>/g)) {
    const attrs = parseAttrs(m[1]);
    const agents = (attrs.agents ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (agents.length > 0) out.push({ kind: 'review-request', agents });
  }

  // <audit-verdict agent="x" status="GO">text</audit-verdict>
  for (const m of text.matchAll(/<audit-verdict\b([^>]*?)>([\s\S]*?)<\/audit-verdict>/g)) {
    const attrs = parseAttrs(m[1]);
    const status = attrs.status;
    if (!VERDICT_VALUES.has(status)) continue;
    if (!attrs.agent) continue;
    out.push({ kind: 'audit-verdict', agent: attrs.agent, status, text: m[2].trim() });
  }

  return out;
}
