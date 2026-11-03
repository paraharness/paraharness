# Generation 3 report (2026-11-01)

Four parents from the re-selected generation-2 front (minimal-0-2-2, durable-0-2-0, minimal-0-2-0, durable-1-2-1), three children each.

## Outcome

- Eleven of twelve compiled clean before repair (4, 7, 11 across generations 1 to 3); twelve of twelve after one repair request at $0.18. First generation with no deaths. All 10/10 coverage, zero escapes, zero `any`, zero strikes.
- Judged in both positions: 48 pairs, 96 verdicts, 36 agreed, 12 split and discarded. The split rate rose from 10% to 13% to 25% over three generations: the judges find the variants harder to tell apart.
- **Children won 6 of 16 agreed child-vs-parent pairs**, after 13 of 13 and 16 of 21. Two generation-2 parents held their places on the front. The population has stopped improving against its parents on this battery.
- Durable children beat minimal children 14 to 9 (12-10, 13-6, 14-9 across the three generations).

| child | parent | operator | gen-3 record | BT | surface |
|---|---|---|---|---|---|
| durable-1-2-1-1 | durable-1-2-1 | lens (GenStage/Broadway) | 3-0 | +1.96 | 255 |
| durable-0-2-0-1 | durable-0-2-0 | delete (Guard) | 5-1 | +1.28 | 288 |
| minimal-0-2-2-2 | minimal-0-2-2 | split | 3-2 | +0.49 | 200 |
| minimal-0-2-0-0 | minimal-0-2-0 | inference | 2-2 | +0.31 | 213 |
| durable-0-2-0-0 | durable-0-2-0 | inference | 4-3 | +0.30 | 305 |
| minimal-0-2-2-1 | minimal-0-2-2 | scenario-fix | 2-1 | −0.02 | 199 |
| minimal-0-2-0-1 | minimal-0-2-0 | scenario-fix | 1-3 | below 0 | 208 |
| durable-1-2-1-0 | durable-1-2-1 | rename | 1-3 | below 0 | 256 |
| durable-1-2-1-2 | durable-1-2-1 | merge | 2-4 | below 0 | 250 |
| durable-0-2-0-2 | durable-0-2-0 | rename | 0-1 | below 0 | 298 |
| minimal-0-2-0-2 | minimal-0-2-0 | rename | 0-2 | below 0 | 228 |
| minimal-0-2-2-0 | minimal-0-2-2 | inference | 0-5 | below 0 | 197 |

Parents this generation: durable-1-2-1 5-2 (+0.66, cut by the front size), minimal-0-2-2 3-1 (+1.60), durable-0-2-0 2-3 (+0.79), minimal-0-2-0 3-3 (+0.21).

**Front after generation 3:** durable-1-2-1-1, minimal-0-2-2, durable-0-2-0-1, durable-0-2-0.

## The two new front members

- **durable-1-2-1-1** (lens): capacity follows position, pause is zero demand, events arriving mid-attempt are deferred and routed rather than ignored, a `loopback` pivot for units that re-enter their own lane, `failsTo` as the destination when the lane's retry bound is reached, `UnitView.state` typed as the kind's states, `holdsCapacity` on the open attempt. No principles broken.
- **durable-0-2-0-1** (delete): Guard deleted into an agent setting plus a driver `enforce` contract; `Lane.retry` with a required `exhausted` state and the rule that every lane has exactly one failure bound; blocking steps map only to waiting states and running steps only to active ones; store maps compile-checked; admission counts positions by name. Implements the amended principle 12 exactly as the generation-3 adversaries proposed: the exhaustion target lives on the lane.

## Critique synthesis

See the run-one report. The sharpest: retry's end state belongs to the lane, not the kind (three adversaries); waiting on a human modelled twice (third generation running); resources as entities never repaired; facets duplicating ledger columns; the scenario 6 A/B policy frozen after a swap in three variants because metrics key on the model, not the seat; long external jobs with submit and collect as a missing step kind.

## Cost

| stage | USD |
|---|---|
| surfaces (12) | 5.99 |
| scenarios, two halves (7.03 + 8.11) | 15.14 |
| repair (1) | 0.18 |
| critique (12) | 2.17 |
| judge, both positions (96) | 12.14 |
| **generation 3** | **35.62** |
