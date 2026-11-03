# Generation 0 report (2026-11-01)

Eight seed variants (4 briefs × 2), all compiling after one repair round with zero escapes, zero `any`, 8/8 coverage, zero principle strikes. Mechanical fitness therefore did not separate them; judging and critique did.

## Front (Pareto, ≤2 per lineage, lineage rescue for `ours`)

| variant | BT | wins | surface | note |
|---|---|---|---|---|
| durable-0 | +1.07 | 7 | 292 | attempts as continuations, replay log, signals unify events, timers as sources |
| durable-1 | +0.72 | 9 | 238 | smallest durable surface; `move().from()`, `exit(label)` |
| otp-0 | +0.53 | 7 | 315 | gen_statem tables on kinds, per-state timeouts, Meter for quota |
| minimal-0 | −0.41 | 6 | 175 | smallest surface of all; `idle` + `ended`; `spawn`/`until(children)` |
| ours-0 | −2.34 | 2 | 284 | **on the front only by lineage rescue; lowest BT of eight** |

Off the front: otp-1 (−1.17), ours-1 (−1.68, surface 436), minimal-1 (−2.33).

## Judge validity

39 of 40 verdicts parsed (judge-00-0024 returned malformed JSON). Winner in position A 23/39 = 59%: mild, not significant at n=39, but watch it. Confidence clustered 0.60–0.77 on every verdict: judges hedge uniformly, so only relative values carry information. 14 pairs were judged more than once; 10 unanimous, 4 split, two of the splits on the same criterion (ergonomics) in swapped positions: that is the noise floor. By criterion, durable-1 wins economy and fidelity, minimal-0 wins expressiveness, otp-0 and durable-0 win connectedness.

## Findings that hold across all eight variants

1. **Principle 12 (five-outcome skeleton) is wrong as written.** 8/8 variants broke it, all in the same direction: a terminal outcome that is neither success nor failure (`ended`/`concluded`), and in 4/8 a non-terminal outcome that holds no capacity (`idle`/`waiting`/`dormant`). All redefined success rate as `succeeded / (succeeded + failed)`. The adversaries then showed the cost in every one: `ended` is a junk drawer where Rejected, Returned and Escalated hide, so a drafter whose every reply is rejected never lowers a success rate (durable-0, durable-1, otp-1, ours-1); `failed` mapped to a business state loops hot or hides crashes (minimal-0, minimal-1, otp-1); forcing a `failed` state per kind (ours-1) makes one timed-out usage report terminal for a years-long tenancy. The root defect is in the principle: it puts the attempt's outcome (succeeded / failed / cancelled, what metrics count) and the unit's state (the kind's vocabulary, which needs only pending / active / waiting / terminal) in one enum. Separating them removes both lies; the kind then declares which of its terminal states count against whom, instead of the skeleton guessing.
2. **No variant has a metric-threshold trigger source**, although principle 13 names it. Every adversary's new scenario exploited exactly that: drift guard, canary rollback, circuit breaker, freeze on falling success rate. The battery never requires it, so nothing selected for it. Scenario 09 for the next run must.

Recurring secondary findings (≥4 variants): raw strings standing in for entities the flow already typed (step, seat, agent, state names in metric selectors and policies; 6/8); timer re-arm semantics unspecified when the deadline changes, one clock per lane (3); no parallel step or quorum join, parent cannot read children's data (3); one word for several things (`schedule` ×4 in minimal-0, `share` ×2 in otp-0, `pool` ×2 in ours-0); waiting units counted as active and holding WIP (2); a policy reading its own synthetic output (durable-1's auto-approval counted as human approval).

## The `ours` lineage

The critiques against ours-0 and ours-1 name the 0.3.0 leftovers: a model bound to a pool (`H.model(name, accountOrPool, id)` forces `coding-sonnet` and `docs-sonnet` for one model id, so track record does not transfer); flows still coupled to kind states; raw strings for agents in metrics (`actedOn: z.array(z.string())`); the section scope abusing leases; `Returned` as an active state with no attempt plus a diff-based re-entry trigger. ours-1 at surface 436 is the largest and judges punished it on economy. durable-0, the top variant, is closest to the resumption design already agreed (attempts as continuations over a replay log; spawn, await and wait suspend; halt blocks without a slot).

## Cost

| stage | requests | USD |
|---|---|---|
| mutate / surface | 8 | 5.77 |
| mutate / scenarios | 8 | 7.91 |
| repair | 8 | 1.66 |
| critique | 8 | 1.28 |
| judge | 40 | 5.04 |
| **generation 0** | | **21.66** |
| two aborted launches (truncated outputs) | | 3.89 |
| **run one so far** | | **25.55 of 75** |

Measured unit costs: $1.71 per variant for mutate (surface + scenarios), $0.21 per repair, $0.16 per critique, $0.126 per judgment. Generation 1 from this front: 15 children → mutate ≈ 25.7, repair ≈ 3.1, critique ≈ 2.4, judge 100 comparisons ≈ 12.6; about $44. One more generation fits under the $75 cap; three do not.

## Recommendation

Do not run generation 1 on the current principles and battery. Principle 12 is contradicted by every variant and every adversary; descendants would bake `ended` deeper. Amend principle 12 (attempt outcome separate from unit state), add scenario 09 (metric-threshold trigger plus a lane-level pause recorded on the ledger) and scenario 10 (power off mid-attempt, resume), then run generations 1–3 from this front at about $45 each. Gen 0 stays the seed generation either way; its front and critiques carry forward as parents. Changing the battery resets comparability with gen 0's judgments, which only ranked seeds.

Loop fixes made during gen 0, all in `evolve.py`: materializer strips markdown fences and rewrites the zod 3 `ZodTypeDef` idiom; compile copies variants outside the package tree, maps `harness-dsl/kernel`, uses Node types; a repair stage; stage shares 0.5/0.2/0.1/0.2; output ceilings 120K/128K. Open: a repair round that takes more than one pass; a judge retry on malformed JSON; store the custom id on judgments so position bias can be computed from `state.json`.
