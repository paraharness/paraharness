STATE
docs                       := ["docs/SPEC.md", "docs/CODING_SAMPLE.md", "docs/CODING_GUIDELINES.md"]
round                      := 1
$verified_findings         := []
$pending_adjacent_defects  := []
round_history              := [] (each completed round's verified findings and rejected false-positive patterns)

POST-COMPACTION GROUNDING (Triggered automatically by `.agents/hooks/post-compaction.mjs` on `PreInvocation` / `Stop` after any `CHECKPOINT` compaction in `transcript.jsonl`)
1. `.agents/hooks/post-compaction.mjs` injects `.memory/post-compaction.md` (or `.memory/post-compaction-<role>.md`) if present, or generates and saves the role's sequential grounding note automatically.
2. When `POST_COMPACTION_GROUNDING_REQUIRED` is injected, read every listed file in exact sequence, one by one, each one fully, before taking any other action.

```
    LOOP:
        STEP 1 — ADVERSARIAL COLD REVIEW (5x `invoke_subagent`, TypeName: 'loop-reviewer', Model: 'inherit')
            1.1 Launch 5 parallel cold Reviewer Subagents, each required to read its Reviewer bootstrap manifest (`docs/HARNESS_LOOP.md` §3) as Turn 1, then audit `docs/SPEC.md` and `docs/CODING_SAMPLE.md` per `docs/rules/REVIEWER.md` Rule 1 (in Round 1, inspecting `git diff origin/main...HEAD -- docs/SPEC.md docs/CODING_SAMPLE.md` and reading both files in full; in Round $r \ge 2$, inspecting `git diff HEAD~1..HEAD -- docs/SPEC.md docs/CODING_SAMPLE.md` and `git diff origin/main...HEAD -- docs/SPEC.md docs/CODING_SAMPLE.md` plus implicated sections) against its assigned lens:
              - Lens 1: Concurrency, State Machine Completeness, Lock Ordering, Crash Recovery & Distributed Ledger.
              - Lens 2: LLM Wire Protocols, Provider KV-Caching, Multi-Tool Batch Execution, Interrupts & Policy Guards.
              - Lens 3: Git Worktree Mechanics, Checkpointing, Merge/Rebase Protocols, OS Subprocesses & Daemon Lifecycles.
              - Lens 4: DSL Type Safety, Schema Projections, Topology Overlays, Lesson Math & Cross-Document Consistency (including alignment with `docs/CODING_GUIDELINES.md`).
              - Lens 5: Architectural Soundness, Pure AST Decoupling & First-Principles Critique (attacks architectural flaws across DSL architecture, AST purity vs. execution coupling, builder vs. AST separation, discriminated-union `type` nodes, `NodeExecutor<TNode>` dispatch, data flow, state management, execution, and forking — without blindly accepting existing premises; subject to Core Paradigm Invariant `(w)` and Anti-Nitpick Gate `(z)`).
            1.2 Wait for all 5 Reviewer Subagents to complete and collect/deduplicate their raw outputs, merging and draining `$pending_adjacent_defects` into `$findings`.

        STEP 2 — VERIFICATION GATE & HEAD ARBITRATION (`invoke_subagent`, TypeName: 'loop-verifier', Model: 'inherit')
            2.1 If count($findings) == 0:
                - Set `$verified_findings := []` and exit loop to DISTILLATION.
            2.2 Launch 1 Verifier Subagent with `$findings`:
                - Require it to read its Verifier bootstrap manifest (`docs/HARNESS_LOOP.md` §3) as Turn 1, then read `docs/SPEC.md` and `docs/CODING_SAMPLE.md` in full, in sequence, and verify every item in `$findings` against the exact lines of both files.
                - DEFECT GATE (Admit to `$verified_findings` IF AND ONLY IF at least one holds):
                  (a) Concurrency race, lock-ordering deadlock, or state-machine transition gap.
                  (b) Crash-recovery data loss, non-idempotent replay, or orphaned state.
                  (c) Provider wire-protocol error (HTTP 400), broken message alternation, or KV-cache prefix invalidation.
                  (d) Git, filesystem, checkpoint, or OS subprocess/daemon failure.
                  (e) TypeScript generic/builder type error, type erasure, or Zod schema mismatch.
                  (f) Mathematical formula defect or unreachable state.
                  (g) Cross-document or intra-document contradiction (across `SPEC.md`, `CODING_SAMPLE.md`, and `CODING_GUIDELINES.md`).
                  (h) Genuine architectural flaw: coupling between passive AST nodes and runtime execution logic (self-executing AST nodes, execution/builder methods on AST nodes, duck-typing runtime methods during static validation, or inability to swap the runtime execution engine over the same AST), broken data-flow/state-ownership invariant, or broken `NodeExecutor<TNode>` / discriminated-union (`type`) contract.
                - REJECTION GATE (Reject from `$verified_findings` if any holds):
                  (w) Violates the Core Paradigm Invariant by proposing to replace the declarative pure-AST DSL with imperative `async`/`await` functions, generators, or native TypeScript control flow (`if`/`for`/`while`).
                  (x) Factually false (already handled by existing text).
                  (y) Speculative new feature, new abstraction, or scope expansion nobody asked for.
                  (z) Stylistic preference, naming bike-shed, or prose wording nitpick disguised as an architectural flaw without a concrete structural or behavioral failure proof.
                - For each admitted item, Verifier outputs:
                  (1) Exact defective line numbers and quoted snippet from `SPEC.md` / `CODING_SAMPLE.md`,
                  (2) Concrete failure proof,
                  (3) Surgical fix options (`Option A`, and `Option B` when genuine trade-offs exist per `docs/rules/VERIFIER.md` Rule 3), and
                  (4) Verifier's recommended fix and why.
            2.3 Head arbitrates / tie-breaks the Verifier's recommendations against `RULE[user_global]` and `docs/rules/HEAD.md` (checking `round_history` per `docs/rules/HEAD.md` Rule 1 and escalating to Owner only if a fix alters undecided product/DSL design), locks in the winning fixes as `$verified_findings`, and records the round's verified findings and rejected false-positive patterns in `round_history`.
            2.4 If count($verified_findings) == 0:
                - Exit loop to DISTILLATION.

        STEP 3 — SPEC REMEDIATION (`invoke_subagent`, TypeName: 'loop-builder', Model: 'inherit')
            3.1 Launch 1 Remediation Subagent with `$verified_findings`:
                - Read its Builder bootstrap manifest (`docs/HARNESS_LOOP.md` §3) as Turn 1, then read `docs/SPEC.md` completely and `docs/CODING_SAMPLE.md` completely, in sequence.
                - Apply every fix in `$verified_findings` (plus direct in-scope cascade updates across `docs/SPEC.md` and `docs/CODING_SAMPLE.md`, and if `docs/plan/M*.md` exist, refreshing any shifted §2 `SPEC.md` / `CODING_SAMPLE.md` line ranges) surgically.
                - Rule A (Self-Review & Local Commit): Verify no edit breaks any existing invariant, type signature, or cross-reference across either file, confirm `git diff` is clean of unintended edits, and commit the remediated spec files locally via `lockf -k -t 30 .git/harness-commit.lock sh -c "git add -- docs/SPEC.md docs/CODING_SAMPLE.md docs/plan && git commit -m 'spec: remediate round <round>' -- docs/SPEC.md docs/CODING_SAMPLE.md docs/plan"` (never running `git push` per `docs/rules/BUILDER.md` Rule 6).
                - Rule B (Disclosed Adjacent Defects): Record any unrelated adjacent defects discovered during remediation in a `disclosed_adjacent_defects` section of the completion report (which Head appends to `$pending_adjacent_defects` for the next round's Step 1.2, pausing mid-turn via `send_message` only on a direct `SPEC_CONTRADICTION` per `docs/rules/BUILDER.md` Rule 2).
            3.2 Increment `round := round + 1` and repeat LOOP at STEP 1.

    DISTILLATION (When `round > 1` or when verified findings / false-positive clusters occurred)
    1. Launch 1 Distiller Subagent (`invoke_subagent`, TypeName: 'loop-distiller', Model: 'inherit') with its Distiller bootstrap manifest (`docs/HARNESS_LOOP.md` §3) and `round_history` (all verified findings and rejected false-positive patterns across rounds `1..round`).
    2. Distiller reads its Turn-1 manifest, updates `docs/lessons/{GENERAL,HEAD,BUILDER,REVIEWER,VERIFIER}.md` in-place per `docs/rules/DISTILLER.md` (`NO_LESSONS_ADDED` with zero file edits is the expected output when all findings were already covered by existing rules/guidelines), and commits any modified `docs/lessons/*.md` files locally (never running `git push`). Head audits `git diff origin/main...HEAD -- docs/lessons/` against `docs/rules/DISTILLER.md` Rules 1–4 before TERMINATION.

    TERMINATION (count($verified_findings) == 0)
    Head executes `git push origin main` (`docs/rules/HEAD.md` Rule 5) and reports final convergence summary and `git diff --stat` to Owner.
```
