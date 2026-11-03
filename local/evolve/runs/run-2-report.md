# Evolution run two: report (2026-11-02)

Seeds: the four members of run one's final front, imported as they were and asked only for the two new scenarios; plus `ours-2`, the owner's design as ruled after run one, materialised twice. Battery of twelve (11 halts with a clock and bounded retry, 12 external jobs and work under locks, added). Four generations. Spend $131.29; both runs $273.27.

## The question run two was launched for

Does the design as ruled hold against the designs the loop evolved?

- **Generation 0: yes, narrowly.** Both ours-2 materialisations compiled on all twelve scenarios after repair (the "less obvious options" one from 138 errors, a single generic, to zero). ours-2 won 4 of 5 agreed pairs against the imports, on fidelity, connectedness and economy against the durable line, losing once on economy to the minimal line. 10 of 15 pairs agreed.
- **Generation 1: no.** Given one generation to absorb the same rulings through their critiques, the evolved children beat the ours-2 lineage 12 to 1 across every criterion, worst on economy; both ours-2 parents went 0-4 and 0-3; the lineage left the front and died. Two of its six children also died on one inference error in the halt resolver that the evolved surfaces do not have.
- **Reading.** The rulings are right: the evolved children adopted them and won with them. The shape of our brief is not the best carrier: agent beside seat, a lane with twenty-odd methods, job beside effect, the share cap on the account. 0.4.0 should be built from the evolved shapes with the rulings applied, not from the ours-2 brief.

## Final front

| variant | lineage | operator | BT | surface | what it is |
|---|---|---|---|---|---|
| durable-0-2-0-1-0-1-2-1 | durable | lens (GenStage) | +1.24 | 386 | demand is the scheduler's recorded output (pause, WIP, capacity, admission are inputs to one number per lane); events are delivered to the open attempt by `rewind`, which keeps the attempt and its bounds; `H.batch` as one job shape; seat cut to role, model, pool, output; `distinct` model policies with `current` and `peers`; timers re-arm only when the computed deadline changes |
| minimal-0-2-2-2-1-2-2 | minimal | rename | +1.21 | 227 | `journal` with a deterministic, recorded recall policy (recall taken back from the store); `.retry({ times, backoff, exhausted, reopenAfter })` with `exhausted` typed to terminal states so a dead-end parking state cannot be written; the rule that a decision is a state and `ctx.fail` is only execution failure; `patch` entries that re-arm deadlines; firings that record applied or deduped effects |
| minimal-0-2-2-2-2-1-0 (gen 2) | minimal | rename | +0.84 | 225 | parent of the above |
| durable-0-2-0-1-1-2-2-2 | durable | rename | +1.24 | 406 | `H.panel`: the seat pivot widened to several seats of one role under a joint policy; exit rules with `update` and `limit`; multi-resource leases with holds and `heldWhileBlockedMs`; the vendor literal removed from the kernel |

Every front member: zero compile errors, zero escapes, zero `any`, zero strikes, twelve of twelve scenarios.

## What the loop measured

| | gen 1 | gen 2 | gen 3 |
|---|---|---|---|
| compile clean before repair | 0 of 12 | 6 of 12 | 9 of 12 |
| compile clean after two repair rounds | 9 | 10 | 12 |
| agreed pairs | 25 of 39 | 31 of 42 | 25 of 48 |
| children beat parents | 9 of 13 | 10 of 15 | 8 of 11 |
| minimal beat durable head to head | 1-2 | 8-6 | 8-4 |
| cost | $40.84 | $37.56 | $38.47 |

Operators, child-versus-parent in run two: scenario-fix 4-0, rename 4-0, delete 4-1, lens 4-2, surface-cut 2-1, merge 6-5, split 1-0, inference 2-2. In run one surface-cut went 12-0 and scenario-fix 2-4. The operator that wins depends on the battery: fresh scenarios reward fixing the worst one, a saturated battery rewards cutting.

Reading: the split rate reached 48% in the last generation; the judges can no longer tell the leading variants apart. The minimal lineage now leads the durable lineage head to head at 220 to 235 members against 370 to 410: with the rulings absorbed, judges pay for surface. Run one's convergence rule holds: three generations on a battery is enough.

## Findings for 0.4.0 added by run two

Rulings needed:

1. **No mandatory exhaustion target.** Required `exhausted` states bred `AuditStalled`, `EscalationStalled`, `blocked-by-predecessor` in both lineages, and one variant sent a Tenancy's failed review to `Current`. Proposed: exhaustion leaves the last attempt blocked with reason `stepFailure`, holding no capacity, for the supervisor to restart or abandon; a lane may declare a move, and only then. The minimal line's `exhausted` typed to terminal states, with `reopenAfter` for perpetual kinds, is the alternative worth reading.
2. **A step's failure is the attempt's failure** unless the step is declared tolerant, and a tolerant step's failure still lands on the command's record. Flows returning `'backup-failed'` as a state made failing hosts look perfect.
3. **Facets and resources.** Resources are leasable things; facets are dimensions; memory scope takes both by identity; a category is a facet. Four variants kept two lists for one category.
4. **One lease system.** File leases take a resource whose globs match the written path; today they are path strings inside the Claude Code subpath beside kernel locks on resources.
5. **Seat stays role × models × policy, and the A/B pair gets a noun** (`panel`, in the durable line): pools, workspaces and halts do not hang on the seat, and "rivals" are declared, not computed.
6. **A recorded, replayed metric read inside a flow is a step, not resumption code**; otherwise the ban in scenario 10 pushes arithmetic into flows through "rule policies".
7. **The share cap is a per-harness relationship**, declared where the harness registers the account, not on the account instance (principle 11 broke in our own scenario 7).
8. **A runner is chosen per attempt by a policy**, as a seat chooses a model; a runner fixed on the command forces one lane per host.
9. **The scheduler reads positions across lanes**; "no backup while an incident is active" must not be two subtracted counts.
10. **`move` has one meaning**; cancel, reopen, wake and re-enter are separate operations, and a move into a non-terminal state does not silently cancel a live attempt.
11. **Deadlines run from the recorded halt or transition**, never from unit creation or an attribute write; the SLA extension is a dedicated operation.
12. **Step-scoped leases released across a halt**: a deploy waiting overnight for promotion must not hold the cluster. Scenario 13 for any run three, proposed twice.

Confirmed from run one, now by both lineages: lifecycle split, replay resumption, `effect` as one declaration, blocked with reasons, metric crossings with hysteresis, lane exit maps, typed references, signals with deferred mid-attempt events, external jobs as a step kind, append-only shared quota.

## Defects in the loop itself

`as const satisfies` passed the escape counter at zero; it exists only where a builder signature does not infer, and the next run counts it. Imported seeds and missing-only scenario requests worked as designed and cost $3 for four seeds. The driver was stopped twice during generation 0 on my misreading of a question; the paid stages were collected from disk and nothing was lost or re-bought.

## Cost

| | USD |
|---|---|
| generation 0 (4 imports + ours-2 ×2) | 14.42 |
| generation 1 | 40.84 |
| generation 2 | 37.56 |
| generation 3 | 38.47 |
| **run two** | **131.29** |
| run one | 141.98 |
| **both runs** | **273.27** |

Key-1 was exhausted in run one; run two ran entirely on key-2.

## Recommendation

No run three now. The next step is design work with the owner at no API cost: read the two leading `h.d.ts` files side by side (the durable lens child at 386 members and the minimal rename child at 227), choose the carrier for 0.4.0, apply the twelve rulings above, and write the kernel-split design from it. A run three is worth its money only with scenario 13 and the rulings in place, and only to test that design the way run two tested ours-2.
