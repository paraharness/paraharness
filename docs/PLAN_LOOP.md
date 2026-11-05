STATE
docs               := ["docs/SPEC.md", "docs/CODING_SAMPLE.md"]
plan_files         := [
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
round              := 1
$verified_findings := []
context_tokens     := input_tokens + cache_read_tokens + output_tokens (from latest PLANNER_RESPONSE in transcript.jsonl)

HOOK (PreInvocation in .agents/hooks.json)
On every turn before model invocation:
Read latest PLANNER_RESPONSE token sum from stdin.transcriptPath.
If context_tokens >= 700_000:
Inject high-priority systemMessage: "CONTEXT_THRESHOLD_700K_REACHED".

PRE-COMPACTION HANDOFF (Triggered immediately when context_tokens >= 700_000)
1. Write full loop state (round, $verified_findings, completed rounds, exact instructions) to .memory/head-handoff.md.
2. Spawn fresh Head (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High]) with .memory/head-handoff.md, emit its clickable conversation://<id> link, and retire this session.

HEAD CONTEXT INVARIANT
Head never reads full `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, or all `docs/plan/M*.md` files into its own context during the loop.
Full-document reads happen strictly inside fresh Author, Reviewer, Verifier, and Remediation subagent contexts. Head reads only `docs/plan/INDEX.md` and structured subagent reports.

```
    STEP 0 — INITIAL PLAN AUTHORING (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High])
        0.1 Launch 1 Plan Creator Subagent:
            - Read `docs/SPEC.md` (lines 1..1547) and `docs/CODING_SAMPLE.md` (lines 1..1208) completely, in sequence.
            - Inspect existing workspace configuration (`package.json`, `infra/vitest.config.mts`).
            - Create `docs/plan/INDEX.md` and `docs/plan/M1-core-contracts.md` through `docs/plan/M4-integration.md` following the `(b) -> (c)` builder topology:
              * Sequential Core Spine (b): `M1` (`@harness-dsl/core` ports, schemas, ASTs & fluent builders) -> `M2` (`@harness-dsl/core` runtime state machine).
              * Parallel Adapter Fan-Out (c): `M3a` (`sqlite`), `M3b` (`fs` + `markdown`), `M3c` (`node`), `M3d` (`git`), `M3e` (`claude` + `openai`), `M3f` (`github` + `slack`) — zero cross-adapter imports, depending strictly on `@harness-dsl/core` from `M1`.
              * End-to-End Integration (b): `M4` (compile & test `SPEC.md` §5 and `CODING_SAMPLE.md` §6 `engineering-harness.ts` plus end-to-end protocol tests).
            - Each `M*.md` file must be self-contained for its builder: exact package paths, source files to create, exported symbols/signatures, exact `SPEC.md` / `CODING_SAMPLE.md` line ranges to read, implementation requirements, concrete test cases, and CLI verification gate commands.

    LOOP:
        STEP 1 — ADVERSARIAL COLD PLAN REVIEW (3x `invoke_subagent`, TypeName: 'research', Model: 'inherit' [Argon 4 High])
            1.1 Launch 3 parallel cold Plan Reviewer Subagents, each required to read `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, and all `docs/plan/*.md` files in full before auditing its assigned lens:
              - Lens A (100% Spec & Symbol Coverage): Every port interface, method, parameter, Zod schema, builder chain, state-machine transition, and edge case in `SPEC.md` and `CODING_SAMPLE.md` is mapped to a specific milestone and target file with zero dropped requirements or signature mismatches.
              - Lens B (`(b) -> (c)` Boundary & Parallelism Safety): `M1` exports 100% of `@harness-dsl/core` contracts required by `M2` and `M3a..M3f`; `M3a..M3f` touch strictly disjoint directories with zero cross-adapter dependencies or file collisions; `INDEX.md` DAG and workspace config match all `M*.md` files.
              - Lens C (Verification Gates, Test Completeness & Repo Rules): Every milestone specifies concrete, deterministic unit/integration tests covering all failure/crash/concurrency/wire invariants in its scope, executable CLI verification commands (`tsc --noEmit`, `vitest run`), and adheres to repository rules (`CLAUDE.MD`).
            1.2 Wait for all 3 Reviewer Subagents to complete. Collect and deduplicate their raw outputs into `$findings`.

        STEP 2 — VERIFICATION GATE & HEAD ARBITRATION (`invoke_subagent`, TypeName: 'research', Model: 'inherit' [Argon 4 High])
            2.1 If count($findings) == 0:
                - Set `$verified_findings := []` and exit loop to TERMINATION.
            2.2 Launch 1 Verifier Subagent with `$findings`:
                - Read `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, and the implicated `docs/plan/*.md` files to verify every candidate in `$findings`.
                - DEFECT GATE (Admit to `$verified_findings` IF AND ONLY IF at least one holds):
                  (a) Missing symbol, method, builder option, schema, or runtime invariant from `SPEC.md` or `CODING_SAMPLE.md`.
                  (b) Signature, type, or behavioral mismatch between a plan file and `SPEC.md` / `CODING_SAMPLE.md`.
                  (c) Broken `(b) -> (c)` boundary (missing `M1` export needed by `M3*`, cross-adapter coupling, or shared-file write collision between parallel builders).
                  (d) Missing or non-deterministic test coverage / verification gate for a critical invariant.
                  (e) Stale or inaccurate `SPEC.md` / `CODING_SAMPLE.md` line-range references or cross-plan contradictions.
                - REJECTION GATE (Reject from `$verified_findings` if any holds):
                  (x) Factually false (already covered in the plan files).
                  (y) Speculative feature not in `SPEC.md` or `CODING_SAMPLE.md`.
                  (z) Stylistic formatting preference that alters no builder behavior.
                - For each admitted item, Verifier outputs:
                  (1) Exact plan file + line numbers and quoted snippet,
                  (2) Concrete proof of the gap or mismatch against `SPEC.md` / `CODING_SAMPLE.md`,
                  (3) Alternative surgical fixes (`Option A`, `Option B`) with trade-offs, and
                  (4) Verifier's recommended fix and why.
            2.3 Head arbitrates / tie-breaks the Verifier's recommendations against `RULE[user_global]` and locks in the winning fixes as `$verified_findings`.
            2.4 If count($verified_findings) == 0:
                - Exit loop to TERMINATION.

        STEP 3 — PLAN REMEDIATION (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High])
            3.1 Launch 1 Plan Remediation Subagent with `$verified_findings`:
                - Read `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, and all `docs/plan/*.md` files in sequence.
                - Apply every fix in `$verified_findings` surgically across `docs/plan/*.md`.
                - Rule A (Self-Review): Verify no edit breaks cross-plan consistency, symbol exports, or milestone boundaries.
                - Rule B (No Glossing Over): Disclose any adjacent plan defects discovered during remediation to Head so Head can authorize folding them in via `send_message`.
            3.2 Increment `round := round + 1` and repeat LOOP at STEP 1.

    TERMINATION (count($verified_findings) == 0)
    Read `docs/plan/INDEX.md` and present the converged plan summary and milestone links to Owner for execution sign-off.
```
