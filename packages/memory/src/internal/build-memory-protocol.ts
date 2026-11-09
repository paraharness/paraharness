import type { MemoryConfig } from '../schemas/memory-config.schema.js';

/**
 * Generates the config-adapted markdown Memory Protocol returned by `memory_init` (§6.2 Step 4).
 *
 * Includes the 3-tier lesson gate, the project's `config.format` rules, the `memory_propose` ->
 * `memory_commit` workflow across `'resolved'` and `'delegate_to_subagent'` execution modes (with
 * mandatory Owner `"go"` confirmation for `'rule'` records), the 4 `note` lifecycle modes and
 * `memory_drain_notes` dry-run workflow, and guidance on calling `memory_load_scoped`.
 *
 * @param {MemoryConfig} config - Validated unified memory configuration for the repository.
 * @param {string}       [role] - Optional active session role name.
 *
 * @returns {string} Non-empty config-adapted markdown protocol instructions.
 */
export function buildMemoryProtocol(config: MemoryConfig, role = 'general'): string {
  const requiredSubs =
    config.format.requireSubstrings.length > 0
      ? config.format.requireSubstrings.map((s) => JSON.stringify(s)).join(', ')
      : 'none';
  const forbiddenPatterns =
    config.format.forbidRegexes.length > 0
      ? config.format.forbidRegexes.map((r) => `/${r}/u`).join(', ')
      : 'none';
  const allowedRolesList = config.allowedRoles.join(', ');
  const lines = [
    `# Unified Memory Protocol (repoId: \`${config.repoId}\`, role: \`${role}\`)`,
    '',
    `Allowed roles: \`${allowedRolesList}\``,
    '',
    '## 1. Three-Tier Filter Before Lesson Creation (`type: "lesson"`)',
    '1. **Tier 1 (Mechanical Enforcement First):** Enforce the invariant mechanically with a unit test, a TypeScript type, an ESLint rule, or a build script whenever possible.',
    '2. **Tier 2 (Role or Specification Update Second):** Fix any vague, missing, or contradictory line in the governing role rule or specification document.',
    '3. **Tier 3 (Empirical Lesson Third):** Record or widen an atomic lesson only when a mechanism-level operational check cannot be fully enforced by Tier 1 or Tier 2.',
    '',
    '## 2. Deterministic Lesson Format Constraints (`config.format`)',
    `- **Template:** \`${config.format.template}\``,
    `- **Maximum Length:** \`${config.format.maxChars}\` characters`,
    `- **Single Sentence Required:** \`${String(config.format.requireSingleSentence)}\` (no newlines, must end with \`.\`, no mid-sentence \`. \` / \`! \` / \`? \` splits)`,
    `- **Required Substrings:** ${requiredSubs} (for \`" because "\`, both the action clause before and mechanism clause after must be at least 10 characters)`,
    `- **Forbidden Regex Patterns:** ${forbiddenPatterns}`,
    '',
    '## 3. `memory_propose` -> `memory_commit` Workflow (`"lesson"` and `"rule"`)',
    `- Always call \`memory_propose\` before committing a \`"lesson"\` or \`"rule"\` (configured Distiller runner: \`${config.distiller.runner}\`, model: \`${config.distiller.model}\`).`,
    '- **When `executionMode === "resolved"`:** Inspect `matchStatus`, `bucketStatus`, and `choices[recommendedChoiceIndex]`, then pass the selected `op: "add"` or `op: "update"` payload to `memory_commit`.',
    '- **When `executionMode === "delegate_to_subagent"`:** Invoke the host subagent with `delegateToSubagent` (`model`, `effort`, `timeoutMs`, `systemPrompt`, `userPrompt`, `outputJsonSchema`) and pass the chosen `add` or `update` payload to `memory_commit`.',
    '- **Owner Rule Protection (`type: "rule"`):** Rules originate strictly from Owner mandates (`rule: <text>`). Present the Distiller\'s formatted wording and any overlap choice (`update` existing `R<n>` vs `add` new `R<next>`) to the Owner in prose, and call `memory_commit` **only after** explicit Owner `"go"` confirmation. Never downgrade a `"rule"` to a `"lesson"` or merge/remove an `R*` record via a lesson proposal.',
    '- **Human-Safe Cap Consolidation (`capMerge`):** In `SOFT_CAP_PRESSURE` or `AT_HARD_CAP`, attach `capMerge` to `op: "add"` **if and only if** two existing records in the target bucket share the exact same underlying failure mechanism, `type`, and `role`.',
    '',
    '## 4. Operational Notes (`type: "note"`) & `memory_drain_notes`',
    '- Operational and design decision notes (`N<n>`) bypass `memory_propose` and are committed directly via `memory_commit({ op: "add", type: "note", lifecycle, ... })`.',
    '- **Lifecycle Modes:**',
    '  - `persistent`: Retained until explicitly updated, removed (`op: "remove"`), or drained.',
    '  - `read-count`: Decrements `remainingReads` on each matching read without mutating `updatedAt` and deletes the note on its final read (`remainingReads === 1`, prefixed with `[FINAL READ - DRAINED] `).',
    '  - `hard-expiry`: Silently purged once `nowMs >= Date.parse(expiresAt)`.',
    '  - `soft-expiry`: Returned one final time (`[FINAL READ - DRAINED] `) once `nowMs >= Date.parse(expiresAt)` and immediately deleted.',
    '- **Bulk Drainage (`memory_drain_notes`):** Always call `memory_drain_notes` with `dryRun: true` first to preview `matchedNotes`, then invoke with `dryRun: false` once verified.',
    '',
    '## 5. Loading Path-Scoped Memories (`memory_load_scoped`)',
    `- Call \`memory_load_scoped({ role: "${role}", paths })\` when planning or working on specific files, directories, or glob patterns to load matching scoped \`R*\` -> \`L*\` -> \`N*\` records and track their IDs in the current compaction epoch.`,
  ];
  return lines.join('\n');
}
