---
name: lesson
description: Project-specific conventions Peer follows when writing, widening, or removing a lesson in LESSONS.md or lessons/<ROLE>.md.
---

# Lesson Conventions

## When a lesson is written

Write a lesson only after the first two tiers are ruled out:

1. Can a test, type, linter, or script make the mistake impossible? Build or propose that check instead.
2. Did a vague or missing line in a role or doc file cause it? Fix that line instead.
3. Only when neither catches it, write or widen a lesson so every future session reads the check before acting.

When the owner gives a lesson directly (`lesson: ...`), rewrite it into the form below while keeping its point, record it, and show the written line so the owner can veto.

## Form

Every lesson is one present-tense sentence under 500 characters:

```
- <ID>: Do X, because Y.
```

- `X` is the concrete action or check to take.
- `Y` is the mechanism that bites when you skip `X` (never a restatement of `X`).
- Never include a date, a ticket ID, a PR number, a person's name, quotation marks, or an incident story. Use the incident only to test whether the general sentence would have prevented it.
- Good: `- B3: Read the area's architecture doc before changing its code, because its invariants are not visible in the files you touch.`
- Good: `- B4: Stage only the files you wrote before pushing the memory checkout, because a blanket add sweeps other sessions' half-written files into your commit.`
- Bad: `- "After the TIC-037 PR sat two days and conflicted, check Mergify's reply."` (incident and ticket ID)
- Bad: `- "Be careful with merges, since conflicts arise in several ways."` (no concrete action, no mechanism)

## Widen over append

Before adding a lesson, check `LESSONS.md` (shared across all roles) and `lessons/<ROLE>.md`:

- **Same mechanism and action:** If an existing lesson already covers the same mechanism or should have caught the incident, widen that line in place under its existing ID instead of adding a twin beside it.
- **Shared vs. role-specific:** If the mechanism bites any role that performs the action (or matches lines across more than one role file), merge it into the shared `LESSONS.md` file and remove the role-specific duplicates.
- **Cap (~20 lessons per file):** When a file crosses 20 lessons, widen overlapping lines into the general check they share and remove the redundant IDs until the file sits at or under 20. Never reuse a removed ID.

## How to write it in the repo

- **If the repo provides the lesson CLI (`pnpm lesson`):** Run `pnpm lesson <FILE> "<sentence>"` (`shared` for `LESSONS.md`, or the role name for `lessons/<ROLE>.md`). On `SIMILAR`, widen the matched line and re-run with `--replace <id> "<widened sentence>"`, or re-run with `--distinct <ids> "<sentence>"` when the mechanism is genuinely different. On an owner veto or after merging lines, remove with `pnpm lesson <FILE> --remove <id>`. In such cases, you may omit the manual check steps in the "## Widen over append" as the lesson script does that for you.
- **If the repo has no lesson CLI:** Edit the project's shared or role lessons file directly (`.memory/LESSONS.md` and `.memory/lessons/<ROLE>.md`, or `docs/lessons/GENERAL.md` and `docs/lessons/<ROLE>.md`), taking the next unused ID for that file's prefix and disclosing the written or widened line to the owner for veto.
