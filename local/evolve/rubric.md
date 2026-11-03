# Judging rubric

Judges compare two variants, A and B, and name a winner on one criterion. Never score in isolation. Never reward length or completeness of prose. Prefer the variant a stranger could use correctly after reading its scenario files once.

## Criteria (one comparison per criterion)

- **fidelity**: which variant violates fewer principles in `principles.md`, and violates none of 5, 7, 8, 9, 10, 11? Each violation is a strike; a strike on a dividing-line principle counts double.
- **ergonomics**: in the scenario files, which variant lets a reader predict each line's effect from its name, keeps builder chains consistent, and needs fewer things explained?
- **expressiveness**: across the battery, which variant expresses the scenarios with fewer workarounds, fewer raw strings standing in for entities, and no lies (mapping an outcome onto a skeleton state it does not mean)?
- **economy**: which variant achieves the same coverage with a smaller surface: fewer entities, fewer methods, no one-use entity, no unused method?
- **connectedness**: which variant's entities connect through named pivots, with no orphan concept, no hidden coupling (a flow that secretly knows another kind, a role that knows a vendor), and no two words for one thing?

## Framings (each comparison is asked under one framing)

- **laravel**: you maintain a framework loved for striking the line between what it decides and what it leaves open. Judge whether the variant decides the right things.
- **durable**: you build durable-execution engines (Temporal, Step Functions). Judge whether the execution model (attempts, re-entry, cancellation, blocked, spawn) will survive contact with real failures.
- **newcomer**: you have never seen harness-dsl. You must implement the scenario named in the prompt tonight. Judge which variant you would rather be handed.
- **owner**: judge strictly against `principles.md`, nothing else.
- **adversary**: for each variant, find the scenario in the battery it handles worst, and judge which variant's worst case is less bad.

## Output

Return exactly one JSON object and nothing else:

{"winner": "A" | "B", "confidence": 0.5-1.0, "reasons": ["...", "..."]}

Reasons are specific: quote the line or name that decided it. At most three.
