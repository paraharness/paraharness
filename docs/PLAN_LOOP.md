STATE
docs                       := ["docs/SPEC.md", "docs/CODING_SAMPLE.md", "docs/CODING_GUIDELINES.md"]
plan_files                 := [
  "docs/plan/INDEX.md",
  "docs/plan/M1-core-contracts.md",
  "docs/plan/M2-core-runtime.md",
  "docs/plan/M3a-sqlite.md",
  "docs/plan/M3b-fs-markdown.md",
  "docs/plan/M3c-node.md",
  "docs/plan/M3d-git.md",
  "docs/plan/M3e-drivers.md",
  "docs/plan/M3f-connectors.md",
  "docs/plan/M4-integration.md"
]
round                      := 1
$verified_findings         := []
$pending_adjacent_defects  := []
round_history              := [] (each completed round's verified findings and rejected false-positive patterns)

POST-COMPACTION GROUNDING (Triggered automatically by `.agents/hooks/post-compaction.mjs` on `PreInvocation` / `Stop` after any `CHECKPOINT` compaction in `transcript.jsonl`)
1. `.agents/hooks/post-compaction.mjs` injects `.memory/post-compaction.md` (or `.memory/post-compaction-<role>.md`) if present, or generates and saves the role's sequential grounding note automatically.
2. When `POST_COMPACTION_GROUNDING_REQUIRED` is injected, read every listed file in exact sequence, one by one, each one fully, before taking any other action.

```
    STEP 0 — INITIAL PLAN AUTHORING (`invoke_subagent`, TypeName: 'loop-builder', Model: 'inherit')
        0.1 Launch 1 Plan Creator Subagent:
            - Read its Builder bootstrap manifest (`docs/HARNESS_LOOP.md` §3, which includes `CLAUDE.MD` and `docs/CODING_GUIDELINES.md`) as Turn 1, then read `docs/SPEC.md` and `docs/CODING_SAMPLE.md` completely, in sequence.
            - Inspect existing workspace configuration (`package.json`, `tsconfig.base.json`, `vitest.config.ts`).
            - Create `docs/plan/INDEX.md` and `docs/plan/M1-core-contracts.md` through `docs/plan/M4-integration.md` following the `(b) -> (c)` builder topology (pausing mid-turn via `send_message` only on a direct `SPEC_CONTRADICTION` per `docs/rules/BUILDER.md` Rule 2):
              * Sequential Core Spine (b): `M1` (`@harness-dsl/core` ports, schemas, ASTs & fluent builders) -> `M2` (`@harness-dsl/core` runtime state machine), partitioning `packages/core/src/**` by subdirectory (`M1` owning core contracts/AST/ports/schemas/builders and `packages/core/src/index.ts`, and `M2` owning `packages/core/src/runtime/**`, `packages/core/src/runtime/index.ts`, plus planned runtime re-exports in `packages/core/src/index.ts`).
              * Parallel Adapter Fan-Out (c): `M3a` (`sqlite` + `postgres`), `M3b` (`fs` + `markdown`), `M3c` (`node`), `M3d` (`git`), `M3e` (`claude` + `openai` + `gemini`), `M3f` (`github` + `slack`) — zero cross-adapter imports, depending strictly on `@harness-dsl/core` from `M1`.
              * End-to-End Integration (b): `M4` (compile & test `SPEC.md` §5 and `CODING_SAMPLE.md` §6 `engineering-harness.ts` plus end-to-end protocol tests).
            - Decompose every milestone's planned files per `docs/CODING_GUIDELINES.md` §1 & §6.
            - Each `M*.md` file must be self-contained for its builder: exact package paths, owned/forbidden directories, planned module decomposition and public exports, exact `SPEC.md` / `CODING_SAMPLE.md` line ranges to read, implementation requirements, concrete test cases, and CLI verification gate commands (package `lint`, `typecheck`, and `vitest run --reporter=verbose`).
            - Commit the authored plan files locally via `lockf -k -t 30 .git/harness-commit.lock sh -c "git add -- docs/plan && git commit -m 'plan: initial milestone plans (step 0)' -- docs/plan"` (never running `git push` per `docs/rules/BUILDER.md` Rule 6).

    LOOP:
        STEP 1 — ADVERSARIAL COLD PLAN REVIEW (3x `invoke_subagent`, TypeName: 'loop-reviewer', Model: 'inherit')
            1.1 Launch 3 parallel cold Plan Reviewer Subagents, each required to read its Reviewer bootstrap manifest (`docs/HARNESS_LOOP.md` §3, including `docs/CODING_GUIDELINES.md`) as Turn 1, then audit `docs/plan/*.md` against `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, and workspace configuration (`package.json`, `tsconfig.base.json`, `vitest.config.ts`) per `docs/rules/REVIEWER.md` Rule 1 (in Round 1, inspecting `git diff origin/main...HEAD -- docs/plan` and reading all `docs/plan/*.md` files in full; in Round $r \ge 2$, inspecting `git diff HEAD~1..HEAD -- docs/plan` and `git diff origin/main...HEAD -- docs/plan` plus the touched plan files):
              - Lens A (100% Spec, Line-Range & Symbol Coverage): Every port interface, method, parameter, Zod schema, builder chain, state-machine transition, and edge case in `SPEC.md` and `CODING_SAMPLE.md` is mapped to a specific milestone and target file with zero dropped requirements or signature mismatches, and every `M*.md` §2 `SPEC.md` and `CODING_SAMPLE.md` line range is exact and covers 100% of the spec sections governing that milestone.
              - Lens B (`(b) -> (c)` Boundary & Parallelism Safety): `M1` exports 100% of `@harness-dsl/core` contracts required by `M2` and `M3a..M3f` (with `M1 -> M2` partitioning `packages/core/src/**` by subdirectory so `M1` owns core contracts/AST/ports/schemas/builders and `packages/core/src/index.ts`, while `M2` owns `packages/core/src/runtime/**`, `packages/core/src/runtime/index.ts`, plus planned runtime re-exports in `packages/core/src/index.ts`); `M3a..M3f` touch strictly disjoint directories with zero cross-adapter dependencies or file collisions; `INDEX.md` DAG and workspace config match all `M*.md` files.
              - Lens C (Verification Gates, Test Completeness & Coding Guidelines Compliance): Every milestone specifies concrete, deterministic unit/integration tests covering all failure/crash/concurrency/wire invariants in its scope, executable CLI verification commands (`pnpm lint`, `tsc --noEmit`, `vitest run --reporter=verbose`), and adheres to `CLAUDE.MD` and `docs/CODING_GUIDELINES.md`.
            1.2 Wait for all 3 Reviewer Subagents to complete and collect/deduplicate their raw outputs, merging and draining `$pending_adjacent_defects` into `$findings`.

        STEP 2 — VERIFICATION GATE & HEAD ARBITRATION (`invoke_subagent`, TypeName: 'loop-verifier', Model: 'inherit')
            2.1 If count($findings) == 0:
                - Set `$verified_findings := []` and exit loop to DISTILLATION.
            2.2 Launch 1 Verifier Subagent with `$findings`:
                - Require it to read its Verifier bootstrap manifest (`docs/HARNESS_LOOP.md` §3) as Turn 1, then read `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, workspace configuration (`package.json`, `tsconfig.base.json`, `vitest.config.ts`), and the implicated `docs/plan/*.md` files to verify every candidate in `$findings`.
                - DEFECT GATE (Admit to `$verified_findings` IF AND ONLY IF at least one holds):
                  (a) Missing symbol, method, builder option, schema, or runtime invariant from `SPEC.md` or `CODING_SAMPLE.md`.
                  (b) Signature, type, or behavioral mismatch between a plan file and `SPEC.md` / `CODING_SAMPLE.md`.
                  (c) Broken `(b) -> (c)` boundary (missing `M1` export needed by `M3*`, cross-adapter coupling, or shared-file write collision between parallel builders).
                  (d) Missing or non-deterministic test coverage / verification gate (`lint`, `typecheck`, `vitest run`) for a critical invariant.
                  (e) Violation of `docs/CODING_GUIDELINES.md`, stale or incomplete `SPEC.md` / `CODING_SAMPLE.md` §2 line-range references, or cross-plan contradictions.
                - REJECTION GATE (Reject from `$verified_findings` if any holds):
                  (x) Factually false (already covered in the plan files).
                  (y) Speculative feature not in `SPEC.md` or `CODING_SAMPLE.md`.
                  (z) Stylistic formatting preference that alters no builder behavior.
                - For each admitted item, Verifier outputs:
                  (1) Exact plan file + line numbers and quoted snippet,
                  (2) Concrete proof of the gap or mismatch against `SPEC.md` / `CODING_SAMPLE.md` / `CODING_GUIDELINES.md`,
                  (3) Surgical fix options (`Option A`, and `Option B` when genuine trade-offs exist per `docs/rules/VERIFIER.md` Rule 3), and
                  (4) Verifier's recommended fix and why.
            2.3 Head arbitrates / tie-breaks the Verifier's recommendations against `RULE[user_global]` and `docs/rules/HEAD.md` Rule 1 (checking `round_history`), locks in the winning fixes as `$verified_findings`, and records the round's verified findings and rejected false-positive patterns in `round_history`.
            2.4 If count($verified_findings) == 0:
                - Exit loop to DISTILLATION.

        STEP 3 — PLAN REMEDIATION (`invoke_subagent`, TypeName: 'loop-builder', Model: 'inherit')
            3.1 Launch 1 Plan Remediation Subagent with `$verified_findings`:
                - Read its Builder bootstrap manifest (`docs/HARNESS_LOOP.md` §3) as Turn 1, then read `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, `docs/plan/INDEX.md`, and all implicated or cascade-affected `docs/plan/M*.md` files in sequence.
                - Apply every fix in `$verified_findings` (plus direct in-scope cascade updates) surgically across `docs/plan/*.md` (pausing mid-turn via `send_message` only on a direct `SPEC_CONTRADICTION` per `docs/rules/BUILDER.md` Rule 2).
                - Rule A (Self-Review & Local Commit): Verify no edit breaks cross-plan consistency, symbol exports, or milestone boundaries (using `grep` across remaining `docs/plan/M*.md` files to verify cross-plan symbol consistency), and commit the remediated plan files locally via `lockf -k -t 30 .git/harness-commit.lock sh -c "git add -- docs/plan && git commit -m 'plan: remediate round <round>' -- docs/plan"` (never running `git push` per `docs/rules/BUILDER.md` Rule 6).
                - Rule B (Disclosed Adjacent Defects): Record any unrelated adjacent plan defects discovered during remediation in a `disclosed_adjacent_defects` section of the completion report (which Head appends to `$pending_adjacent_defects` for the next round's Step 1.2).
            3.2 Increment `round := round + 1` and repeat LOOP at STEP 1.

    DISTILLATION (When `round > 1` or when verified findings / false-positive clusters occurred)
    1. Launch 1 Distiller Subagent (`invoke_subagent`, TypeName: 'loop-distiller', Model: 'inherit') with its Distiller bootstrap manifest (`docs/HARNESS_LOOP.md` §3) and `round_history` (all verified findings and rejected false-positive patterns across rounds `1..round`).
    2. Distiller reads its Turn-1 manifest, updates `docs/lessons/{GENERAL,HEAD,BUILDER,REVIEWER,VERIFIER}.md` in-place per `docs/rules/DISTILLER.md` (`NO_LESSONS_ADDED` with zero file edits is the expected output when all findings were already covered by existing rules/guidelines), and commits any modified `docs/lessons/*.md` files locally (never running `git push`). Head audits `git diff origin/main...HEAD -- docs/lessons/` against `docs/rules/DISTILLER.md` Rules 1–4 before TERMINATION.

    TERMINATION (count($verified_findings) == 0)
    Head executes `git push origin main` (`docs/rules/HEAD.md` Rule 5), reads `docs/plan/INDEX.md`, and presents the converged plan summary and milestone links to Owner for execution sign-off.
```
