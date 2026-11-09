STATE
docs                       := ["docs/unified-memory/UNIFIED_MEMORY_SPEC.md", "docs/CODING_GUIDELINES.md"]
round                      := 3
$verified_mechanical_fixes := []
$verified_core_proposals   := []
$pending_adjacent_defects  := []
round_history              := [
  {
    "round": 1,
    "pre_remediation_sha": "37a80160c0e2836d52136507d382724c0e01f725",
    "verified_mechanical_fixes": [
      "F1: Co-locate MemoryRecordTypeSchema & MemoryMetaSchema in memory-record.schema.ts (§3.2), import MemoryRecordTypeSchema in memory-config.schema.ts (§2.2), reference MemoryMetaSchema in §3.1, remove duplicate/self-imports in §7.1–§7.2, and update §9.2.",
      "F2: Fix normalizeMemoryPathPattern (§4.1) for exact workspaceRoot, standalone '.', external absolute paths, and path array deduplication; fix §4.2 glob metacharacter description; and specify §7.2 Step 3 early-exit when all touchedPaths are outside workspaceRoot.",
      "F3: Define extractProbeSuffixes & buildRelativeProbes in §4.3 and apply synthetic extension-aware probe intersection across Cases 2, 3, and 4.",
      "F4: Require ancestor-or-equal prefix containment for every record context item in §5.2 Step 1, expand pathSpec to (pathTier, maxPrefixSegments, maxPrefixChars) in §5.2 Step 2, and define UNCAPPED bucketId & population B in §5.2 Step 3.",
      "F5: Define SessionIdSchema & MemoryLatestRoleStateSchema, enforce session-lock-before-ledger-lock ordering in memory_init (§6.2) and memory_load_scoped (§6.3), preserve post-init seenRecordIds via 'PENDING_HOOK_EPOCH' in §7.2 Step 2, validate/fallback role to 'general' in §7.2 Step 1, and always persist updated session state in §7.2.",
      "F6: Reconcile memory.meta.json highWaterMarks across raw records before hard-expiry purge, enforce strict multi-file write order (memory.meta.json -> memory.jsonl -> Git sync -> session-state) in §3.1 & §8.1, specify remainingReads on MemoryLoadedNoteRecord in §3.3, and unify hard-expiry & Git sync across §§6.2–6.6 and §7.2.",
      "F7: Add bucketRecordIds to MemoryBucketStatusSchema (§6.1) and userPrompt (§6.4), restrict MemoryCapMergeProposalSchema to R/L with distinct same-prefix refine, add DistillerStructuredOutputSchema & MemoryProposeOutputSchema superRefine and delegateToSubagent.timeoutMs + DistillerProposalRequest.outputJsonSchema, enforce rule protection & choice validation in §6.4 & §6.5, and tighten validateLessonTextFormat in §6.7.",
      "F8: Move MemoryCommitInputSchema.superRefine to outer discriminatedUnion, trim text/mergedText, union context & repos on capMerge, check capacity on bucket/repo-scope transitions during op: 'update', and specify MemoryCommitOutput field mapping in §6.5.",
      "F9: Expand MemoryConfigSchema.superRefine (§2.2), replace git clone with in-place ensureMemoryGitCheckout under <ledgerPath>.lock (§8.2.1), add fallback commit author identity (§8.2.2), fix 3-way reconcile edge cases (unrelated histories, highWaterMark re-numbering + idRemap, numeric timestamp comparison, read-count delta merge, post-reconcile capacity check) in §8.2.3, and complete Claude Code & Antigravity hook path extraction and incremental transcript offset tracking in §7.1–§7.2.",
      "F10: Add complete Rule 2.2 JSDoc block tags (@param, @returns, @throws) to MemoryHarnessContract (§9.1), add 6 src/internal/* phase helper modules to §9.2, and complete peer/SKILL.md integration in §10."
    ],
    "verified_core_proposals": [],
    "rejected_findings": []
  },
  {
    "round": 2,
    "pre_remediation_sha": "ee991795c1d0709e0850e5a37b4b6f4cd14fa6ad",
    "verified_mechanical_fixes": [
      "R2-F1: Re-ensure <checkoutDir>/.gitignore and persist reconciled pre-existing local ledger in ensureMemoryGitCheckout (§8.2.1); restore pre-operation reconciled state on post-push CAP_EXCEEDED, skip empty commits on clean status --porcelain, compose transitive cumulativeIdRemap across push retries, and remap other sessions' seenRecordIds only after releasing <ledgerPath>.lock and <sessionId>.lock (§8.1, §8.2.3).",
      "R2-F2: Release <ledgerPath>.lock immediately after loading the in-memory ledger snapshot and computing bucketStatus in memory_propose (§6.4 Step 2), and add 'GIT_SYNC_FAILED' to MemoryHarnessContract.propose @throws JSDoc (§9.1).",
      "R2-F3: Validate explicit input.sessionId strictly and env fallbacks via safeParse in memory_init (§6.2) and memory_load_scoped (§6.3); join raw path+pattern/glob before normalizeMemoryPathPattern in Claude Code Glob/Grep and Antigravity find_by_name/grep_search (§7.1); acquire <sessionId>.lock before scanning transcriptPath, handle incremental vs full transcript scan, and prioritize transcript memory_init role over default 'general' in §7.2.",
      "R2-F4: Reject duplicate roles/types, './'/'C:' cap paths, and invalid ledgerPath/checkoutDir in MemoryConfigSchema.superRefine (§2.2); fix '/' when workspaceRoot !== '/' in normalizeMemoryPathPattern (§4.1 Step 3); and replace extractProbeSuffixes with segment-wise buildRelativeProbes and isDirectoryCandidate in matchesContextScope (§4.3).",
      "R2-F5: Define isContextCoveredByCapPattern(p, c, repoFiles) for directional cap coverage in §5.2 Step 1, define (maxPrefixSegments, maxPrefixChars) as the minimum across c in r.context of the maximum covering p in §5.2 Step 2, and explicitly define capped bucket zone formula in §5.2 Step 3 & §5.3.",
      "R2-F6: Allow .nullable().optional() on proposedContext/proposedRepos and add alsoRemoveIds .refine on update choices (§6.4); tighten DistillerStructuredOutputSchema & MemoryProposeOutputSchema superRefine and Step 4 validation (§6.4); require keepRecord.role === removeRecord.role on capMerge (§5.3, §6.4, §6.5); enforce pre-lock capMerge rule protection and explicit RECORD_NOT_FOUND vs VALIDATION_FAILED checks in memory_commit (§6.5); and include the memory_propose -> memory_commit lesson/rule workflow in memory_init protocol (§6.2).",
      "R2-F7: State explicitly in §3.3 that decrementing lifecycle.remainingReads during read operations mutates only remainingReads and never sets or updates note.updatedAt."
    ],
    "verified_core_proposals": [
      "R2-P1: Add optional autoPullOnInit: z.boolean().default(true) to MemoryGitStorageConfigSchema (§2.2) and fetch+reconcile origin/<branch> during memory_init (§6.2, §8.2.1) so multi-repo sessions receive newly pushed remote rules, lessons, and handoff notes at session startup."
    ],
    "rejected_findings": []
  },
  {
    "round": 3,
    "pre_remediation_sha": "3df6e4d3d43ccfba2756c53d4733e1b42d87ce6f",
    "verified_mechanical_fixes": [],
    "verified_core_proposals": [],
    "rejected_findings": []
  }
]
pre_remediation_sha        := "3df6e4d3d43ccfba2756c53d4733e1b42d87ce6f"

POST-COMPACTION GROUNDING (Triggered automatically by `.agents/hooks/post-compaction.mjs` on `PreInvocation` / `Stop` after any `CHECKPOINT` compaction in `transcript.jsonl`)
1. `.agents/hooks/post-compaction.mjs` injects `.memory/post-compaction.md` (or `.memory/post-compaction-<role>.md`) if present, or generates and saves the role's sequential grounding note automatically.
2. When `POST_COMPACTION_GROUNDING_REQUIRED` is injected, read every listed file in exact sequence, one by one, each one fully, before taking any other action.

```
    LOOP:
        STEP 1 — ADVERSARIAL COLD REVIEW (5x `invoke_subagent`, TypeName: 'loop-reviewer', Model: 'inherit')
            1.1 Launch 5 parallel cold Reviewer Subagents, each required to read its Reviewer bootstrap manifest (`docs/HARNESS_LOOP.md` §3: `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/REVIEWER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/REVIEWER.md`, `docs/CODING_GUIDELINES.md`) as Turn 1, then audit `docs/unified-memory/UNIFIED_MEMORY_SPEC.md` per `docs/rules/REVIEWER.md` Rule 1 (in Round 1, reading `docs/unified-memory/UNIFIED_MEMORY_SPEC.md` in full; in Round $r \ge 2$, inspecting `git diff <pre_remediation_sha>..HEAD -- docs/unified-memory/UNIFIED_MEMORY_SPEC.md` and reading `docs/unified-memory/UNIFIED_MEMORY_SPEC.md` in full) against its assigned lens:
              - Lens 1: Concurrency, Lock Ordering, Note Lifecycle State Machine Completeness, Crash Recovery & Atomic Persistence (`§§3, 7, 8`).
              - Lens 2: Tool Contracts, Distiller Prompt-Caching, Subagent vs. CLI Runner Dispatch, Rule Protection & Format Validation (`§§1, 6, 9, 10`).
              - Lens 3: Git Branch Worktree Mechanics, Multi-Repo 3-Way Ledger Reconciliation, ID Collision Re-numbering & Compaction-Epoch Hook Deduplication (`§§3.1, 7, 8`).
              - Lens 4: Zod v4 Schema Soundness, 4-Way Path/Glob Matching, Most-Specific-Bucket-Wins Capacity Math & Cross-Document Consistency with `docs/CODING_GUIDELINES.md` (`§§2, 4, 5, 6, 9`).
              - Lens 5: First-Principles Architectural Soundness & Edge-Case Critique (audits end-to-end data flow, interface contracts, failure modes, and multi-repo/compaction interactions across `docs/unified-memory/UNIFIED_MEMORY_SPEC.md`, classifying each finding as either a `MECHANICAL_DEFECT` [gap, contradiction, schema bug, race, or edge-case hole within the settled design] or a `CORE_PROPOSAL` [a substantive product, contract, or design improvement for Owner decision]).
            1.2 Wait for all 5 Reviewer Subagents to complete and collect/deduplicate their raw outputs, merging and draining `$pending_adjacent_defects` into `$findings`.

        STEP 2 — VERIFICATION GATE & HEAD ARBITRATION (`invoke_subagent`, TypeName: 'loop-verifier', Model: 'inherit')
            2.1 If count($findings) == 0:
                - Set `$verified_mechanical_fixes := []` and exit loop to DISTILLATION.
            2.2 Launch 1 Verifier Subagent with `$findings` (and `round_history` + `pre_remediation_sha` when `round > 1`):
                - Require it to read its Verifier bootstrap manifest (`docs/HARNESS_LOOP.md` §3: `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/VERIFIER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/VERIFIER.md`, `docs/CODING_GUIDELINES.md`) as Turn 1, then read `docs/unified-memory/UNIFIED_MEMORY_SPEC.md` in full (plus `git diff <pre_remediation_sha>..HEAD -- docs/unified-memory/UNIFIED_MEMORY_SPEC.md` when `round > 1`), and verify every item in `$findings` against the exact lines of `docs/unified-memory/UNIFIED_MEMORY_SPEC.md` and `docs/CODING_GUIDELINES.md` per `docs/rules/VERIFIER.md`.
                - DEFECT & PROPOSAL GATE (Admit IF AND ONLY IF at least one holds, and classify into `MECHANICAL_FIX` vs `CORE_PROPOSAL`):
                  (a) Concurrency race, lock-ordering deadlock, or note lifecycle state-machine transition gap.
                  (b) Crash-recovery data loss, non-idempotent replay, ID reuse/collision, or orphaned state.
                  (c) Distiller prompt-cache prefix invalidation, subagent/CLI runner contract gap, or rule-protection violation.
                  (d) Git worktree/clone, 3-way multi-repo merge, filesystem, or hook compaction-epoch failure.
                  (e) TypeScript interface error, Zod v4 schema mismatch/bug, or `docs/CODING_GUIDELINES.md` violation (such as Rule 1.1 single-kind files, Rule 1.2 reachable sub-interfaces, Rule 2.1–2.4 JSDoc/comment rules, or Rule 3.5 library-first mandate).
                  (f) 4-way path/glob matching edge-case failure or most-specific-bucket-wins capacity formula defect.
                  (g) Intra-document ambiguity, gap, or contradiction in `docs/unified-memory/UNIFIED_MEMORY_SPEC.md`.
                  (h) Substantive architectural or product contract improvement with concrete proof of superiority (classified strictly as `CORE_PROPOSAL` so it is proposed to the Owner rather than silently mutating Owner-settled design).
                - REJECTION GATE (Reject if any holds):
                  (w) Violates Owner-settled product decisions (`memory.config.json` + single `memory.jsonl` ledger + `rule` | `lesson` | `note` types + 5 tools + file-interaction hook + most-specific-bucket-wins + zero bogus merges in `softCap..hardCap`).
                  (x) Factually false (already handled by existing text in `UNIFIED_MEMORY_SPEC.md`, or contradicts a prior settled ruling / re-flags a previously falsified claim in `round_history` when the target lines are unchanged).
                  (y) Demands writing literal function-body implementation code into `UNIFIED_MEMORY_SPEC.md` instead of declarative contracts, schemas, interfaces, and behavioral invariants.
                  (z) Stylistic preference, naming bike-shed, or prose wording nitpick without a concrete structural, schema, or behavioral failure proof.
                - Classification Rule (`MECHANICAL_FIX` vs `CORE_PROPOSAL`):
                  - **`MECHANICAL_FIX` (`$verified_mechanical_fixes`):** Closes an ambiguity, edge-case gap, intra-spec contradiction, race condition, math/matching bug, or Zod/TypeScript/`CODING_GUIDELINES.md` error while preserving the Owner-settled product and tool design. Applied automatically in STEP 3.
                  - **`CORE_PROPOSAL` (`$verified_core_proposals`):** Alters an Owner-settled product rule, tool signature, configuration structure, or architectural trade-off. Recorded in `$verified_core_proposals` (with trade-offs and recommended pick) to present to the Owner for decision; never applied blindly to `UNIFIED_MEMORY_SPEC.md`.
                - For each admitted item, Verifier outputs:
                  (1) Classification (`MECHANICAL_FIX` or `CORE_PROPOSAL`),
                  (2) Exact line numbers and quoted snippet from `UNIFIED_MEMORY_SPEC.md`,
                  (3) Concrete failure or improvement proof,
                  (4) Surgical fix/proposal options (`Option A`, and `Option B` when genuine trade-offs exist per `docs/rules/VERIFIER.md` Rule 3), and
                  (5) Verifier's recommended pick and why.
            2.3 Head arbitrates the Verifier's output against `RULE[user_global]` and `docs/rules/HEAD.md`:
                - Locks in verified mechanical fixes as `$verified_mechanical_fixes`,
                - Appends any verified core improvements to `$verified_core_proposals` for Owner presentation, and
                - Records the round's verified mechanical fixes, queued core proposals, and rejected false-positive patterns in `round_history`.
            2.4 If count($verified_mechanical_fixes) == 0:
                - Exit loop to DISTILLATION.

        STEP 3 — SPEC REMEDIATION (`invoke_subagent`, TypeName: 'loop-builder', Model: 'inherit')
            3.1 Record `pre_remediation_sha := $(git rev-parse HEAD)` and launch 1 Remediation Subagent with `$verified_mechanical_fixes`:
                - Read its Builder bootstrap manifest (`docs/HARNESS_LOOP.md` §3: `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/BUILDER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/BUILDER.md`, `docs/CODING_GUIDELINES.md`) as Turn 1, then read `docs/unified-memory/UNIFIED_MEMORY_SPEC.md` completely.
                - Apply every fix in `$verified_mechanical_fixes` (plus direct in-scope cascade updates across `docs/unified-memory/UNIFIED_MEMORY_SPEC.md`) surgically, never applying `$verified_core_proposals` without Owner approval and never writing literal implementation bodies into the spec.
                - Rule A (Self-Review & Local Commit): Verify no edit breaks any existing invariant, type signature, Zod schema, or cross-reference across `docs/unified-memory/UNIFIED_MEMORY_SPEC.md`, confirm `git diff -- docs/unified-memory/UNIFIED_MEMORY_SPEC.md` is clean of unintended edits and inline `//` or `/* */` comments, and commit the remediated spec locally via `lockf -k -t 30 .git/harness-commit.lock sh -c "git add -- docs/unified-memory/UNIFIED_MEMORY_SPEC.md docs/unified-memory/UM_SPEC_LOOP.md && git commit -m 'unified-memory: remediate spec round <round>' -- docs/unified-memory/UNIFIED_MEMORY_SPEC.md docs/unified-memory/UM_SPEC_LOOP.md"` (never running `git push` per `docs/rules/BUILDER.md` Rule 6).
                - Rule B (Disclosed Adjacent Defects): Record any unrelated adjacent defects discovered during remediation in a `disclosed_adjacent_defects` section of the completion report (which Head appends to `$pending_adjacent_defects` for the next round's Step 1.2).
            3.2 Increment `round := round + 1` and repeat LOOP at STEP 1.

    DISTILLATION (When `round > 1` or when verified findings / false-positive clusters occurred)
    1. Launch 1 Distiller Subagent (`invoke_subagent`, TypeName: 'loop-distiller', Model: 'inherit') with its Distiller bootstrap manifest (`docs/HARNESS_LOOP.md` §3) and `round_history`.
    2. Distiller reads its Turn-1 manifest, updates `docs/lessons/{GENERAL,HEAD,BUILDER,REVIEWER,VERIFIER}.md` in-place per `docs/rules/DISTILLER.md` (`NO_LESSONS_ADDED` with zero file edits is the expected output when all findings were already covered by existing rules/guidelines), and commits any modified `docs/lessons/*.md` files locally (never running `git push`).

    TERMINATION (count($verified_mechanical_fixes) == 0)
    Head reports the final convergence summary across all rounds, presents any `$verified_core_proposals` (with options, trade-offs, and recommended picks) to the Owner for decision, and stops without starting spec execution/implementation.
```
