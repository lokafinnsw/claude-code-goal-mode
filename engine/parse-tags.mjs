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

export function parseTags(text) {
  const out = [];
  // <evidence ... /> or <evidence ...>body</evidence>
  const evRe = /<evidence\b([^>]*?)(?:\/>|>([\s\S]*?)<\/evidence>)/g;
  for (const m of text.matchAll(evRe)) {
    const attrs = parseAttrs(m[1]);
    const body = (m[2] || '').trim();
    const criterion = intOrNull(attrs.criterion);
    if (criterion === null) continue; // malformed
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
  return out;
}
