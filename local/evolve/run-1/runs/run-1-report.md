# Evolution run one: report (2026-11-01)

Four seed briefs (ours, durable-execution lens, supervision-tree lens, minimal), eight generation-0 variants, three generations of twelve children, forty-four variants in all, judged pairwise in both positions against a battery that grew from eight to ten scenarios. Total spend $142.13 plus under $1 for an aborted cache warming, against the $160 cap.

## Final front

| variant | lineage | operator | BT | surface | what it is |
|---|---|---|---|---|---|
| durable-1-2-1-1 | durable-1 | lens (GenStage/Broadway) | +1.96 | 255 | capacity follows position; pause is zero demand; mid-attempt events deferred and routed; `loopback` pivot; `failsTo` as the retry bound's destination; typed unit states |
| minimal-0-2-2 | minimal | surface-cut | +1.60 | 186 | the smallest full-coverage surface; metric triggers with hysteresis; "time paused" derived from resume entries |
| durable-0-2-0-1 | durable-0 | delete | +1.28 | 288 | `Lane.retry` with a required `exhausted` state, one failure bound per lane; blocking steps map only to waiting states; compile-checked store maps |
| durable-0-2-0 | durable-0 | surface-cut | +0.79 | 288 | generation 2's undefeated durable child; signals unify create, update and cancel; lane pause and resume recorded with the metric value |

Every front member: zero compile errors, zero escapes, zero `any`, zero principle strikes, ten of ten scenarios. The `ours` and `otp` lineages died in generation 1.

## What the loop measured

| | gen 1 | gen 2 | gen 3 |
|---|---|---|---|
| compile clean before repair | 4 of 12 | 7 of 12 | 11 of 12 |
| compile clean after repair | 11 | 11 | 12 |
| agreed pairs (both positions) | 38 of 42 | 39 of 45 | 36 of 48 |
| children beat parents | 13 of 13 | 16 of 21 | 6 of 16 |
| durable beat minimal head to head | 12-10 | 13-6 | 14-9 |
| cost | $44.72 | $36.24 | $35.62 |

Operators, child-versus-parent record over the three generations: surface-cut 12-0, delete 4-0, lens 3-0, inference 4-2, merge 5-3, rename 3-3, split 2-2, scenario-fix 2-4. Removing wins; fixing the worst scenario adds surface and loses.

Reading: generation 3 is the first in which parents held, and the judges' split rate doubled. The population has converged within each lineage on this battery. More generations here would buy little; the next gain comes from a changed battery and changed rulings.

## Design findings, consolidated

Ruled during the run (in `principles.md`):

1. **Lifecycle skeleton split**: attempts have three outcomes (the harness's track record); units have four positions (the scheduler's view); a kind's terminal states carry verdicts for the kind's own rate, no default. Eight of eight seeds broke the old five-outcome form the same way.
2. **Failure default**: a failed attempt leaves the unit at pending under the lane's retry policy; only a declared move moves it.
3. **Shared quota** is an append-only ledger partition folded per harness at read time; no cross-harness lock.

Converged on by independent variants, no ruling needed, to carry into 0.4.0:

4. **Resumption by replay** reached from requirements alone by every leading variant: recorded step results, driver `recover`, batch ids recorded at submission, halts resolved while down found on restart, same attempt id. Refinements: `effect: 'repeatable' | 'unrepeatable' | 'external'` as one declaration; *blocked with a reason* (`decision`, `stepFailure`, `budget`, `interrupted`, `definitionChanged`); time read only through a recorded `ctx.now`.
5. **Metric triggers** with two thresholds and one firing per crossing; `pause(lane)` and `resume(lane)` as ledger facts carrying the metric value.
6. **Flows blind to kind states** through a lane exit map (the durable form, which beat the minimal `flow.for(Bug, Feature)` form that forces kinds to share state names).
7. **Signals**: a supplier can create a unit or update one by key; cancellation is a signal; an event arriving mid-attempt is deferred to the next round, never dropped and never fatal.
8. **Typed references** for kinds, lanes, states, halts and models in policies, triggers and metrics; a typo is a compile error, not an empty sample.

Needing a ruling before run two:

9. **Retry's end state belongs to the lane.** Three generation-3 adversaries show that a move declared on the kind only means something given the lane's policy (principle 10), and that forcing one on every kind invents dead-end states. Proposed: the lane's retry policy names where exhaustion leaves the unit, in the kind's own states; the kind declares nothing about failure. This amends the failure-default sentence.
10. **An active unit's position is its attempt's current step**, read from the ledger, never a kind state. Three generations of `awaiting-approval` states beside halts, `during` maps, `parked`, `receiving`, `held` flags say the position of an active unit must not be authored twice.
11. **Resources are entities** (`H.resource`): memory scope, leases and metric facets all need the noun; `resources: ['section:…']` strings survived every repair because no variant would add the entity.
12. **A metric dimension is a typed ledger column or a declared facet, never both**: `H.tag('model')` beside `EntryFilter.model` in both lineages.
13. **A seat pivot for A/B**: the scenario 6 policy froze after a model swap in three variants because the metric keyed on the model; it must key on the seat (role × slot).
14. **The account names its quota partition** (instances carry their backend), rather than a path option on the ledger.
15. **A policy-resolved halt is a registered policy** with a recorded decision carrying the metric and sample count it read.
16. **Halts with a clock**: a timeout default resolves a halt without cancelling the attempt, as a third resolver kind beside human and policy; deadlines are measured from the recorded halt, never from unit data.
17. **Long external jobs** with submit and collect that hold no slot are a missing step kind, neither model nor human nor batch.

## Defects in the loop itself, found and fixed during the run

Output ceilings at 24K and 64K truncated whole variants (now 120K and 128K; scenarios written in two halves). Markdown fences and zod-3 idioms in materialised files (normalised). Judges favoured position A about 70% of the time (every pair is now judged in both positions and counts only when both agree). The adversary's critique was fed to children but only one operator acted on it (every child must now repair or argue the parent's three sharpest critiques). The Pareto front degenerated to the best-judged variant plus the smallest surface once every other objective saturated, and Bradley-Terry diverged for undefeated variants, which together collapsed the generation-2 front to two minimal variants after the durable lineage had won 13 to 6 head to head (coverage is now a gate, the front is filled by rank to four, and BT has a prior). The runner's spend lines are cumulative per stage, which made the generation-1 cost table under-report by one scenario half (corrected).

## Cost

| generation | USD |
|---|---|
| 0 (8 seeds) | 21.66 |
| two aborted launches | 3.89 |
| 1 (12 children, judged twice) | 44.72 |
| 2 (12 children) | 36.24 |
| 3 (12 children) | 35.62 |
| aborted generation-3 warming | under 1 |
| **run one** | **142.13 + under 1, of 160** |

Key-1's API credit was exhausted during generation 2; generations 2 and 3 ran on key-2.

## Recommendation for run two

1. Rule on items 9 to 17 above; amend `principles.md` accordingly.
2. Battery: add `drafts/11-halts-with-a-clock.md` (bounded per-lane retry, a halt with a clock, policy-resolved halts as policies, scoped resolvers, waiting units holding no WIP) and `drafts/12-external-jobs-and-locks.md` (submit-and-collect external effects, exclusive and shared locks on named resources, ordering between units). Both are written from gaps that two or more adversaries found independently.
3. Seeds: the four front members, plus a fifth seed that materialises our own 0.4.0 design as amended by the findings, so the loop judges the design we intend to build against the evolved ones. Run one's lesson about the `ours` seed was that the 0.3.0 leftovers lost; the fifth seed tests whether the amended design wins.
4. Three generations, about $36 each, under a $120 cap. Generation 3 of run one suggests three is enough on one battery.
