# Generation 2 report (2026-11-01)

Four parents (durable-0-2, durable-1-2, minimal-0-2, gen-0 minimal-0), three children each, twelve children. Principles 12 (failure default) and 15 (shared quota as append-only ledger events) amended before the generation. Children had to answer their parent's three sharpest critiques.

## Outcome

- Seven of twelve compiled clean before repair (four last generation); eleven of twelve after two repair rounds. durable-0-2-2 died on one inference error in scenario 02 (a halt's `skip` return type). All eleven cover 10/10, zero escapes, zero `any`, zero strikes.
- Judged in both positions: 45 pairs, 90 verdicts, 39 agreed, 6 split and discarded.
- Children won 16 of 21 agreed child-vs-parent pairs. Head to head, durable children beat minimal children 13 to 6.
- Both undefeated children are `surface-cut` children: minimal-0-2-2 (6-0, surface 186) and durable-0-2-0 (6-0, surface 288). Last generation `merge` won; the operator that wins changes with the parent.

| child | parent | operator | gen-2 record | BT | surface |
|---|---|---|---|---|---|
| minimal-0-2-2 | minimal-0-2 | surface-cut | 6-0 | +2.05 | 186 |
| durable-0-2-0 | durable-0-2 | surface-cut | 6-0 | +1.54 | 288 |
| minimal-0-2-0 | minimal-0-2 | rename | 2-1 | +0.95 | 208 |
| durable-1-2-1 | durable-1-2 | lens | 2-1 | +0.40 | 254 |
| minimal-0-2 (gen-0 child) | g00 minimal-0 | scenario-fix | 5-2 | +0.32 | 232 |
| durable-1-2-0 | durable-1-2 | split | 4-2 | +0.31 | 258 |
| minimal-0-2-1 | minimal-0-2 | merge | 4-2 | +0.26 | 211 |
| durable-0-2-1 | durable-0-2 | merge | 3-3 | −0.46 | 338 |
| minimal-0-1 (gen-0 child) | g00 minimal-0 | surface-cut | 1-3 | below 0 | 195 |
| durable-1-2-2 | durable-1-2 | scenario-fix | 0-2 | below 0 | 259 |
| minimal-0-0 (gen-0 child) | g00 minimal-0 | split | 0-5 | below 0 | 195 |
| durable-0-2-2 | durable-0-2 | inference | died | — | 329 |

## The selection flaw, found and fixed this generation

The driver's first front for generation 2 was two variants: minimal-0-2-2 and gen-0 minimal-0 (0-7 this generation, coverage 8/10). The durable lineage, which had just beaten the minimal lineage 13 to 6 head to head, was extinct. Two causes:

1. **Pareto degeneracy.** With escapes, `any` and strikes at zero for every variant, only surface and BT vary, so the Pareto front is exactly the best-judged variant plus anything with a smaller surface. Coverage did not save it because the dominance test let a smaller surface at 8/10 coverage stand beside 10/10.
2. **Bradley-Terry divergence.** An undefeated variant's maximum-likelihood strength is infinite; after 200 iterations the two 6-0 variants sat at +3.23 and −0.22 for no reason in the data, and the gap decided the front.

Fix, in `evolve.py`: full coverage is a gate before selection; the Pareto front is taken first and then filled by BT rank to four parents, at most two per lineage; BT gets one pseudo-game per variant against an average opponent. Generation 2 was re-selected under the fix; generation 3's first launch, on the collapsed front, was stopped after its cache-warming request (under $1).

**Front for generation 3:** minimal-0-2-2 (Pareto), durable-0-2-0, minimal-0-2-0, durable-1-2-1 (by rank). Three gen-0 roots represented.

## Critique synthesis (11 variants)

- **Retry is the new universal hole.** Amended principle 12 says a failed attempt waits "under the lane's retry policy", and no variant has one: three adversaries show kinds that retry a broken builder forever, one shows a variant that deleted the attempt counter the rule needs. The principle names a mechanism the battery never demands, the same way principle 13 named metric triggers that no generation-0 variant built. Scenario 11 must require a bounded, per-lane retry policy.
- **Flows coupled to kind state names** (seed weakness 1) survive in 5 of 11 across three generations, mostly in the minimal lineage (`flow.for(Bug, Feature)` forces shared state names). The durable lineage maps exits in the lane, which compiles, but its tracker store maps are unchecked string tables.
- **Where an active unit stands is unsolved.** Four durable children invent sub-states or flags for it (`during` maps marking a blocked unit active, `parked`, `receiving`, `held`), each a fifth position in disguise. The honest design: an active unit's position is its attempt's current step, read from the ledger, never a kind state.
- **Policy-resolved halts that are not policies** in 3 of 11: inline `skips` with a name string, or a resolver attached to the decision kind, both outside the policy record principle 18 needs.
- **Raw strings** moved rather than vanished: halts became entities after last generation's critique; memory scope strings (`section:`, `category:`) and metric tags did not.
- **Replay determinism:** `ctx.now()` outside the recorded calls lets a replay branch differently. Our design records time per node visit; the rule must be stated.
- **Principle 15 refinement:** the shared quota partition should be named by the account (instances carry their backend), not by a path option on the ledger.
- **Scenario 11 candidates:** "a halt with a clock" (timeout default resolving the halt without cancelling the attempt) proposed independently twice; contract-review scenarios (waiting units must not hold WIP, resolvers scoped per client) for the third generation running. Together with bounded retry these make one scenario.

## Cost

| stage | USD |
|---|---|
| surfaces (12) | 6.25 |
| scenarios, two halves (7.09 + 8.34) | 15.43 |
| repair, two rounds (5 + 1) | 1.40 |
| critique (11) | 2.03 |
| judge, both positions (90) | 11.13 |
| **generation 2** | **36.24** |
| aborted generation-3 warming | under 1 |
| run one so far (70.27 + 36.24 + under 1) | about 107 of 160 |

Key-1's API credit was exhausted during the second scenario half (a 402 from the API); the runner moved to key-2 and every later batch ran there.

## Recommendation

Run generation 3 on the re-selected front, three children per parent, about $38, which ends run one near $146. Then stop: write the run-one report, draft scenario 11 (bounded per-lane retry, halt with a clock, scoped resolvers, waiting units holding no WIP), and take the design findings into 0.4.0 before any run two.
