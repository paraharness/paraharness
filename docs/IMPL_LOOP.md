STATE
wave               := W ("Wave 1a: M1" | "Wave 1b: M2" | "Wave 2: M3a..M3f (parallel)" | "Wave 3: M4"; Wave W+1 starts only after all units in Wave W reach TERMINATION)
unit               := U (target milestone unit from docs/plan/INDEX.md: "M1" | "M2" | "M3a" | "M3b" | "M3c" | "M3d" | "M3e" | "M3f" | "M4")
plan_file          := docs/plan/<U>-*.md
owned_dirs         := Owned Files & Directories defined in plan_file §1
forbidden_dirs     := Forbidden Directories defined in plan_file §1
gate_cmd           := Verification Gate Commands defined in plan_file §6
round              := 1
$verified_findings := []
context_tokens     := input_tokens + cache_read_tokens + output_tokens (from latest PLANNER_RESPONSE in transcript.jsonl)

HOOK (PreInvocation in .agents/hooks.json)
On every turn before model invocation:
Read latest PLANNER_RESPONSE token sum from stdin.transcriptPath.
If context_tokens >= 700_000:
Inject high-priority systemMessage: "CONTEXT_THRESHOLD_700K_REACHED".

PRE-COMPACTION HANDOFF (Triggered immediately when context_tokens >= 700_000)
1. Write full loop state (active wave, unit, round, $verified_findings, completed units, exact instructions) to .memory/head-handoff.md.
2. Spawn fresh Head (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High]) with .memory/head-handoff.md, emit its clickable conversation://<id> link, and retire this session.

HEAD CONTEXT INVARIANT
Head never reads full `packages/**`, `docs/SPEC.md`, `docs/CODING_SAMPLE.md`, or `docs/plan/M*.md` files into its own context during the loop.
Full-file reads happen strictly inside fresh Builder, Reviewer, Verifier, and Remediation subagent contexts. Head reads `docs/plan/INDEX.md` and structured subagent reports, and may use `grep` for simple targeted lookups or an explorer subagent (`invoke_subagent`, `TypeName: 'research'`) for more complex scoped retrievals across those and other files.

```
    STEP 0 — INITIAL MILESTONE BUILD (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High])
        0.1 Launch 1 Builder Subagent for `unit`:
            - Read `CLAUDE.MD`, `plan_file` in full, and the grounded `docs/SPEC.md` / `docs/CODING_SAMPLE.md` line ranges listed in `plan_file` §2 in sequence.
            - Author 100% of files specified in `plan_file` §3 (`src/**`) and §5 (`test/**`) strictly inside `owned_dirs`:
              * Write zero comments (`//`, `/* */`, `#`, `<!-- -->`) in any authored file (`CLAUDE.MD` line 20) and zero `.env` reads or import-time side effects (`SPEC.md` §1.2).
              * Write zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` directives, zero unsound `as any` / `as unknown as T` / `: any` erasures, and zero unguarded `!` non-null assertions.
              * Write fast, deterministic, high-signal tests against real local resources (real SQLite/FS/Node/Git, mocking only external HTTP transports) with exact contract assertions and `afterEach` / `try/finally` cleanup—no tautological, weak-assertion, speculative, repetitive, slow, or "make-bugs-pass" tests.
            - If blocked by an upstream contract/runtime defect in a converged prior wave, do not work around it or edit `forbidden_dirs` silently—report the exact defect to Head (`send_message`) for surgical upstream authorization.
            - Execute `gate_cmd` plus `pnpm --filter <pkg> test -- --reporter=verbose` for each package in `owned_dirs` (if `pnpm check:comments` in parallel Wave 2 flags a concurrent sibling `M3y` file outside `owned_dirs`, verify zero comments in `owned_dirs` and re-run once the sibling write settles), and verify `git status --porcelain -- <owned_dirs>` (only planned files) and `git status --porcelain -- <forbidden_dirs>` (zero edits in non-sibling `forbidden_dirs` or frozen prior-wave files) until exit code `0`.
            - Return structured build report: authored file list, exact `gate_cmd` output, verbose per-test timing output, and `git status --porcelain` / `git diff --stat` output.

    LOOP:
        STEP 1 — ADVERSARIAL COLD CODE REVIEW (3x `invoke_subagent`, TypeName: 'research', Model: 'inherit' [Argon 4 High])
            1.1 Launch 3 parallel cold Code Reviewer Subagents (passing the latest `gate_cmd` output, verbose per-test timing output, and `git status --porcelain` / `git diff --stat` output), each required to read `CLAUDE.MD`, `plan_file`, the grounded `SPEC.md` / `CODING_SAMPLE.md` sections, and all `src/**` and `test/**` files in `owned_dirs` in full before auditing its assigned lens:
              - Lens A (Spec & Plan Behavioral Fidelity): Every port interface, method, schema, builder chain, adapter factory, SQL/git/subprocess command, wire-protocol translation, lock order, state-machine transition, and crash-recovery branch in `plan_file` and `SPEC.md` / `CODING_SAMPLE.md` is completely implemented with zero stubbed no-ops, silent fallbacks, hardcoded test-input branches, or omitted edge cases.
              - Lens B (Type Rigor, Concurrency, Resource, Purity & Boundary Safety): Zero `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`, zero unsound `as any` / `as unknown as T` / `: any` type erasures or unguarded `!` non-null assertions, exact generic propagation under `strict: true` and `noUncheckedIndexedAccess: true`, zero import-time side effects or `.env` / secret reads (symbolic `H.env(key)` resolved only at leaf invocation), lock/lease/handle/daemon/subprocess release in `try/finally`, symlink/path-jail enforcement, SQL transaction atomicity, `StaleFenceTokenError` validation, zero unintended edits outside `owned_dirs`, and zero forbidden cross-adapter imports.
              - Lens C (Test Authenticity, Anti-Smell Rigor, Failure-Path Coverage & Repo Rules): Every test scenario in `plan_file` §5 is implemented against real `src/**` behavior and real local SQLite/FS/Node/Git resources (mocking only external HTTP transports); hunt and flag any garbage/tautological/weak-assertion tests (`toBeDefined()` without asserting exact state/wire/receipt contracts, or mocking the unit/adapter under test), "make-bugs-pass" tests (inverted oracle tailored to match buggy `src/**` behavior instead of `SPEC.md` / `plan_file`), speculative tests, repetitive/redundant tests, slow tests (wall-clock `setTimeout` sleeps or heavy setup visible in verbose durations), test smells (over-mocking internals, unawaited `expect(...).rejects`, leaked temp dirs/DBs/daemons without `afterEach` / `try/finally`, shared mutable state across `it()`, swallowed errors, `.skip` / `.todo` / `.only`), and any `CLAUDE.MD` violation (comments `//`, `/* */`, `#`, `<!-- -->` in authored files, non-surgical code).
            1.2 Wait for all 3 Reviewer Subagents to complete. Collect and deduplicate their raw outputs into `$findings`.

        STEP 2 — VERIFICATION GATE & HEAD ARBITRATION (`invoke_subagent`, TypeName: 'research', Model: 'inherit' [Argon 4 High])
            2.1 If count($findings) == 0:
                - Set `$verified_findings := []` and exit loop to TERMINATION.
            2.2 Launch 1 Verifier Subagent with `$findings` (plus the latest `gate_cmd` output, verbose per-test timing output, and `git status --porcelain` / `git diff --stat` output):
                - Read `CLAUDE.MD`, `plan_file`, the grounded `SPEC.md` / `CODING_SAMPLE.md` sections, and the implicated `src/**` and `test/**` files in `owned_dirs` to verify every candidate in `$findings`.
                - DEFECT GATE (Admit to `$verified_findings` IF AND ONLY IF at least one holds):
                  (a) Behavioral, concurrency, lock-ordering, crash-recovery, wire-protocol, git/FS/subprocess, or SQL defect, stubbed/hardcoded branch, or import-time side effect relative to `plan_file`, `SPEC.md`, or `CODING_SAMPLE.md`.
                  (b) Type error, unsound `as any` / `as unknown as T` / `: any` / `@ts-ignore` / `@ts-expect-error` / unguarded `!`, generic erasure, or cross-package contract mismatch.
                  (c) Broken milestone boundary (file modified outside `owned_dirs`, forbidden cross-adapter import, or upstream contract/runtime defect in a prior wave requiring a surgical upstream patch).
                  (d) Missing required test from `plan_file` §5, garbage/tautological/weak-assertion test, mocked local SQLite/FS/Node/Git adapter test, "make-bugs-pass" test encoding buggy behavior, speculative test, repetitive/redundant test, slow/sleep-based test, or test smell (`.skip` / `.todo` / `.only`, unawaited async assertion, leaked temp dir/handle/daemon, over-mocking internals, shared mutable state).
                  (e) Violation of `CLAUDE.MD` (`RULE[user_global]`): comment (`//`, `/* */`, `#`, `<!-- -->`) present in any authored file, `.env` read or secret exposure, speculative production feature, or dead/unused code.
                - REJECTION GATE (Reject from `$verified_findings` if any holds):
                  (x) Factually false upon inspecting the actual `src/**` and `test/**` files.
                  (y) Speculative production feature, extra abstraction, or option not in `plan_file`, `SPEC.md`, or `CODING_SAMPLE.md`.
                  (z) Stylistic code preference that alters no correctness, type safety, test quality, or repo rule compliance.
                - For each admitted item, Verifier outputs:
                  (1) Exact file + line numbers and quoted snippet from `owned_dirs` (and `plan_file` / `SPEC.md`),
                  (2) Concrete failure or test-smell proof,
                  (3) Alternative surgical fixes (`Option A`, `Option B`) with trade-offs, and
                  (4) Verifier's recommended fix and why.
            2.3 Head arbitrates / tie-breaks the Verifier's recommendations against `RULE[user_global]` and locks in the winning fixes as `$verified_findings`.
            2.4 If count($verified_findings) == 0:
                - Exit loop to TERMINATION.

        STEP 3 — TEST-FIRST CODE REMEDIATION (`invoke_subagent`, TypeName: 'self', Model: 'inherit' [Argon 4 High])
            3.1 Launch 1 Code Remediation Subagent with `$verified_findings`:
                - Read `plan_file`, the grounded `SPEC.md` / `CODING_SAMPLE.md` sections, and all implicated files in `owned_dirs` in sequence.
                - Goal-Driven Test-First Rule (`RULE[user_global]` #4): For every behavioral/runtime defect in `$verified_findings`, first write or tighten a failing test in `test/*.test.ts` that reproduces the defect, then apply the surgical fix in `src/*.ts`. For every test-smell defect in `$verified_findings` (garbage, "make-bugs-pass", speculative, repetitive, or slow test), replace, consolidate, or delete the offending test.
                - Rule A (Self-Review & CLI Gate): Verify no edit breaks existing invariants or milestone boundaries, and execute `gate_cmd` (plus the upstream unit's `gate_cmd` and regression test if `$verified_findings` or Rule B includes a Head-authorized upstream patch) with `pnpm --filter <pkg> test -- --reporter=verbose` until exit code `0`.
                - Rule B (No Glossing Over): If fixing an item exposes an adjacent defect (or an upstream contract/runtime defect in a prior wave), DO NOT gloss over it and DO NOT silently improvise—report the exact disclosed defect(s) to Head.
            3.2 While Remediation Subagent reports disclosed adjacent or upstream defects (Rule B):
                - Head evaluates each disclosed defect against the Defect Gate (Step 2.2) (serializing any upstream `packages/core/**` patch across active Wave 2 builders).
                - Head messages the SAME Remediation Subagent (`send_message`) authorizing the exact surgical fix to fold in.
                - Remediation Subagent applies the authorized fix (including a failing-then-passing regression test), re-runs Rule A self-review, `gate_cmd`, and any patched upstream unit's `gate_cmd`, and reports back.
            3.3 Remediation step closes only when Remediation Subagent confirms and returns in its report:
                - All `$verified_findings` and all authorized Rule B disclosures are applied.
                - `gate_cmd` (and any Head-authorized upstream unit's `gate_cmd`) exits `0`, verbose per-test timings (`--reporter=verbose`) are captured, and `git status --porcelain` / `git diff --stat` show zero unintended edits outside `owned_dirs` (and any Head-authorized upstream patch).
            3.4 Increment `round := round + 1` and repeat LOOP at STEP 1.

    TERMINATION (count($verified_findings) == 0)
    Confirm `gate_cmd` exit code `0` and report `unit` convergence summary + `git diff --stat` to Head / Owner.
```
