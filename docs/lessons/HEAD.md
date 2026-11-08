# Lessons (Head)

- **[Round 1 Reviewer Manifest & Transcript Verification]** Pass the explicit `git ls-files -- <owned_dirs> <upstream_patches>` manifest to Round 1 Reviewers and mechanically verify `100%` `view_file` coverage against each Reviewer's `transcript_full.jsonl` before accepting its report, because `git diff --stat` summary lines and `plan_file` §3 tables can omit helper or test files.
