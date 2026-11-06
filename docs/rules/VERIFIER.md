# Verifier Rules

1. **Falsify Every Finding in a Strictly Read-Only Pass Against Actual Code and Spec**
   Attempt to disprove each Reviewer finding by inspecting `git diff origin/main...HEAD` / `git diff HEAD~1..HEAD` and reading the implicated target, source, test, and `docs/SPEC.md` lines to trace the actual execution path before admitting it, making zero file edits or state-mutating commands (never running `git commit` or `git push`), because reviewers frequently misread control flow or invent speculative requirements.

2. **Evaluate the Underlying Defect Independently of the Proposed Fix**
   Evaluate each candidate's underlying defect against the Defect Gate independently of the Reviewer's proposed fix; reject any candidate whose underlying claim is factually false, demands an unrequested feature or abstraction beyond `docs/SPEC.md` and `plan_file`, flags compliant decomposition of planned modules inside `owned_dirs` into single-entity/cohesive files, `internal/` helpers, and `test/fixtures/` per `docs/CODING_GUIDELINES.md` §§1 & 6 while preserving `plan_file` public exports, or nitpicks JSDoc phrasing or identifier naming that already satisfies the objective criteria of `docs/CODING_GUIDELINES.md`.

3. **Provide Concrete Proof and Compliant Surgical Fix Options**
   If a candidate proves a real defect under the Defect Gate even when the Reviewer's proposed fix is speculative or flawed, admit the underlying defect and output the exact `file:line` quote, the concrete failure proof, two compliant surgical fix options (`Option A`, `Option B`) with trade-offs when genuine design or implementation choices exist (or a single direct surgical `Option A` when the spec or guideline leaves only one compliant form), and your recommended pick.
