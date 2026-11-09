import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import {
  LINE_SPLIT_REGEX,
  MEMORY_GITIGNORE_ENTRIES,
} from './memory-protocol.constants.js';

/**
 * Ensures `<checkoutDir>/.gitignore` exists and contains `.session-state/`, `*.lock`, and `*.tmp*` (§8.1 Rule 3).
 *
 * @param {string} checkoutDir - Absolute path to the `.memory` Git checkout directory.
 *
 * @returns {Promise<void>} Resolves once `<checkoutDir>/.gitignore` contains all required entries.
 */
export async function ensureMemoryGitignore(checkoutDir: string): Promise<void> {
  const gitignorePath = path.join(checkoutDir, '.gitignore');
  let existingText = '';
  if (existsSync(gitignorePath)) {
    existingText = await readFile(gitignorePath, 'utf8');
  }
  const existingLines = new Set<string>();
  for (const rawLine of existingText.split(LINE_SPLIT_REGEX)) {
    const trimmed = rawLine.trim();
    if (trimmed.length > 0) {
      existingLines.add(trimmed);
    }
  }
  const missingEntries: string[] = [];
  for (const requiredEntry of MEMORY_GITIGNORE_ENTRIES) {
    if (!existingLines.has(requiredEntry)) {
      missingEntries.push(requiredEntry);
    }
  }
  if (missingEntries.length === 0 && existsSync(gitignorePath)) {
    return;
  }
  const combinedLines = [...existingLines, ...missingEntries];
  const nextContent = `${combinedLines.join('\n')}\n`;
  await writeFileAtomic(gitignorePath, nextContent, { encoding: 'utf8' });
}
