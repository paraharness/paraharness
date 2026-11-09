STATE
docs                       := ["docs/unified-memory/UNIFIED_MEMORY_SPEC.md", "docs/CODING_GUIDELINES.md"]
round                      := 1
$verified_mechanical_fixes := []
$verified_core_proposals   := []
$pending_adjacent_defects  := []
round_history              := [] (each completed round's verified mechanical fixes, queued core proposals, and rejected false-positive patterns)
pre_remediation_sha        := "" (captured via git rev-parse HEAD when transitioning from STEP 2 to STEP 3)

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
