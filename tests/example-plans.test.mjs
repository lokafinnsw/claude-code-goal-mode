import { describe, it, expect } from 'vitest';
import { validatePlan } from '../engine/validate-plan.mjs';
import fs from 'node:fs';
import path from 'node:path';

const examplesDir = path.join(import.meta.dirname, '..', 'docs', 'EXAMPLES');

const examples = [
  'migration-pydantic-v1-v2',
  'feature-auth-jwt',
  'refactor-axios-to-fetch',
];

describe('Phase 10 — example plans round-trip through validatePlan', () => {
  for (const slug of examples) {
    it(`${slug}.tree.json passes GoalTreeSchema + validatePlan with no errors`, () => {
      const treePath = path.join(examplesDir, `${slug}.tree.json`);
      const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
      const result = validatePlan(tree);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      // Warnings are OK — reviewer-availability check is not run here (no opts).
    });

    it(`${slug}.plan.md exists alongside the tree.json`, () => {
      const planPath = path.join(examplesDir, `${slug}.plan.md`);
      expect(fs.existsSync(planPath)).toBe(true);
    });

    it(`${slug}.tree.json has goal_id matching the filename slug`, () => {
      const treePath = path.join(examplesDir, `${slug}.tree.json`);
      const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
      expect(tree.goal_id).toBe(slug);
    });

    it(`${slug}.tree.json has every task carrying at least 1 acceptance_criteria`, () => {
      const treePath = path.join(examplesDir, `${slug}.tree.json`);
      const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
      function walkTasks(node) {
        if (node.type === 'task') {
          expect(node.acceptance_criteria.length).toBeGreaterThan(0);
        }
        for (const child of node.children) walkTasks(child);
      }
      walkTasks(tree.root);
    });
  }
});
