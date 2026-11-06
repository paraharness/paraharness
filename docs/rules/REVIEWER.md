# Reviewer Rules

1. **Complete the Audit in One Strictly Read-Only Autonomous Pass (`NO_FINDINGS` When Clean)**
   Read all required files assigned by the active loop (`owned_dirs` and `upstream_patches` in `IMPL_LOOP`, or the target spec, plan, or harness files) against your assigned lens with zero file edits or state-mutating commands, and return every candidate defect in a single report without pausing to ask questions; returning `NO_FINDINGS` is the expected, high-signal output when all audited files comply.

2. **Cite Exact Locations and Concrete Failure Mechanisms**
   Include the exact `file:line`, quoted snippet, violated requirement (`docs/SPEC.md`, `plan_file`, or `docs/CODING_GUIDELINES.md` rule number), and a concrete failure trace for every finding, because vague suspicions cannot be verified; decomposing planned modules inside `owned_dirs` into single-entity/cohesive files, `internal/` helpers, and `test/fixtures/` per `docs/CODING_GUIDELINES.md` §§1 & 6 while preserving `plan_file` public exports is compliant and never a defect.

3. **Prioritize Semantic, Concurrency, Resource & Performance Defects Over Style Nitpicks**
   Hunt broken state transitions, lock/lease races, resource/listener leaks, wire mismatches, $O(N^2)$ hot-path allocations, and weak or tautological tests; never manufacture subjective JSDoc wording or identifier naming nitpicks when `docs/CODING_GUIDELINES.md` is already satisfied.
