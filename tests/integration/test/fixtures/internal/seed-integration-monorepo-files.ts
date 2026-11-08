import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SEED_MONOREPO_FILES,
  SEED_RELATIVE_DIRS,
} from './integration-workspace-seed.constants.js';

/**
 * Creates the monorepo directory hierarchy and writes all initial source, specification, rule, skill, and prompt files into `repoDir`.
 *
 * Iterates `SEED_RELATIVE_DIRS` and `SEED_MONOREPO_FILES` in single-pass loops without dynamic object enumeration.
 *
 * @param {string} repoDir - Target working Git repository directory path.
 *
 * @returns {Promise<void>} Resolves once all directories and seed files are written.
 */
export async function seedIntegrationMonorepoFiles(repoDir: string): Promise<void> {
  for (const relDir of SEED_RELATIVE_DIRS) {
    await mkdir(path.join(repoDir, relDir), { recursive: true });
  }
  for (const [relPath, content] of SEED_MONOREPO_FILES) {
    await writeFile(path.join(repoDir, relPath), content, 'utf8');
  }
}
