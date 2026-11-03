# Generation 1 report (2026-11-01)

Three parents (durable-0, durable-1, minimal-0), four children each, twelve children. Battery grew to ten scenarios (09 self-watch, 10 power-off). Principle 12 amended before the generation.

## Outcome

- 12 of 12 children adopted the amended principle 12 (positions, verdicts, three attempt outcomes) unprompted on the how; most also repaired principle 15 on their own.
- 4 children compiled clean before repair; after one repair round 11 of 12 compile (durable-1-3 kept one error). All cover 10/10, zero escapes, zero `any`, zero strikes.
- Judged in both positions (42 pairs, 84 verdicts): 38 pairs agreed, 4 split and discarded. **Children won every agreed child-vs-parent pair, 13 of 13, including 8 of 8 against their own parent.** Caveat: parents have no 09/10 files, which costs them when the random scenario is one of those; 13–0 exceeds that confound.
- Front: durable-0-2 (merge, BT +2.78, surface 331), durable-1-2 (inference, −0.46, 252), minimal-0-2 (surface-cut, −1.24, 188), minimal-0 (gen 0, the surface minimum at 175, Pareto extreme). Four parents for generation 2.

| child | operator | BT | surface | note |
|---|---|---|---|---|
| durable-0-2 | merge | +2.78 | 331 | dominant; signals unify create/update/cancel; lane pause/resume with metric value |
| durable-0-3 | inference | −0.38 | 350 | dominated by 0-2 |
| durable-1-2 | inference | −0.46 | 252 | front |
| durable-0-1 | surface-cut | −1.18 | 309 | |
| minimal-0-2 | surface-cut | −1.24 | 188 | front; "time paused" derived from resume entries |
| durable-0-0 | rename | −1.24 | 328 | |
| durable-1-1 | scenario-fix | −1.45 | 259 | |
| minimal-0-0 | rename | −1.74 | 197 | |
| minimal-0-1 | lens | −1.97 | 207 | |
| durable-1-0 | lens (double-entry) | −2.05 | 248 | `effect: repeatable/unrepeatable/external`; blocked with five reasons |
| minimal-0-3 | delete | −4.33 | 199 | schedule supplier deleted in favour of time trigger; judges punished |
| durable-1-3 | delete | — | 242 | one compile error left |

## Judge validity

First pass (single position, 70 verdicts): position A won 50–20; durable-1-0 won 4/4 as A and 0 as B. That front was partly an artefact, so gen 1 was re-judged with every pair in both positions and only agreeing pairs counted (90% agreed). The driver now judges this way. Gen 0's 39 single-position verdicts still feed BT for gen-0 variants, which are at the bottom regardless.

## Convergences on the new scenarios

- **Scenario 10, stated as requirements only: all five leading children arrived at replay** (recorded step outputs returned at no cost, driver `recover`, batch id recorded at submission and collected on restart, halts resolved while down found on restart, same attempt id). The agreed resumption design is confirmed from outside.
- Refinements we did not have: `effect: 'repeatable' | 'unrepeatable' | 'external'` as one field in place of three methods; *blocked has one meaning with five reasons* (`decision`, `stepFailure`, `budget`, `interrupted`, `definitionChanged`) in place of halt/block/wait/suspend.
- **Scenario 09: all five have a metric trigger source with `{ below } | { above }` thresholds and `pause(lane)` / `resume(lane)` consequences recorded as lane entries.**

## Critique synthesis (11 variants)

- The `ended` junk drawer is gone; no adversary names it. The amendment held.
- New lie in 3/11: `afterFailure` / `failure: IdleState` maps. Children read "an attempt's failure moves the unit only where the kind says so" as "every kind declares a failure state" and invented dead-end or looping states. Proposed addition to 12: *by default a failed attempt leaves the unit at pending under the lane's retry policy; a kind may declare a move.*
- Raw strings for entities the flow already typed: 7/11, now the dominant defect, and the children did not fix it because only the `scenario-fix` operator acted on the critique (durable-0's four children all kept the `Record<string, string>` their parent was criticised for). From the next launch every child must repair the parent's three sharpest critiques or argue them wrong.
- Principle 15 under pressure (3/11): shared account quota moved "into the ledger" is called a second store wearing the ledger's name. Proposed ruling: quota is kernel state and therefore ledger, but a shared account partition is append-only quota events (double-entry), so several harnesses write it without a lock and each folds the window.
- Two adversaries independently proposed scenario 11, migrations and backfills on a shared database (exclusive locks, non-idempotent commands, ordering across units). Candidate for run two.

## Cost

| stage | USD |
|---|---|
| surfaces (12) | 6.23 |
| scenarios, two halves (7.86 + 8.04) | 15.90 |
| repair (8) | 1.53 |
| critique (11) | 2.00 |
| judge, first pass (70) + retry | 8.85 |
| judge, both positions (84) | 10.21 |
| **generation 1** | **44.72** |
| two aborted launches (from the gen 0 report) | 3.89 |
| run one so far (21.66 + 3.89 + 44.72) | 70.27 of 150 |

Unit costs: $0.52 per surface, $0.67 per scenario half, $0.19 per repair, $0.18 per critique, $0.12 per verdict. Generation 2 with four parents, judged once in both positions: 12 children ≈ $38 (96 verdicts), 16 children ≈ $49 (120 verdicts). Corrected 2026-11-01 after grounding: the first version of this table listed one scenario half as both and put generation 1 at $36.86 and run one at $62.41.

## Loop changes this generation

Scenario stage in two sequential halves (ten scenarios exceed one response); nominal cap $100 per generation because the runner estimates unsent requests at twice the measured mean; batches of $12; two repair rounds; both-position judging; lineage = generation-0 ancestor; children must answer the parent's critiques.

## Recommendation

Add the failure-default sentence to principle 12 and the append-only ruling to principle 15, then run generations 2 and 3 together without a stop, three children per parent (12 children, about $38 each) to finish run one near $146. Four per parent needs the cap raised to about $170.
