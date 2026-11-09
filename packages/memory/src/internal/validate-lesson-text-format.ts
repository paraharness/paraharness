import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryLessonFormatConfig } from '../schemas/memory-config.schema.js';
import { compileForbidRegexes } from './load-memory-config.js';
import {
  BECAUSE_SUBSTRING,
  MIN_BECAUSE_CLAUSE_CHARS,
  SENTENCE_SPLIT_PUNCTUATION_REGEX,
} from './memory-protocol.constants.js';

/**
 * Validates length bounds (`0 < trimmed.length <= format.maxChars`) for a lesson text string (§6.7 Step 1).
 *
 * @param {string}                   trimmed - Trimmed candidate lesson text.
 * @param {MemoryLessonFormatConfig} format  - Active lesson formatting rules.
 *
 * @returns {void}
 *
 * @throws {MemoryHarnessError} With `'LESSON_FORMAT_INVALID'` if `trimmed` is empty or exceeds `format.maxChars`.
 */
function assertLessonLengthBound(trimmed: string, format: MemoryLessonFormatConfig): void {
  if (trimmed.length === 0) {
    throw new MemoryHarnessError(
      'LESSON_FORMAT_INVALID',
      'Lesson format check failed (length bound): lesson text must not be empty.',
      { check: 'lengthBound', length: 0, maxChars: format.maxChars },
    );
  }
  if (trimmed.length > format.maxChars) {
    throw new MemoryHarnessError(
      'LESSON_FORMAT_INVALID',
      `Lesson format check failed (length bound): length ${trimmed.length} exceeds maxChars ${format.maxChars} in "${trimmed.slice(0, 40)}...".`,
      { check: 'lengthBound', length: trimmed.length, maxChars: format.maxChars },
    );
  }
}

/**
 * Validates single-sentence constraints when `format.requireSingleSentence === true` (§6.7 Step 2).
 *
 * @param {string}                   trimmed - Trimmed candidate lesson text.
 * @param {MemoryLessonFormatConfig} format  - Active lesson formatting rules.
 *
 * @returns {void}
 *
 * @throws {MemoryHarnessError} With `'LESSON_FORMAT_INVALID'` if `trimmed` spans multiple lines, lacks a trailing period, or contains mid-text sentence splits.
 */
function assertSingleSentenceFormat(trimmed: string, format: MemoryLessonFormatConfig): void {
  if (!format.requireSingleSentence) {
    return;
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    throw new MemoryHarnessError(
      'LESSON_FORMAT_INVALID',
      'Lesson format check failed (singleSentence): lesson must not contain newline characters (\\n or \\r).',
      { check: 'singleSentence', offendingSubstring: '\\n' },
    );
  }
  if (!trimmed.endsWith('.')) {
    throw new MemoryHarnessError(
      'LESSON_FORMAT_INVALID',
      `Lesson format check failed (singleSentence): lesson must end with "." (got "${trimmed.slice(-10)}").`,
      { check: 'singleSentence', offendingSubstring: trimmed.slice(-10) },
    );
  }
  const bodyBeforeFinalChar = trimmed.slice(0, -1);
  const splitMatch = SENTENCE_SPLIT_PUNCTUATION_REGEX.exec(bodyBeforeFinalChar);
  if (splitMatch !== null) {
    throw new MemoryHarnessError(
      'LESSON_FORMAT_INVALID',
      `Lesson format check failed (singleSentence): multiple sentences detected at "${splitMatch[0]}".`,
      { check: 'singleSentence', offendingSubstring: splitMatch[0] },
    );
  }
}

/**
 * Validates required substrings and `' because '` action/mechanism clause lengths (§6.7 Step 3).
 *
 * @param {string}                   trimmed - Trimmed candidate lesson text.
 * @param {MemoryLessonFormatConfig} format  - Active lesson formatting rules.
 *
 * @returns {void}
 *
 * @throws {MemoryHarnessError} With `'LESSON_FORMAT_INVALID'` if a required substring is missing or a `' because '` clause is shorter than 10 characters.
 */
function assertRequiredSubstringsAndClauses(
  trimmed: string,
  format: MemoryLessonFormatConfig,
): void {
  for (const requiredSub of format.requireSubstrings) {
    if (!trimmed.includes(requiredSub)) {
      throw new MemoryHarnessError(
        'LESSON_FORMAT_INVALID',
        `Lesson format check failed (requireSubstrings): missing required substring "${requiredSub}".`,
        { check: 'requireSubstrings', offendingSubstring: requiredSub },
      );
    }
    if (requiredSub === BECAUSE_SUBSTRING) {
      const idx = trimmed.indexOf(BECAUSE_SUBSTRING);
      const actionClause = trimmed.slice(0, idx).trim();
      const rawMechanism = trimmed.endsWith('.')
        ? trimmed.slice(idx + BECAUSE_SUBSTRING.length, -1)
        : trimmed.slice(idx + BECAUSE_SUBSTRING.length);
      const mechanismClause = rawMechanism.trim();
      if (actionClause.length < MIN_BECAUSE_CLAUSE_CHARS) {
        throw new MemoryHarnessError(
          'LESSON_FORMAT_INVALID',
          `Lesson format check failed (becauseActionClause): action clause "${actionClause}" before "${BECAUSE_SUBSTRING}" must be at least ${MIN_BECAUSE_CLAUSE_CHARS} characters.`,
          { check: 'becauseActionClause', offendingSubstring: actionClause },
        );
      }
      if (mechanismClause.length < MIN_BECAUSE_CLAUSE_CHARS) {
        throw new MemoryHarnessError(
          'LESSON_FORMAT_INVALID',
          `Lesson format check failed (becauseMechanismClause): mechanism clause "${mechanismClause}" after "${BECAUSE_SUBSTRING}" must be at least ${MIN_BECAUSE_CLAUSE_CHARS} characters.`,
          { check: 'becauseMechanismClause', offendingSubstring: mechanismClause },
        );
      }
    }
  }
}

/**
 * Validates `trimmed` against the pre-compiled `forbidRegexes` patterns (§6.7 Step 4).
 *
 * @param {string}                   trimmed               - Trimmed candidate lesson text.
 * @param {MemoryLessonFormatConfig} format                - Active lesson formatting rules.
 * @param {readonly RegExp[]}        [compiledForbidRegexes] - Optional pre-compiled `RegExp` array from `loadMemoryConfig`.
 *
 * @returns {void}
 *
 * @throws {MemoryHarnessError} With `'LESSON_FORMAT_INVALID'` if any forbidden pattern matches `trimmed`.
 */
function assertForbiddenRegexes(
  trimmed: string,
  format: MemoryLessonFormatConfig,
  compiledForbidRegexes?: readonly RegExp[],
): void {
  const regexes = compiledForbidRegexes ?? compileForbidRegexes(format.forbidRegexes);
  for (let i = 0; i < regexes.length; i += 1) {
    const regex = regexes[i];
    if (regex === undefined) continue;
    const match = regex.exec(trimmed);
    if (match !== null) {
      const patternSource = format.forbidRegexes[i] ?? regex.source;
      throw new MemoryHarnessError(
        'LESSON_FORMAT_INVALID',
        `Lesson format check failed (forbidRegexes): matched forbidden pattern /${patternSource}/u at "${match[0]}".`,
        {
          check: 'forbidRegexes',
          pattern: patternSource,
          offendingMatch: match[0],
        },
      );
    }
  }
}

/**
 * Enforces all five deterministic lesson text formatting gates (§6.7): length bound, single-sentence
 * structure, required substrings + `' because '` clause lengths, and pre-compiled `forbidRegexes`.
 *
 * @param {string}                   rawText                 - Candidate lesson string to validate.
 * @param {MemoryLessonFormatConfig} format                  - Lesson format configuration (`config.format`).
 * @param {readonly RegExp[]}        [compiledForbidRegexes] - Optional pre-compiled `RegExp` list from `loadMemoryConfig`.
 *
 * @returns {string} Validated trimmed lesson text.
 *
 * @throws {MemoryHarnessError} With `'LESSON_FORMAT_INVALID'` naming the failed check and offending match.
 */
export function validateLessonTextFormat(
  rawText: string,
  format: MemoryLessonFormatConfig,
  compiledForbidRegexes?: readonly RegExp[],
): string {
  const trimmed = rawText.trim();
  assertLessonLengthBound(trimmed, format);
  assertSingleSentenceFormat(trimmed, format);
  assertRequiredSubstringsAndClauses(trimmed, format);
  assertForbiddenRegexes(trimmed, format, compiledForbidRegexes);
  return trimmed;
}
