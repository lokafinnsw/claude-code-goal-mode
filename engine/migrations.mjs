/**
 * Schema migrations — automatic, version-aware state/tree loading.
 *
 * Why this exists: the engine's zod schemas pin a specific schema_version
 * literal, so ANY change to the on-disk shape (new history event, new node
 * field, renamed property) must come with a migration that lifts old states
 * forward. Otherwise users hit the "engine встал" bug class — load fails on
 * zod throw, readWithBackup creates a .broken-* backup, returns null, and the
 * Stop hook short-circuits silently.
 *
 * Contract:
 *   - CURRENT_SCHEMA_VERSION: int, the version every freshly-saved file uses.
 *   - migrations/v<N>-to-v<N+1>.mjs: each declares { fromVersion, toVersion,
 *     migrateState, migrateTree }. The two migrate functions take the raw
 *     parsed JSON object (NOT a zod-validated record — pre-validation, by
 *     definition) and return the raw object at the next version.
 *   - runMigrations(state, tree, fromVersion) returns { state, tree, applied }
 *     where applied is the ordered list of migration ids that ran. It catches
 *     migration exceptions and reverts to the original input atomically; a
 *     failed migration NEVER persists a partial result.
 *
 * Wiring point: engine/state.mjs readWithBackup applies runMigrations between
 * JSON.parse and schema.parse, and writes back the migrated object atomically
 * with a .pre-migration-v<oldVersion>-<ts> backup of the original.
 */

import { z } from 'zod';
import * as v1ToV2 from './migrations/v1-to-v2.mjs';

// Public API --------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 2;

export const MigrationSchema = z.object({
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  migrateState: z.function(),
  migrateTree: z.function(),
});

// Registry — ordered chain of single-step migrations. Add new entries here
// when bumping CURRENT_SCHEMA_VERSION.
const MIGRATIONS = [v1ToV2];

// Defensive: validate every registered migration matches the schema at module
// load time so a malformed migration entry can't silently break runtime.
for (const m of MIGRATIONS) MigrationSchema.parse(m);

/**
 * Return the ordered chain of migrations that lifts fromVersion → toVersion.
 * Throws if there's no path (e.g., gap or downgrade requested).
 */
export function listMigrations(fromVersion, toVersion = CURRENT_SCHEMA_VERSION) {
  if (fromVersion === toVersion) return [];
  if (fromVersion > toVersion) {
    throw new Error(
      `cannot downgrade: fromVersion=${fromVersion} > toVersion=${toVersion}`,
    );
  }
  const chain = [];
  let current = fromVersion;
  while (current < toVersion) {
    const next = MIGRATIONS.find((m) => m.fromVersion === current);
    if (!next) {
      throw new Error(
        `no migration registered from v${current} (target v${toVersion})`,
      );
    }
    chain.push(next);
    current = next.toVersion;
  }
  return chain;
}

/**
 * Apply the migration chain to (state, tree). Either may be null when the
 * caller is migrating only one of the two.
 *
 * Atomic semantics: if any migration step throws, the function returns the
 * ORIGINAL (unmigrated) state and tree along with applied=[] and error set.
 * This means callers can safely `Object.assign(input, runMigrations(input))`
 * without worrying about partial mutation.
 */
export function runMigrations(state, tree, fromVersion, toVersion = CURRENT_SCHEMA_VERSION) {
  if (fromVersion === toVersion) {
    return { state, tree, applied: [], error: null };
  }
  const chain = listMigrations(fromVersion, toVersion);
  let curState = state;
  let curTree = tree;
  const applied = [];
  for (const m of chain) {
    try {
      const id = `v${m.fromVersion}-to-v${m.toVersion}`;
      curState = curState ? m.migrateState(curState) : null;
      curTree = curTree ? m.migrateTree(curTree) : null;
      // Invariant: schema_version on the migrated objects must equal
      // m.toVersion. Catch a buggy migration that forgot to bump it.
      if (curState && curState.schema_version !== m.toVersion) {
        throw new Error(
          `migration ${id} migrateState did not bump schema_version (got ${curState.schema_version}, expected ${m.toVersion})`,
        );
      }
      if (curTree && curTree.schema_version !== m.toVersion) {
        throw new Error(
          `migration ${id} migrateTree did not bump schema_version (got ${curTree.schema_version}, expected ${m.toVersion})`,
        );
      }
      applied.push(id);
    } catch (err) {
      // Atomic rollback: return the inputs untouched.
      return { state, tree, applied: [], error: err.message };
    }
  }
  return { state: curState, tree: curTree, applied, error: null };
}
