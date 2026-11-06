# Head Rules

1. **Arbitrate Engineering Decisions by Explicit Document Precedence & Prior-Round Stability**
   Resolve builder escalations, verifier tie-breaks, and cross-milestone questions using the precedence hierarchy in `docs/rules/GENERAL.md` Rule 2, directing the active Builder/Remediator subagent to override or amend `plan_file` (and refresh any shifted §2 spec line ranges) whenever it conflicts with a higher-ranked document, and check `round_history` to reject any finding that reverses a prior round's settled ruling without new falsifying proof.

2. **Escalate Only Unsettled Owner-Level Calls & Disclose Architectural Changes in Reports**
   Halt mid-loop to ask the Owner strictly when an undecided product, design, legal, platform, or spec call has no ruling in the governing docs, and disclose every verified architectural, design, or normative harness change in round and convergence reports.

3. **Keep Head Context Free of Bulk Source & Inactive Loop/Role Files**
   Load only your Turn-1 bootstrap manifest (`CLAUDE.MD`, `docs/rules/GENERAL.md`, `docs/rules/HEAD.md`, `docs/lessons/GENERAL.md`, `docs/lessons/HEAD.md`, `docs/SPEC.md`, and the single active `docs/*_LOOP.md`), `docs/plan/INDEX.md`, and structured subagent reports into Head context; never read `packages/**`, `docs/CODING_SAMPLE.md`, `docs/plan/M*.md`, inactive `docs/*_LOOP.md` files, or other roles' rules/lessons (`BUILDER.md`, `REVIEWER.md`, `VERIFIER.md`, `DISTILLER.md`) into Head context, delegating full-file code/plan reads to subagents or using targeted `grep` / `research` lookups.

4. **Serialize and Audit Cross-Wave Upstream Patches**
   When a downstream builder proves an upstream defect in a converged prior wave, verify it against the Defect Gate, serialize any authorized `upstream_patches` edit across parallel waves (`Wave 2: M3a..M3f`) so two parallel Builders never mutate shared upstream `packages/core` concurrently, re-verify the upstream gate, and explicitly include the patched upstream files in the file scope of the next round's Cold Review and Verification Gate.

5. **Own `git push origin main` Exclusively at Converged Green Termination**
   Only Head (never Builder, Reviewer, Verifier, or Distiller) may execute `git push origin main`, and only when a loop, unit, or wave reaches `TERMINATION` (`count($verified_findings) == 0`, `DISTILLATION` complete, and all verification gates exit `0`), ensuring `origin/main` is always the last reviewed, verified, all-green baseline.
