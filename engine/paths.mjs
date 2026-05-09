import path from 'node:path';

export const goalsDir = (root) => path.join(root, '.claude', 'goals');
export const activeDir = (root) => path.join(goalsDir(root), 'active');
export const treePath = (root) => path.join(activeDir(root), 'tree.json');
export const statePath = (root) => path.join(activeDir(root), 'state.json');
export const notesPath = (root) => path.join(activeDir(root), 'notes.md');
export const planPath = (root) => path.join(activeDir(root), 'plan.md');
export const auditsDir = (root) => path.join(activeDir(root), 'audits');
export const archiveDir = (root) => path.join(goalsDir(root), 'archive');
