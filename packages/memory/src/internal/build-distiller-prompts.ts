import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type { MemoryRecord } from '../schemas/memory-record.schema.js';
import type { MemoryBucketStatus, MemoryProposeInput } from '../schemas/memory-tools.schema.js';
import { isRecordActiveForRepo } from './resolve-record-cap-bucket.js';
import { sortMemoryRecordsCanonically } from './sort-memory-records-canonically.js';

/**
 * Parameter object for `buildDistillerPrompts`.
 */
export interface BuildDistillerPromptsParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** In-memory snapshot of active `memory.jsonl` records. */
  readonly records: readonly MemoryRecord[];
  /** Candidate proposal input (`callerRole`, `targetRole`, `type`, `rawText`, `context`, `repos`, `incident`). */
  readonly candidate: MemoryProposeInput;
  /** Normalized candidate context array (when `candidate.context` was provided). */
  readonly normalizedContext?: readonly string[];
  /** Evaluated capacity bucket status for the candidate. */
  readonly bucketStatus: MemoryBucketStatus;
  /** Result shape reference for single-root reachability (`Rule 1.2`). */
  readonly resultShape?: BuiltDistillerPrompts;
}

/**
 * Prompt pair returned by `buildDistillerPrompts` (§6.4 Step 3).
 */
export interface BuiltDistillerPrompts {
  /** Static KV-cacheable system prompt containing instructions, repository rules, and existing `R*`/`L*` records. */
  readonly systemPrompt: string;
  /** Dynamic user prompt containing the candidate payload, `bucketStatus`, and choice-scope constraints. */
  readonly userPrompt: string;
}

/**
 * Compares two strings in ascending POSIX code-unit order.
 *
 * @param {string} left  - First string.
 * @param {string} right - Second string.
 *
 * @returns {number} `-1` if `left < right`, `1` if `left > right`, or `0` if equal.
 */
function compareCodeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Reads `CLAUDE.MD` (falling back to `CLAUDE.md` when `CLAUDE.MD` is absent on disk) and all
 * `docs/rules/*.md` files sorted in ascending POSIX path code-unit order (§6.4 Step 3).
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root directory.
 *
 * @returns {string} Formatted markdown section containing discovered repository rule files.
 */
function loadRepositoryRuleFilesSection(workspaceRoot: string): string {
  const sections: string[] = [];
  if (existsSync(workspaceRoot)) {
    try {
      const rootEntries = readdirSync(workspaceRoot);
      const claudeFileName = rootEntries.includes('CLAUDE.MD')
        ? 'CLAUDE.MD'
        : rootEntries.includes('CLAUDE.md')
          ? 'CLAUDE.md'
          : null;
      if (claudeFileName !== null) {
        const fullClaudePath = path.join(workspaceRoot, claudeFileName);
        if (statSync(fullClaudePath).isFile()) {
          const content = readFileSync(fullClaudePath, 'utf8').trim();
          sections.push(`### File: ${claudeFileName}\n${content}`);
        }
      }
    } catch {
      sections.push('### File: (none)');
    }
  }
  const rulesDir = path.join(workspaceRoot, 'docs', 'rules');
  if (existsSync(rulesDir)) {
    try {
      const ruleEntries = readdirSync(rulesDir).filter((name) => name.endsWith('.md'));
      const relPaths = ruleEntries.map((name) => `docs/rules/${name}`);
      relPaths.sort(compareCodeUnitOrder);
      for (const relPath of relPaths) {
        const fullRulePath = path.join(workspaceRoot, relPath);
        if (statSync(fullRulePath).isFile()) {
          const content = readFileSync(fullRulePath, 'utf8').trim();
          sections.push(`### File: ${relPath}\n${content}`);
        }
      }
    } catch {
      return sections.join('\n\n');
    }
  }
  return sections.length > 0 ? sections.join('\n\n') : '(no repository rule files found)';
}

/**
 * Builds the static KV-cacheable `systemPrompt` for `memory_propose` (§6.4 Step 3).
 *
 * @param {string}                  workspaceRoot - Absolute path to the workspace root directory.
 * @param {MemoryConfig}            config        - Validated unified memory configuration.
 * @param {readonly MemoryRecord[]} records       - Active ledger records snapshot.
 *
 * @returns {string} Deterministic static system prompt.
 */
function buildStaticDistillerSystemPrompt(
  workspaceRoot: string,
  config: MemoryConfig,
  records: readonly MemoryRecord[],
): string {
  const activeRulesAndLessons: MemoryRecord[] = [];
  for (const record of records) {
    if (
      (record.type === 'rule' || record.type === 'lesson') &&
      isRecordActiveForRepo(record, config.repoId)
    ) {
      activeRulesAndLessons.push(record);
    }
  }
  const sortedRecords = sortMemoryRecordsCanonically(activeRulesAndLessons);
  const serializedRecords =
    sortedRecords.length > 0
      ? sortedRecords.map((rec) => JSON.stringify(rec)).join('\n')
      : '(no active rules or lessons in ledger)';
  const ruleFilesSection = loadRepositoryRuleFilesSection(workspaceRoot);
  const customInstructionsBlock =
    config.distiller.customInstructions !== undefined
      ? `\n## Custom Distiller Instructions\n${config.distiller.customInstructions}\n`
      : '';
  const parts = [
    '# Unified Memory Distiller System Prompt',
    '',
    'You are the Unified Memory Distiller for `' +
      config.repoId +
      '`. Analyze the candidate rule or lesson against the 3-tier gate, lesson formatting rules, repository rule files, and existing active ledger records, and output a JSON object matching `DistillerStructuredOutputSchema`.',
    '',
    '## Three-Tier Gate & Rule Authority',
    '- For `type: "lesson"`:',
    '  1. Tier 1: Reject (`matchStatus: "REJECTED_TIER_1_OR_2"`) if the check can be enforced mechanically by a test, type, linter, or script.',
    '  2. Tier 2: Reject (`matchStatus: "REJECTED_TIER_1_OR_2"`) if the check belongs as a direct fix to a vague or missing line in the repository rule files below.',
    '  3. Tier 3: Format as a single-sentence atomic lesson matching `config.format` below.',
    '- For `type: "rule"`: Rules originate from Owner mandates (`rule: <text>`). Never return `REJECTED_TIER_1_OR_2` for `type: "rule"`, and never reference `L*` records when `type === "rule"` or `R*` records when `type === "lesson"`.',
    '',
    '## Lesson Format Constraints (`config.format`)',
    `- Template: \`${config.distiller ? config.format.template : ''}\``,
    `- Max Characters: ${config.format.maxChars}`,
    `- Require Single Sentence: ${String(config.format.requireSingleSentence)}`,
    `- Required Substrings: ${JSON.stringify(config.format.requireSubstrings)}`,
    `- Forbidden Regexes: ${JSON.stringify(config.format.forbidRegexes)}`,
    `- Allowed Roles: ${JSON.stringify(config.allowedRoles)}`,
    customInstructionsBlock,
    '## Repository Rule Files (`CLAUDE.MD` / `CLAUDE.md` & `docs/rules/*.md`)',
    ruleFilesSection,
    '',
    '## Active Rules (`R*`) & Lessons (`L*`) in Canonical Order',
    serializedRecords,
  ];
  return parts.join('\n');
}

/**
 * Builds the dynamic `userPrompt` suffix for `memory_propose` (§6.4 Step 3).
 *
 * @param {BuildDistillerPromptsParams} params - Candidate input, normalized context, and `bucketStatus`.
 *
 * @returns {string} Dynamic user prompt describing the candidate and target capacity bucket.
 */
function buildDynamicDistillerUserPrompt(params: BuildDistillerPromptsParams): string {
  const effectiveContext = params.normalizedContext ?? params.candidate.context;
  const candidatePayload = {
    callerRole: params.candidate.callerRole,
    targetRole: params.candidate.targetRole,
    type: params.candidate.type,
    rawText: params.candidate.rawText,
    normalizedContext: effectiveContext ?? null,
    repos: params.candidate.repos ?? null,
    incident: params.candidate.incident ?? null,
  };
  const lines = [
    '# Candidate Memory Proposal Request',
    '',
    '## Candidate Payload',
    JSON.stringify(candidatePayload, null, 2),
    '',
    '## Target Capacity Bucket Status (`bucketStatus`)',
    JSON.stringify(params.bucketStatus, null, 2),
    '',
    '## Choice-Scope & Capacity Consolidation Rules',
    `- \`op: "add"\` MUST preserve the candidate's \`proposedRole: "${params.candidate.targetRole}"\`, \`proposedContext: ${JSON.stringify(effectiveContext ?? undefined)}\`, and \`proposedRepos: ${JSON.stringify(params.candidate.repos ?? undefined)}\`.`,
    `- \`op: "update"\` MUST target an existing active record of the same type (\`${params.candidate.type === 'rule' ? 'R*' : 'L*'}\`) and may widen scope via \`proposedContext: null\` (unscoped) or \`proposedRepos: null\` (all repositories).`,
    `- Target bucket zone is \`${params.bucketStatus.zone}\` (bucketRecordIds: ${JSON.stringify(params.bucketStatus.bucketRecordIds)}).`,
    '- In `SOFT_CAP_PRESSURE` or `AT_HARD_CAP`, attach `capMerge: { keepId, removeId, mergedText, whyMerged }` to an `op: "add"` choice **if and only if** two existing records in `bucketStatus.bucketRecordIds` with the same `type` and `role` (`keepRecord.type === removeRecord.type && keepRecord.role === removeRecord.role`) genuinely share the exact same underlying failure mechanism. If no pair shares a mechanism, omit `capMerge` (`undefined`). In `UNCAPPED` or `UNDER_SOFT_CAP`, `capMerge` is forbidden.',
  ];
  return lines.join('\n');
}

/**
 * Constructs the byte-identical KV-cacheable `systemPrompt` and dynamic `userPrompt` for
 * `memory_propose` (§6.4 Step 3).
 *
 * @param {BuildDistillerPromptsParams} params - Workspace root, config, ledger records, candidate input, and `bucketStatus`.
 *
 * @returns {BuiltDistillerPrompts} Frozen `{ systemPrompt, userPrompt }` pair.
 */
export function buildDistillerPrompts(params: BuildDistillerPromptsParams): BuiltDistillerPrompts {
  const systemPrompt = buildStaticDistillerSystemPrompt(
    params.workspaceRoot,
    params.config,
    params.records,
  );
  const userPrompt = buildDynamicDistillerUserPrompt(params);
  return Object.freeze<BuiltDistillerPrompts>({
    systemPrompt,
    userPrompt,
  });
}
