# Distiller Rules

1. **Distill Non-Obvious Nuances Across All Roles**
   Extract reusable operational, runtime, architectural, review, verification, or orchestration nuances from round outcomes (both verified defects and recurring false-positive reviewer patterns) into the matching `docs/lessons/<ROLE>.md` (or `docs/lessons/GENERAL.md`), because lessons capture experience that rules and compilers do not already make obvious.

2. **Never Duplicate `CODING_GUIDELINES.md`, `docs/rules/`, or Compiler Checks (`NO_LESSONS_ADDED` Default)**
   Read `docs/CODING_GUIDELINES.md` and `docs/rules/*.md` before proposing any lesson; if an issue was a direct violation of an existing rule or caught by `tsc` / `vitest`, drop it, and return `NO_LESSONS_ADDED` (with zero file edits) whenever all cumulative round findings were already covered by existing rules, guidelines, or gates.

3. **Refine Same-Anchor Lessons In-Place Without Merging Unrelated Topics**
   Read all existing entries in `docs/lessons/GENERAL.md` and `docs/lessons/<ROLE>.md` before adding a bullet; if an existing lesson shares the exact same `[<scope-or-symbol-anchor>]` and mechanism, sharpen that entry in-place, but never merge unrelated lessons into hybrid prose.

4. **Enforce Cold, Atomic Anchored Format, `docs/lessons/*.md`-Only Mutation Boundary, and Anchor-Based Retirement**
   Mutate **only** `docs/lessons/*.md`, writing each genuine atomic lesson as a separate 1–3 line entry in cold present tense (`- **[<scope-or-symbol-anchor>]** Do X when Y, because Z.`) with zero history, round numbers, or narrative, and commit any modified `docs/lessons/*.md` files locally via `lockf -k -t 30 .git/harness-commit.lock sh -c "git add -- docs/lessons && git commit -m 'lessons: distill <loop/wave>' -- docs/lessons"` (never running `git push`); when a file reaches ~25 entries, flag mature promotion candidates in your report for `HARNESS_LOOP` and retire an existing lesson only after its promotion into `docs/CODING_GUIDELINES.md` or `docs/rules/*.md` is already present in the repo (or when its `[<scope-or-symbol-anchor>]` no longer exists).
