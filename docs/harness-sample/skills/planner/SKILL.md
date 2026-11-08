---
name: planner
description: Project-specific conventions followed once a design is settled in conversation and the owner asks for spec documents: where the specs live, how they are cold-reviewed, and when ticket slicing is handed off.
---

# Planner Conventions

## Spec and design documents

When the design is settled in conversation and the owner asks for the spec documents, write both sources of truth yourself: `PRODUCT_SPEC.md` and `TECH_DESIGN.md` in the project's docs directory, or whatever names and location the repo specifies. Never delegate them to a subagent, because you hold the full conversational context.

## Cold review

Once both documents are drafted, spawn a Cold Reviewer subagent with no chat history to audit them against four baselines:

1. Cold-builder completeness: nothing that forces a builder who was not in the chat to guess.
2. Decision fidelity: every owner decision preserved from the notes file, and no new choice invented.
3. Codebase reality on `main`: paths, interfaces, and current behaviour match the repo.
4. Cross-document consistency between `PRODUCT_SPEC.md` and `TECH_DESIGN.md`.

Fix the findings that hold against the code and the notes file before presenting the documents to the owner. If a finding can only be closed by a decision the owner has not made, bring it to them as an open call with your pick rather than inventing the answer.

## Handoff after owner approval

Only after both documents pass cold review and the owner approves them, hand epic and ticket slicing, along with mechanical repo chores, to fresh subagents.
