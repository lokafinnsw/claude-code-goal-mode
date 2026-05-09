/**
 * Pure Mustache-subset template renderer for LLM-prompt continuation.
 *
 * Supported directives:
 *   - {{var}}                  — interpolate a variable.
 *   - {{#each list}}…{{/each}} — iterate over an array; inside the body, item
 *                                fields are merged into the context, and the
 *                                whole item is also reachable as `{{this}}`.
 *   - {{#if cond}}…{{/if}}     — render body when `cond` is truthy.
 *
 * Variable name pattern: [\w.]+ — letters, digits, underscores, and dots.
 * Snake_case (`first_name`) and dotted-path access (`a.b.c`) are supported.
 *
 * Nested {{#each}} and {{#if}} are supported by a single-pass linear walk:
 * scan forward for the next opener of either kind, count same-kind
 * opener/closer depth to locate the matching closer, then render the body
 * recursively against the per-block context. Block output is concatenated
 * as opaque text and never re-scanned for directives, so user-supplied ctx
 * values containing literal `{{...}}` round-trip intact.
 *
 * Truthiness for {{#if}}:
 *   - Empty arrays are falsy.
 *   - Everything else uses JS `!!` (so `0`, `false`, `''`, `null`, `undefined`
 *     are falsy; non-empty arrays / objects / strings are truthy).
 *
 * Falsy-but-defined values for {{var}}:
 *   - `0`     → '0'
 *   - `false` → 'false'
 *   - `''`    → ''
 *   - Only `null` and `undefined` are suppressed to ''.
 *
 * Explicit non-features:
 *   - No HTML escaping. Output is LLM-prompt text, not HTML; rendering raw
 *     `<tag>` is intentional.
 *   - No whitespace tolerance inside braces. `{{ name }}` (with whitespace)
 *     is detected by the validator as a malformed directive and THROWS —
 *     templates must use the no-whitespace style consistently.
 *
 * Template validation (template-time):
 *   Validation runs ONCE on the template before any substitution. It checks:
 *     - Every `{{...}}` marker matches one of `{{var}}`, `{{#each path}}`,
 *       `{{/each}}`, `{{#if path}}`, or `{{/if}}`.
 *     - `{{#each}}…{{/each}}` and `{{#if}}…{{/if}}` are balanced and not
 *       mis-paired (a `{{/if}}` cannot close a `{{#each}}` and vice versa).
 *   User-supplied ctx values that contain literal `{{...}}` text pass through
 *   to the output verbatim — there is no post-render guard. This is the
 *   correct boundary: the template is a closed set (the six `prompts/*.md`
 *   files), so checking it once at the start catches authoring bugs; user
 *   data is open and must round-trip intact.
 *
 *   Errors are `TemplateRenderError` instances with `.token` and `.position`
 *   fields where available, so callers (e.g. the Phase 4 Stop-hook) can
 *   distinguish template-level failures from other runtime errors via
 *   `instanceof TemplateRenderError`.
 *
 * Pure: no I/O, no globals, no Math.random.
 *
 * Also exports:
 *   - buildContext(tree, state, cursorId, now?) — assembles the snake_case
 *     ctx object that prompts/*.md templates expect, by walking the tree's
 *     ancestor chain to the cursor task, mapping acceptance_criteria with
 *     covered/uncovered markers, and exposing budget fields. Returns null
 *     if cursorId does not match any node. The `now` parameter (default
 *     Date.now()) is injectable for testability — the rest of the function
 *     is pure given fixed `now`. wallclock_minutes is clamped to 0 on
 *     clock skew (started_at in the future).
 */

import { findNodeById } from './traversal.mjs';
import { wallclockMinutes } from './wallclock.mjs';

export class TemplateRenderError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'TemplateRenderError';
    if (details) {
      Object.assign(this, details);
    }
  }
}

// Regexes for the validator. We first scan with a permissive marker pattern
// so we can detect malformed shapes (e.g. `{{ name }}`, `{{}}`, `{{a-b}}`),
// then narrow each token to one of the supported forms.
const MARKER_RE = /\{\{[^}]*\}\}/g;
const VAR_RE = /^\{\{[\w.]+\}\}$/;
const EACH_OPEN_RE = /^\{\{#each\s+[\w.]+\}\}$/;
const IF_OPEN_RE = /^\{\{#if\s+[\w.]+\}\}$/;

// Walks the template once, O(n). Throws TemplateRenderError on any malformed
// marker, kind-mismatched closer, orphan closer, or unclosed opener.
export function validateTemplate(template) {
  const stack = [];
  let m;
  // Defensive reset (a stray exec on this module-scoped regex elsewhere
  // could leave lastIndex non-zero).
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(template)) !== null) {
    const tok = m[0];
    const pos = m.index;
    if (tok === '{{/each}}') {
      const top = stack.pop();
      if (!top || top.kind !== 'each') {
        throw new TemplateRenderError(
          `unmatched ${tok} at position ${pos}`,
          { token: tok, position: pos },
        );
      }
    } else if (tok === '{{/if}}') {
      const top = stack.pop();
      if (!top || top.kind !== 'if') {
        throw new TemplateRenderError(
          `unmatched ${tok} at position ${pos}`,
          { token: tok, position: pos },
        );
      }
    } else if (EACH_OPEN_RE.test(tok)) {
      stack.push({ kind: 'each', token: tok, pos });
    } else if (IF_OPEN_RE.test(tok)) {
      stack.push({ kind: 'if', token: tok, pos });
    } else if (VAR_RE.test(tok)) {
      // valid {{var}} reference — nothing to do
    } else {
      throw new TemplateRenderError(
        `malformed directive: ${tok} at position ${pos}`,
        { token: tok, position: pos },
      );
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    throw new TemplateRenderError(
      `unclosed ${top.token} at position ${top.pos}`,
      { token: top.token, position: top.pos },
    );
  }
}

// Given an opener of `kind` whose head ends at `headEnd`, walk forward
// counting same-kind opener/closer depth and return the index of `{{` of
// the matching closer, or -1 if not found.
function findMatchingCloser(s, kind, headEnd) {
  const tokenRe = new RegExp(`\\{\\{#${kind}\\s+[\\w.]+\\}\\}|\\{\\{\\/${kind}\\}\\}`, 'g');
  tokenRe.lastIndex = headEnd;
  let depth = 1;
  let m;
  while ((m = tokenRe.exec(s)) !== null) {
    if (m[0].startsWith('{{#')) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) return m.index;
    }
  }
  return -1;
}

// Find the next opener of EITHER kind in `s` starting at `from`. Returns
// { kind, start, headEnd, key } or null. We need a unified search so that
// blocks are processed in source order; processing all `each` first then
// all `if` would re-interpret `{{#if}}` text that arrived via user data
// inside an already-rendered each-body.
function findNextOpener(s, from) {
  // The validator has already vetted the whole template, so any `{{#each ...}}`
  // or `{{#if ...}}` we encounter here is well-formed.
  const re = /\{\{#(each|if)\s+([\w.]+)\}\}/g;
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) return null;
  return { kind: m[1], start: m.index, headEnd: re.lastIndex, key: m[2] };
}

// Substitute `{{var}}` occurrences in a slice of literal template text
// against `ctx`. Used only on outer-level template slices BEFORE any user
// data has been merged in, so this never sees user-supplied `{{...}}` text.
function expandVars(template, ctx) {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    const v = getPath(ctx, key);
    return v === undefined || v === null ? '' : String(v);
  });
}

// Render template-level content (between blocks) by substituting vars in a
// single linear pass. Each block (each/if) is recursively rendered with its
// per-block context and its OUTPUT is concatenated as opaque text — never
// re-scanned for directives. This is what lets user-supplied ctx values
// containing literal `{{x}}` round-trip intact.
function renderInner(template, ctx) {
  let out = '';
  let cursor = 0;
  while (cursor < template.length) {
    const opener = findNextOpener(template, cursor);
    if (!opener) {
      out += expandVars(template.slice(cursor), ctx);
      break;
    }
    // Outer-level text before the block: substitute its vars.
    out += expandVars(template.slice(cursor, opener.start), ctx);
    const closerStart = findMatchingCloser(template, opener.kind, opener.headEnd);
    // Validator ensures a matching closer exists; the -1 branch is
    // unreachable for validated templates.
    const closerEnd = closerStart + `{{/${opener.kind}}}`.length;
    const body = template.slice(opener.headEnd, closerStart);
    if (opener.kind === 'each') {
      const list = getPath(ctx, opener.key);
      if (Array.isArray(list)) {
        for (const item of list) {
          const itemCtx = {
            ...ctx,
            this: item,
            ...(typeof item === 'object' && item !== null ? item : {}),
          };
          out += renderInner(body, itemCtx);
        }
      }
      // Non-array list: emit nothing, mirroring prior behavior.
    } else {
      // kind === 'if'
      const v = getPath(ctx, opener.key);
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      if (truthy) {
        out += renderInner(body, ctx);
      }
    }
    cursor = closerEnd;
  }
  return out;
}

export function render(template, ctx) {
  // Validate the template syntactically BEFORE any substitution. This is the
  // only correctness gate: user-supplied ctx values that contain literal
  // `{{...}}` text are NOT inspected after substitution and pass through to
  // the output verbatim. Substitution then happens in a single linear walk
  // that recurses into blocks; output of each block is concatenated as opaque
  // text and never re-scanned for directives.
  validateTemplate(template);
  return renderInner(template, ctx);
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * Build the rendering context object for a continuation prompt.
 *
 * Inputs:
 *   - tree:     the goal-tree (Phase-1 schema-shaped).
 *   - state:    the run-state (Phase-1 schema-shaped). Must contain
 *               state.budget.iterations.{used,max}, .tokens.{used,max},
 *               .wallclock.{started_at, max_seconds}.
 *   - cursorId: the id of the task node to render the prompt against.
 *
 * Returns: a flat ctx object keyed by the snake_case variables used in
 *          prompts/continuation.md (and siblings). Returns null if the
 *          cursor id does not match any node in the tree (caller must
 *          handle this).
 *
 * Derived fields:
 *   - sprint_title / epic_title come from the cursor's ancestor chain.
 *   - criteria[] is the task.acceptance_criteria mapped with a
 *     covered_marker ('x' if any evidence record covers that criterion
 *     index, ' ' otherwise).
 *   - has_review / has_validate are boolean shortcuts the templates
 *     use to render conditional blocks.
 *   - wallclock_minutes is derived as (Date.now() - wallclock.started_at)
 *     in whole minutes — IMPURE due to Date.now() in this one place; the
 *     rest of the function is pure.
 */
export function buildContext(tree, state, cursorId, now = Date.now()) {
  const task = findNodeById(tree, cursorId);
  if (!task) return null;
  const ancestors = pathToNode(tree.root, cursorId);
  const sprint = ancestors.find(n => n.type === 'sprint');
  const epic = ancestors.find(n => n.type === 'epic');
  const coveredCriteria = new Set(task.evidence.map(e => e.criterion_index).filter(i => i != null));
  const criteria = task.acceptance_criteria.map((text, index) => ({
    index, text, covered_marker: coveredCriteria.has(index) ? 'x' : ' ',
  }));
  return {
    iteration: state.budget.iterations.used,
    iterations_max: state.budget.iterations.max,
    sprint_title: sprint?.title ?? '',
    epic_title: epic?.title ?? '',
    task_title: task.title,
    task_id: task.id,
    work_front: task.work_front ?? '',
    task_goal: task.goal,
    criteria,
    evidence: task.evidence,
    has_review: task.review.length > 0,
    review_agents_csv: task.review.join(','),
    has_validate: !!task.validate,
    validate: task.validate ?? '',
    blocker_reason: task.blocker_reason ?? '',
    review_attempts: task.review_attempts,
    tokens_used: state.budget.tokens.used,
    tokens_max: state.budget.tokens.max,
    wallclock_minutes: wallclockMinutes(state, now),
    wallclock_max_minutes: Math.floor(state.budget.wallclock.max_seconds / 60),
  };
}

function pathToNode(root, id) {
  const path = [];
  function visit(node) {
    path.push(node);
    if (node.id === id) return true;
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    path.pop();
    return false;
  }
  visit(root);
  return path;
}
