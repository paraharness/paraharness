# Harness Evolution Loop (`HARNESS_LOOP`)

## 1. Purpose & Context

`HARNESS_LOOP` is the meta-loop used to audit, evolve, and refine the harness itself—the rules, coding guidelines, lessons, hooks, and loop procedures that govern how agents plan, build, review, verify, and learn in this repository.

Whereas `SPEC_LOOP`, `PLAN_LOOP`, `IMPL_LOOP`, and `ERGONOMICS_LOOP` treat the harness as fixed law and optimize the product artifacts, `HARNESS_LOOP` treats the harness files as the system under test: it evaluates how effectively the harness shapes agent behavior, autonomy, defect detection, and token/round economics, and refines the harness against empirical evidence and first-principles critique.

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
  "docs/ERGONOMICS_LOOP.md",
  "docs/HARNESS_LOOP.md",
  "package.json",
  "eslint.config.mjs",
  ".agents/hooks.json",
  ".agents/hooks/post-compaction.mjs"
]
compaction_glob            := ".memory/post-compaction*.md" (includes `.memory/post-compaction.md`, `.memory/post-compaction-<role>.md`, and session-scoped `.memory/post-compaction-<sessionId>.md` overrides)
baseline_dirty             := pre-existing dirty/untracked paths outside harness_files (excluding compaction_glob) recorded via `git status --porcelain` before STEP 1 starts
baseline_evidence          := Empirical telemetry and outcomes from prior loop executions (when available in `git log`, `docs/lessons/*.md`, and any prior loop rulings/reports):
  - Rounds to convergence per milestone/loop
  - Admitted findings ($verified_findings) vs. rejected reviewer findings (false positives)
  - Escaped defects discovered in downstream waves or by the Owner
  - Subagent context token consumption, compactions, and stream timeouts
  - Builder escalations (valid vs. unnecessary permission-seeking)
  - Distilled lessons in `docs/lessons/*.md`
round                      := 1
$verified_changes          := []
$pending_adjacent_defects  := []
round_history              := [] (each completed round's verified changes and rejected false-positive patterns)
pre_remediation_sha        := "" (captured via git rev-parse HEAD when transitioning from STEP 2 to STEP 3)
```

**Entry Preconditions:**
1. No other `docs/**/*_LOOP.md` is currently active on `harness_files`.
2. `git status --porcelain -- <harness_files> docs/lessons/` is empty (zero pre-existing dirty or untracked files in `harness_files` or `docs/lessons/` so STEP 3 and DISTILLATION never stage uncommitted work-in-progress), and `baseline_dirty` (excluding `compaction_glob`) is recorded before STEP 1 starts.

---

## 3. Role Bootstrap Manifests & Loading Guarantee

Every agent in any loop must load its role manifest as its first action before inspecting task files:

| Role | Required Bootstrap Files |
| :--- | :--- |
| **Head** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/HEAD.md`, `docs/lessons/GENERAL.md`, `docs/lessons/HEAD.md`, `docs/SPEC.md`, and the single active `docs/*_LOOP.md` (plus `docs/ERGONOMICS_RULINGS.md` if present when running `ERGONOMICS_LOOP`) |
| **Builder / Remediator** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/BUILDER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/BUILDER.md`, `docs/CODING_GUIDELINES.md` |
| **Reviewer** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/REVIEWER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/REVIEWER.md`, `docs/CODING_GUIDELINES.md` |
| **Consumer-Persona (`loop-persona`, `ERGONOMICS_LOOP` Lens D)** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `README.md` |
| **Verifier** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/VERIFIER.md`, `docs/lessons/GENERAL.md`, `docs/lessons/VERIFIER.md`, `docs/CODING_GUIDELINES.md` |
| **Distiller** | `CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/DISTILLER.md`, `docs/rules/{HEAD,BUILDER,REVIEWER,VERIFIER}.md`, `docs/lessons/GENERAL.md`, `docs/lessons/{HEAD,BUILDER,REVIEWER,VERIFIER}.md`, `docs/CODING_GUIDELINES.md` |

**Subagent Registration (`define_subagent`):**
At loop initialization, Head defines role-specific subagent types (`loop-reviewer`, `loop-persona` when running `ERGONOMICS_LOOP`, `loop-verifier`, `loop-builder`, `loop-distiller`) whose system prompt mandates reading the exact bootstrap manifest for that role as Turn 1 before reading or acting on task files.

---

## 4. Hard Invariants (Non-Negotiable Boundaries)

No evolution round may weaken or violate these invariants:

1. **Owner Authority & Disclosure (`RULE[user_global]`):** The Owner decides product, design, legal, platform, stack, money, data, and anything irreversible. Every verified architectural, design, or normative harness change is disclosed to the Owner.
2. **Separation of Powers:** An agent that mutates files never serves as the sole verifier of its own mutations. Cold review and falsification-based verification run in independent contexts.
3. **Separation of Artifact Concerns:**
   - `docs/CODING_GUIDELINES.md` contains code/test standards and `DON'T` / `DO` examples (with JSDoc examples confined strictly to §2).
   - `docs/rules/*.md` contains atomic behavioral rules (`1–3` lines each), split into `GENERAL.md` and role-specific files.
   - `docs/lessons/*.md` contains atomic, cold, present-tense empirical nuances (`1–3` lines each, `- **[<scope-or-symbol-anchor>]** Do X when Y, because Z.`), split into `GENERAL.md` and role-specific files; genuine atomic lessons are never merged with unrelated lessons into hybrid prose, promoted lessons are retired immediately once their promotion into `CLAUDE.MD`, `docs/CODING_GUIDELINES.md`, or `docs/rules/*.md` is present in the repo (or when their `[<scope-or-symbol-anchor>]` no longer exists), and nominal file size (~25 entries) serves strictly as a soft trigger for Distiller to flag mature promotion candidates for `HARNESS_LOOP` (`docs/rules/DISTILLER.md` Rule 4).
   - `docs/*_LOOP.md` contains pure loop procedure and state machines—never coding opinions.
4. **Zero Steering / Zero Confirmation Bias:** Prompts to Reviewers and Verifiers in any loop must state the scope, context, invariants, and objective evaluation criteria—never leading questions, pre-supposed conclusions, or desired answers that bias the agent toward confirming existing text.
5. **Head Context Protection:** Head never reads bulk repository source files into its own context; full-file reads happen inside subagent contexts.

---

## 5. Evaluation Criteria (Fitness Dimensions)

Harness changes are evaluated against five objective dimensions:

1. **Autonomy, Evidence-Based Spine & Escalation Wisdom:** Do the rules cultivate agents that act autonomously inside their mandate without permission-seeking, suggest out-of-scope improvements with trade-offs without adopting them unilaterally, hold an evidence-based spine across active discussion without manufacturing fake concessions, and escalate strictly when an undecided call requires Owner/Head authority (`CLAUDE.MD` #6, `docs/rules/GENERAL.md` Rules 2–3)?
2. **Defect Catch Rate vs. False-Positive Churn:** Does the harness catch real semantic, architectural, concurrency, performance, and structural defects early, without causing Reviewers and Verifiers to waste rounds on false alarms, rigid bureaucratic friction, or subjective style debates?
3. **Signal-to-Token Density:** Every line in a bootstrap file is paid on every turn of every session that loads it. Does every line earn its token cost by changing behavior or preventing a real failure mode, with zero duplication across `CLAUDE.MD`, `CODING_GUIDELINES.md`, `rules/*.md`, `lessons/*.md`, and `*_LOOP.md`?
4. **Cross-Artifact Consistency:** Are all file paths, role manifests, gate commands, and termination conditions consistent across all harness files?
5. **Lesson Promotion & Immediate Post-Promotion Retirement:** Do `docs/lessons/*.md` entries stay separate, cold, and anchored (`- **[<scope-or-symbol-anchor>]**`) with immediate retirement once promoted into `CLAUDE.MD`, `docs/CODING_GUIDELINES.md`, or `docs/rules/*.md` (or when their anchor no longer exists) and ~25-entry promotion flagging per §4.3 and `docs/rules/DISTILLER.md` Rule 4?

---

## 6. Evolution Loop Procedure

```
POST-COMPACTION GROUNDING (Triggered automatically by `.agents/hooks/post-compaction.mjs` on `PreInvocation` / `Stop` after any `CHECKPOINT` compaction in `transcript.jsonl`)
1. `.agents/hooks/post-compaction.mjs` injects `.memory/post-compaction.md` (or `.memory/post-compaction-<role>.md`) if present, or generates and saves the role's sequential grounding note automatically.
2. When `POST_COMPACTION_GROUNDING_REQUIRED` is injected, read every listed file in exact sequence, one by one, each one fully, before taking any other action.

LOOP:
    STEP 1 — UNSTEERED FIRST-PRINCIPLES CRITIQUE (4x `invoke_subagent`, TypeName: 'loop-reviewer', Model: 'inherit')
        1.1 Launch 4 parallel cold Critic Subagents. Pass each Critic:
            - Its required Reviewer bootstrap manifest (§3) to read as Turn 1,
            - Per `docs/rules/REVIEWER.md` Rule 1: in Round 1, inspect `git diff --stat origin/main...HEAD` and `git diff origin/main...HEAD` and read the remaining files in `harness_files` (§2) not already loaded in Turn 1 in full; in Round $r \ge 2$, inspect `git diff <pre_remediation_sha>..HEAD` and `git diff origin/main...HEAD` and read the files in `harness_files` touched by the remediation commits (plus their direct dependents) in full,
            - The `baseline_evidence` summary (§2),
            - The Hard Invariants (§4) and Evaluation Criteria (§5),
            - Zero leading hints or pre-selected targets.
            Assign each Critic an independent analytical perspective:
            - Critic A (Agent Autonomy, Spine, Incentives & Behavioral Failure Modes): Analyze how each role (`Head`, `Builder`, `Reviewer`, `Verifier`, `Distiller`) will actually behave under these rules and loops—where instructions create ambiguity, paralysis, over-escalation, sycophancy/fake concessions, blind compliance, role confusion, or incentive to cut corners.
            - Critic B (Context Economics & Signal-to-Token Density): Analyze token cost per turn across roles, cross-file redundancy, over-verbose rules or examples, and lessons that should be promoted or pruned.
            - Critic C (Loop Topology, Escape Hatches & Verification Rigor): Analyze the state machines in `SPEC_LOOP`, `PLAN_LOOP`, `IMPL_LOOP`, `ERGONOMICS_LOOP`, and `HARNESS_LOOP` for deadlock states, unverified handoffs, defect escape paths, or false-positive amplification.
            - Critic D (First-Principles Harness Architecture & Design Critique): Challenge the design and architecture of the harness mechanisms, role interactions, coding guidelines, and loop protocols from first principles—identifying where any current mechanism, rule, or guideline is structurally flawed, counterproductive, overly rigid, or over-engineered relative to §5 (subject to the Hard Invariants in §4).
        1.2 Wait for all 4 Critics to complete and collect/deduplicate all raw critiques and proposals, merging and draining `$pending_adjacent_defects` into `$candidates`.

    STEP 2 — FALSIFICATION & VERIFICATION GATE (`invoke_subagent`, TypeName: 'loop-verifier', Model: 'inherit')
        2.1 If count($candidates) == 0:
            - Set `$verified_changes := []` and exit loop to DISTILLATION.
        2.2 Launch 1 Verifier Subagent with its Verifier bootstrap manifest (§3), `harness_files`, `baseline_evidence`, and `$candidates` (plus `round_history` and `pre_remediation_sha` when `round > 1`):
            - Read its Verifier bootstrap manifest (§3) as Turn 1, then read the remaining implicated files in `harness_files` (§2) not already loaded in Turn 1 in full (plus `git diff <pre_remediation_sha>..HEAD` when `round > 1`) and attempt to falsify each candidate in `$candidates` against the exact lines of `harness_files`, the Hard Invariants (§4), and the Evaluation Criteria (§5) per `docs/rules/VERIFIER.md`.
            - ADMISSION GATE (Admit to `$verified_changes` IF AND ONLY IF at least one holds):
              (a) Eliminates a proven contradiction, ambiguity, deadlock, or defect escape path across `harness_files`.
              (b) Removes cross-file duplication or token bloat while preserving or increasing behavioral precision.
              (c) Resolves an empirical failure mode, false-positive cluster, or autonomy bottleneck demonstrated in `baseline_evidence` or `docs/lessons/*.md`.
              (d) Corrects a genuine architectural or design flaw in the harness mechanisms, role boundaries, or coding guidelines with concrete proof that the proposed change dominates the current design on §5 without violating §4.
            - REJECTION GATE (Reject from `$verified_changes` if any holds):
              (x) Violates any Hard Invariant in §4.
              (y) Factually false upon inspecting the exact lines of `harness_files` (or contradicts a prior settled ruling / re-flags a previously falsified claim in `round_history` when the target lines are unchanged).
              (z) Cosmetic rewording, speculative ceremony, or net token increase that changes no observable agent decision or outcome.
            - For each admitted item, Verifier outputs:
              (1) Exact file + line numbers and quoted snippet,
              (2) Concrete proof of the flaw or improvement along the §5 dimensions,
              (3) Surgical formulation(s) (`Option A`, and `Option B` when genuine trade-offs exist per `docs/rules/VERIFIER.md` Rule 3), and
              (4) Verifier's recommended pick and why.
        2.3 Head arbitrates the Verifier's recommendations against §4 and §5 (checking `round_history` per `docs/rules/HEAD.md` Rule 1, disclosing any normative or structural harness change to Owner, and pausing for Owner ruling if a change alters Owner-decided policy), locks in `$verified_changes`, and records the round's verified changes and rejected false-positive patterns in `round_history`.
        2.4 If count($verified_changes) == 0:
            - Exit loop to DISTILLATION.

    STEP 3 — SURGICAL HARNESS MUTATION (`invoke_subagent`, TypeName: 'loop-builder', Model: 'inherit')
        3.1 Record `pre_remediation_sha := $(git rev-parse HEAD)` and launch 1 Harness Builder Subagent with its Builder bootstrap manifest (§3), `baseline_dirty`, and `$verified_changes`:
            - Read its Builder bootstrap manifest (§3) as Turn 1, then read all remaining implicated files in `harness_files` not already loaded in Turn 1 in full.
            - Apply `$verified_changes` surgically across `harness_files` (pausing mid-turn via `send_message` only on a direct `SPEC_CONTRADICTION` or `UNAPPROVED_DEPENDENCY` per `docs/rules/BUILDER.md` Rule 2).
            - Run smoke and lint verification checks (`pnpm lint`, `node --check .agents/hooks/post-compaction.mjs`, `node --check eslint.config.mjs`, JSON syntax validation of `package.json` and `.agents/hooks.json`, `echo '{}' | node .agents/hooks/post-compaction.mjs`, and a mock `CHECKPOINT` transcript smoke test verifying `POST_COMPACTION_GROUNDING_REQUIRED` is emitted on `stdout` with exit code `0`) until exit code `0`, self-audit cross-file references, role manifests, and `git diff` to ensure zero unintended edits or broken links, commit the mutated harness files locally via `lockf -k -t 30 .git/harness-commit.lock sh -c "git add -- <mutated_harness_files> && git commit -m 'harness: remediate round <round>' -- <mutated_harness_files>"` (never running `git push` per `docs/rules/BUILDER.md` Rule 6), and record any unrelated adjacent defects in `disclosed_adjacent_defects` (which Head appends to `$pending_adjacent_defects` for the next round's Step 1.2).
        3.2 Increment `round := round + 1` and repeat LOOP at STEP 1.

DISTILLATION (When `round > 1` or when verified changes / false-positive clusters occurred)
1. Launch 1 Distiller Subagent (`invoke_subagent`, TypeName: 'loop-distiller', Model: 'inherit') with its Distiller bootstrap manifest (§3) and `round_history` (all `$verified_changes` and rejected false-positive patterns across completed rounds `1..round`).
2. Distiller reads its Turn-1 manifest (§3), updates `docs/lessons/{GENERAL,HEAD,BUILDER,REVIEWER,VERIFIER}.md` in-place per `docs/rules/DISTILLER.md` Rules 1–4 (`NO_LESSONS_ADDED` with zero file edits is the expected output when all findings were already covered by existing rules/guidelines), and commits any modified `docs/lessons/*.md` files locally (never running `git push`). Head audits `git diff origin/main...HEAD -- docs/lessons/` against `docs/rules/DISTILLER.md` Rules 1–4 before TERMINATION.

TERMINATION (count($verified_changes) == 0)
1. Verify `git status --porcelain -- <harness_files> docs/lessons/` is empty and `git status --porcelain` outside `harness_files` and `docs/lessons/` (excluding `compaction_glob`) matches `baseline_dirty` (reporting any difference outside `harness_files` to the Owner without reverting).
2. If any commits were made during STEP 3 or DISTILLATION, present the final `git diff --stat origin/main...HEAD` and `git diff origin/main...HEAD` to the Owner for pre-push sign-off (`§4.1`); once confirmed, Head executes `git push origin main` (`docs/rules/HEAD.md` Rule 5).
```
