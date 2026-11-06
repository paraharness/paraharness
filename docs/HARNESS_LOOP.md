# Harness Evolution Loop (`HARNESS_LOOP`)

## 1. Purpose & Context

`HARNESS_LOOP` is the meta-loop used to audit, evolve, and refine the harness itself—the rules, coding guidelines, lessons, skills, deterministic gate scripts, hooks, and loop procedures that govern how agents plan, build, review, verify, and learn in this repository.

Whereas `SPEC_LOOP`, `PLAN_LOOP`, and `IMPL_LOOP` treat the harness as fixed law and optimize the product artifacts, `HARNESS_LOOP` treats the harness files as the system under test: it evaluates how effectively the harness shapes agent behavior, autonomy, defect detection, and token/round economics, and refines the harness against empirical evidence and first-principles critique.

---

## 2. State & Target Scope

```
STATE
harness_files      := [
  "CLAUDE.MD",
  "docs/CODING_GUIDELINES.md",
  "docs/rules/GENERAL.md",
  "docs/rules/HEAD.md",
  "docs/rules/BUILDER.md",
  "docs/rules/REVIEWER.md",
  "docs/rules/VERIFIER.md",
  "docs/rules/DISTILLER.md",
  "docs/lessons/GENERAL.md",
  "docs/lessons/HEAD.md",
  "docs/lessons/BUILDER.md",
  "docs/lessons/REVIEWER.md",
  "docs/lessons/VERIFIER.md",
  "docs/SPEC_LOOP.md",
  "docs/PLAN_LOOP.md",
  "docs/IMPL_LOOP.md",
  "docs/HARNESS_LOOP.md",
  ".agents/hooks.json",
  ".agents/hooks/**",
  "scripts/**"
]
baseline_evidence  := Empirical telemetry and outcomes from prior loop executions (when available):
  - Rounds to convergence per milestone/loop
  - Admitted findings ($verified_findings) vs. rejected reviewer findings (false positives)
  - Escaped defects discovered in downstream waves or by the Owner
  - Subagent context token consumption, compactions, and stream timeouts
  - Builder escalations (valid vs. unnecessary permission-seeking)
  - Distilled lessons in `docs/lessons/*.md`
round              := 1
$verified_changes  := []
context_tokens     := input_tokens + cache_read_tokens + output_tokens (from latest PLANNER_RESPONSE in transcript.jsonl)
```

---

## 3. Role Bootstrap Manifests & Loading Guarantee

Every agent in any loop must load its role manifest as its first action before inspecting task files:

| Role | Required Bootstrap Files |
| :--- | :--- |
| **Head** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/HEAD.md`, `docs/lessons/GENERAL.md`, `docs/lessons/HEAD.md`, active `docs/*_LOOP.md` |
| **Builder / Remediator** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/BUILDER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/BUILDER.md`, `docs/CODING_GUIDELINES.md` |
| **Reviewer** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/REVIEWER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/REVIEWER.md`, `docs/CODING_GUIDELINES.md` |
| **Verifier** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/VERIFIER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/VERIFIER.md`, `docs/CODING_GUIDELINES.md` |
| **Distiller** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/DISTILLER.md`, `docs/lessons/GENERAL.md`, `docs/CODING_GUIDELINES.md` |

**Deterministic Loading Enforcement:**
1. **Subagent Registration (`define_subagent`):** At loop initialization, Head defines role-specific subagent types whose system prompt mandates reading the exact bootstrap manifest for that role as Turn 1.
2. **Transcript Audit Gate:** Before Head accepts any subagent report, Head (or `scripts/verify-subagent-reads.mjs <transcript_jsonl> <role>`) verifies that `read_file` tool calls for every file in the role's bootstrap manifest appear in the subagent's transcript. Any subagent report produced without reading its manifest is rejected and re-run.

---

## 4. Hard Invariants (Non-Negotiable Boundaries)

No evolution round may weaken or violate these invariants:

1. **Owner Authority & Disclosure (`RULE[user_global]`):** The Owner decides product, design, legal, platform, stack, money, data, and anything irreversible. Every verified architectural, design, or normative harness change is disclosed to the Owner.
2. **Separation of Powers:** An agent that mutates files never serves as the sole verifier of its own mutations. Cold review and falsification-based verification run in independent contexts.
3. **Separation of Artifact Concerns:**
   - `docs/CODING_GUIDELINES.md` contains code/test standards and `DON'T` / `DO` examples (with JSDoc examples confined strictly to §2).
   - `docs/rules/*.md` contains atomic behavioral rules (`1–3` lines each), split into `GENERAL.md` and role-specific files.
   - `docs/lessons/*.md` contains atomic, cold, present-tense empirical nuances (`1–3` lines each), split into `GENERAL.md` and role-specific files, capped at 25 entries per file.
   - `docs/*_LOOP.md` contains pure loop procedure and state machines—never coding opinions.
4. **Zero Steering / Zero Confirmation Bias:** Prompts to Reviewers and Verifiers in any loop must state the scope, context, invariants, and objective evaluation criteria—never leading questions, pre-supposed conclusions, or desired answers that bias the agent toward confirming existing text.
5. **Head Context Protection:** Head never reads bulk repository source files into its own context; full-file reads happen inside subagent contexts.

---

## 5. Evaluation Criteria (Fitness Dimensions)

Harness changes are evaluated against six objective dimensions:

1. **Behavioral Precision & Autonomy:** Do the rules give each role clear authority to act autonomously inside its boundary without inducing neurotic permission-seeking, while halting reliably on genuine cross-boundary or Owner-level blockers?
2. **Defect Catch Rate vs. False-Positive Churn:** Does the harness catch real semantic, architectural, concurrency, performance, and structural defects early, without causing Reviewers and Verifiers to waste rounds on false alarms or subjective style debates?
3. **Mechanization Over Prose:** Can a rule or check currently relies on agent memory/prose be enforced deterministically by a fast AST/CLI script (`pnpm check:code`) and removed or shortened in prose?
4. **Signal-to-Token Density:** Every line in a bootstrap file is paid on every turn of every session that loads it. Does every line earn its token cost by changing behavior or preventing a real failure mode, with zero duplication across `CLAUDE.MD`, `CODING_GUIDELINES.md`, `rules/*.md`, `lessons/*.md`, and `*_LOOP.md`?
5. **Cross-Artifact Consistency:** Are all file paths, script names, role manifests, gate commands, and termination conditions consistent across all harness files?
6. **Lesson Promotion & Pruning:** Have recurring lessons in `docs/lessons/*.md` matured into deterministic linter checks or core guidelines/rules so `docs/lessons/*.md` stays lean and high-signal?

---

## 6. Evolution Loop Procedure

```
HOOK (PreInvocation in .agents/hooks.json)
On every turn before model invocation:
Read latest PLANNER_RESPONSE token sum from stdin.transcriptPath.
If context_tokens >= 700_000:
Inject high-priority systemMessage: "CONTEXT_THRESHOLD_700K_REACHED".

PRE-COMPACTION HANDOFF (Triggered immediately when context_tokens >= 700_000)
1. Write full loop state (round, baseline_evidence, $verified_changes, exact instructions) to .memory/head-handoff.md.
2. Spawn fresh Head (`invoke_subagent`, TypeName: 'self', Model: 'inherit') with .memory/head-handoff.md, emit its clickable conversation://<id> link, and retire this session.

LOOP:
    STEP 1 — UNSTEERED FIRST-PRINCIPLES CRITIQUE (3x `invoke_subagent`, TypeName: 'research', Model: 'inherit')
        1.1 Launch 3 parallel cold Critic Subagents. Pass each Critic:
            - Its required Reviewer bootstrap manifest (§3),
            - The list of `harness_files` (§2) to read in full,
            - The `baseline_evidence` summary (§2),
            - The Hard Invariants (§4) and Evaluation Criteria (§5),
            - Zero leading hints or pre-selected targets.
            Assign each Critic an independent analytical perspective:
            - Critic A (Agent Autonomy, Incentives & Behavioral Failure Modes): Analyze how each role (`Head`, `Builder`, `Reviewer`, `Verifier`, `Distiller`) will actually behave under these rules and loops—where instructions create ambiguity, paralysis, over-escalation, blind compliance, role confusion, or incentive to cut corners.
            - Critic B (Context Economics, Duplication & Mechanization): Analyze token cost per turn across roles, cross-file redundancy, rules that belong in deterministic AST/CLI scripts rather than prose, and lessons that should be promoted, merged, or pruned.
            - Critic C (Loop Topology, Escape Hatches & Verification Rigor): Analyze the state machines in `SPEC_LOOP`, `PLAN_LOOP`, `IMPL_LOOP`, and `HARNESS_LOOP` plus the deterministic gate scripts for deadlock states, unverified handoffs, defect escape paths, or false-positive amplification.
        1.2 Verify each Critic's transcript read manifest (§3). Collect and deduplicate all raw critiques and proposals into `$candidates`.

    STEP 2 — FALSIFICATION & VERIFICATION GATE (`invoke_subagent`, TypeName: 'research', Model: 'inherit')
        2.1 If count($candidates) == 0:
            - Set `$verified_changes := []` and exit loop to TERMINATION.
        2.2 Launch 1 Verifier Subagent with its Verifier bootstrap manifest (§3), `harness_files`, `baseline_evidence`, and `$candidates`:
            - Attempt to falsify each candidate in `$candidates` against the exact lines of `harness_files`, the Hard Invariants (§4), and the Evaluation Criteria (§5).
            - ADMISSION GATE (Admit to `$verified_changes` IF AND ONLY IF at least one holds):
              (a) Eliminates a proven contradiction, ambiguity, deadlock, or defect escape path across `harness_files`.
              (b) Replaces prose enforcement with a deterministic script/hook check or closes a gap in an existing deterministic check.
              (c) Removes cross-file duplication or token bloat while preserving or increasing behavioral precision.
              (d) Resolves an empirical failure mode, false-positive cluster, or autonomy bottleneck demonstrated in `baseline_evidence` or `docs/lessons/*.md`.
            - REJECTION GATE (Reject from `$verified_changes` if any holds):
              (x) Violates any Hard Invariant in §4.
              (y) Factually false upon inspecting the exact lines of `harness_files`.
              (z) Cosmetic rewording, speculative ceremony, or net token increase that changes no observable agent decision or deterministic gate outcome.
            - For each admitted item, Verifier outputs:
              (1) Exact file + line numbers and quoted snippet,
              (2) Concrete proof of the flaw or improvement along the §5 dimensions,
              (3) Alternative surgical formulations (`Option A`, `Option B`) with trade-offs, and
              (4) Verifier's recommended pick and why.
        2.3 Verify Verifier's transcript read manifest (§3).
        2.4 Head arbitrates the Verifier's recommendations against §4 and §5 (disclosing any normative or structural harness change to Owner and pausing for Owner ruling if a change alters Owner-decided policy), and locks in `$verified_changes`.
        2.5 If count($verified_changes) == 0:
            - Exit loop to TERMINATION.

    STEP 3 — SURGICAL HARNESS MUTATION (`invoke_subagent`, TypeName: 'self', Model: 'inherit')
        3.1 Launch 1 Harness Builder Subagent with its Builder bootstrap manifest (§3) and `$verified_changes`:
            - Read all implicated files in `harness_files`.
            - Apply `$verified_changes` surgically across `harness_files` and any implicated deterministic gate scripts.
            - If a change updates or adds a deterministic script/hook (`scripts/**`, `.agents/hooks/**`), execute it against both passing and failing fixtures to prove it exits `0` on compliant input and non-zero on violations.
            - Self-audit cross-file references, role manifests, and `git diff` to ensure zero unintended edits or broken links.
        3.2 Verify Builder's transcript read manifest (§3).
        3.3 If fixing an item exposes an adjacent contradiction across `harness_files`, Builder reports it to Head (`send_message`) for evaluation against Step 2.2 before folding it in.
        3.4 Increment `round := round + 1` and repeat LOOP at STEP 1.

TERMINATION (count($verified_changes) == 0)
Present converged harness diff summary (`git diff --stat`) and verification results to Owner.
```
