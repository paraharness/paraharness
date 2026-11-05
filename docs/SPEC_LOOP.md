STATE
docs               := ["docs/SPEC.md", "docs/CODING_SAMPLE.md"]
round              := 5
$verified_findings := Round_5_Verified_Findings (count = 13, Options 1A..13A)
context_tokens     := input_tokens + cache_read_tokens + output_tokens (from latest PLANNER_RESPONSE in transcript.jsonl)

HOOK (PreInvocation in .agents/hooks.json)
On every turn before model invocation:
Read latest PLANNER_RESPONSE token sum from stdin.transcriptPath.
If context_tokens >= 700_000:
Inject high-priority systemMessage: "CONTEXT_THRESHOLD_700K_REACHED".

PRE-COMPACTION HANDOFF (Triggered immediately when context_tokens >= 700_000)
1. Write full loop state (round, $verified_findings, completed rounds, exact instructions) to .memory/head-handoff.md.
2. Spawn fresh Head (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High]) with .memory/head-handoff.md, emit its clickable conversation://<id> link, and retire this session (or halt for manual left-sidebar "New Conversation" if preferred).

HEAD CONTEXT INVARIANT
Head never reads full `docs/SPEC.md` or `docs/CODING_SAMPLE.md` into its own context during the loop.
Full-document reads happen strictly inside fresh Remediation and Verifier subagent contexts.

```
    LOOP: while count($verified_findings) > 0:
        STEP 1 — REMEDIATION (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High])
            1.1 Launch 1 Remediation Subagent with `$verified_findings` and strict rules:
            - Read `docs/SPEC.md` completely, then `docs/CODING_SAMPLE.md` completely, in sequence.
              - Apply every fix in `$verified_findings` surgically across both files.
              - Rule A (Self-Review): Verify no edit breaks any existing invariant, type signature, or cross-reference across either file.
              - Rule B (No Glossing Over): If fixing an item exposes an adjacent or dependent defect not listed in `$verified_findings`, DO NOT gloss over it and DO NOT silently improvise unapproved architectural changes—report the exact disclosed defect(s) to Head.
              1.2 While Remediation Subagent reports disclosed adjacent defects (Rule B):
              - Head evaluates each disclosed defect against the Defect Gate (Step 3.2).
              - Head messages the SAME Remediation Subagent (`send_message`) authorizing the exact fix to fold in.
              - Remediation Subagent applies the authorized fix, re-runs Rule A self-review, and reports back.
              1.3 Remediation step closes only when Remediation Subagent confirms:
              - All `$verified_findings` and all authorized Rule B disclosures are applied.
              - `git diff` is clean of unintended edits.
        
        STEP 2 — ADVERSARIAL COLD REVIEW (4x `invoke_subagent`, TypeName: 'research', Model: 'inherit' [Argon 4 High])
            2.1 Launch 4 parallel cold Reviewer Subagents, each required to read `docs/SPEC.md` and `docs/CODING_SAMPLE.md` in full, in sequence, before auditing its assigned lens:
            - Lens 1: Concurrency, State Machine Completeness, Lock Ordering, Crash Recovery & Distributed Ledger.
              - Lens 2: LLM Wire Protocols, Provider KV-Caching, Multi-Tool Batch Execution, Interrupts & Policy Guards.
              - Lens 3: Git Worktree Mechanics, Checkpointing, Merge/Rebase Protocols, OS Subprocesses & Daemon Lifecycles.
              - Lens 4: DSL Type Safety, Schema Projections, Topology Overlays, Lesson Math & Cross-Document Consistency.
              2.2 Wait for all 4 Reviewer Subagents to complete. Collect and deduplicate their raw outputs into `$findings`.
        
        STEP 3 — VERIFICATION GATE (`invoke_subagent`, TypeName: 'research', Model: 'inherit' [Argon 4 High])
            3.1 If count($findings) == 0:
            - Set `$verified_findings := []` and exit loop.
            3.2 Launch 1 Verifier Subagent with `$findings`:
              - Instruct it to read `docs/SPEC.md` and `docs/CODING_SAMPLE.md` in full, in sequence, and verify every item in `$findings` against the exact lines of both files.
              - DEFECT GATE (Admit to `$verified_findings` IF AND ONLY IF at least one holds):
              (a) Concurrency race, lock-ordering deadlock, or state-machine transition gap.
              (b) Crash-recovery data loss, non-idempotent replay, or orphaned state.
              (c) Provider wire-protocol error (HTTP 400), broken message alternation, or KV-cache prefix invalidation.
              (d) Git, filesystem, checkpoint, or OS subprocess/daemon failure.
              (e) TypeScript generic/builder type error or Zod schema mismatch.
              (f) Mathematical formula defect or unreachable state.
              (g) Cross-document or intra-document contradiction.
              - REJECTION GATE (Reject from `$verified_findings` if any holds):
              (x) Factually false (already handled by existing text).
              (y) Speculative new feature, new abstraction, or scope expansion nobody asked for.
              (z) Stylistic preference or prose wording nitpick that alters no behavior.
              - For each admitted item, Verifier outputs:
                (1) Exact defective line numbers and quoted snippet from `SPEC.md` / `CODING_SAMPLE.md`,
                (2) Concrete failure proof,
                (3) Alternative surgical fixes (`Option A`, `Option B`) with trade-offs, and
                (4) Verifier's recommended fix and why.
              3.3 Head arbitrates / tie-breaks the Verifier's recommendations against `RULE[user_global]` (Simplicity first; surgical changes; escalating to Owner only if a fix alters undecided product/DSL design), locks in the winning fixes as `$verified_findings`, and increments `round := round + 1`.
        
        TERMINATION (count($verified_findings) == 0)
        Report final convergence summary and `git diff --stat` to Owner.
```
