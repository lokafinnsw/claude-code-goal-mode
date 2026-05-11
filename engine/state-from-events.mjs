/**
 * Compat shim — v1.2.x callers imported `replayEvents` from this module.
 * v2.0.0+ delegates to `engine/reducer.mjs::reduce`, which is the canonical
 * implementation per ADR-0001.
 *
 * The shim preserves the `replayEvents(initialTree, events, initialState?)`
 * signature and the `{ state, tree, applied }` return shape used by:
 *   - `engine/state.mjs::loadStateWithRecovery`
 *   - `tests/event-log.test.mjs` (v1.2.0/1.2.1)
 *   - `tests/v1.2.1-patches.test.mjs`
 *
 * New code should import `reduce` from `engine/reducer.mjs` directly.
 */

import { reduce } from './reducer.mjs';

export function replayEvents(initialTree, events, initialState = null) {
  const r = reduce(initialTree, events, initialState);
  return { state: r.state, tree: r.tree, applied: r.applied };
}

// Re-export so existing imports `import { reduce } from './state-from-events.mjs'`
// (if any) continue to work.
export { reduce } from './reducer.mjs';
