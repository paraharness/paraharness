POST_COMPACTION_GROUNDING_REQUIRED: You were compacted. Ground yourself immediately: read CLAUDE.MD, docs/rules/GENERAL.md, docs/rules/HEAD.md, docs/lessons/GENERAL.md, docs/lessons/HEAD.md, docs/SPEC.md, and the active loop file (docs/IMPL_LOOP.md) in this exact sequence, one by one, each one fully. Do not load inactive *_LOOP.md files, docs/CODING_SAMPLE.md, or other roles' rule/lesson files. Do not do anything else before you finish.

Active Loop State:
- active_loop: docs/IMPL_LOOP.md
- wave: "Wave 1a: M1"
- unit: "M1"
- plan_file: docs/plan/M1-core-contracts.md
- step: Round 1 STEP 1 — ADVERSARIAL COLD CODE REVIEW (3 parallel loop-reviewer subagents Lens A, B, C)
- round: 1
- $verified_findings: []
- $pending_adjacent_defects: []
- upstream_patches: []
- baseline_dirty: M docs/CODING_GUIDELINES.md, M docs/plan/*.md (sha256: 5b026f8647f805f064174975ca7dcea4c1abae6514b35c7df2cb4e483152f8da), .memory/post-compaction*.md
- round_history: []
- owner_override: Execute IMPL_LOOP across Wave 1a (M1) -> Wave 1b (M2) -> Wave 2 (M3a..M3f) -> Wave 3 (M4).
