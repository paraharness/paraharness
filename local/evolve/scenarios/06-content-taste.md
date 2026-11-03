# Scenario 6: content review driven by taste

A publication runs drafts through review. The point of this harness is that it learns the owner's taste.

## Must express

- Kind Draft, supplied from a CMS by poll, state in the CMS.
- Handler: two reviewer agents on two different models each produce a critique; a deterministic command merges them; the editor (human, supervisor) accepts or returns the draft with notes.
- Taste memory grows from the editor's notes: every returned draft's notes become candidate taste items through a trigger (returned → record taste candidate), curated by the editor later through the control API (accept, merge, drop). Reviewers recall taste; taste applies to all drafts, with a smaller set scoped to a section (`sports`, `opinion`).
- A/B on models: the two reviewers' models are chosen by a policy that reads which reviewer's critiques the editor acted on more (a metric the owner defines from editor actions recorded as transitions), with sample counts, and swaps the weaker model after 50 samples.
- Experience memory also exists (fact-checking lessons), recalled by both reviewers, recorded by the fact-check command when it finds a repeat mistake.
- No worktrees, no files, no code.

## Hostile aspects

- Memory capture as a trigger consequence, not an agent tool.
- Curation operations on memory (merge, drop) exposed to the supervisor.
- A metric defined by the owner from recorded operator actions, not from attempt outcomes.
- Two agents of the same role on different models in one flow.
