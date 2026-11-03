# Scenario 11: halts with a clock, and retries with a bound

A contracts harness: an agent drafts, outside counsel reviews, finance signs off. Drafted for run two from the generation 1 and 2 critiques; every requirement here was a gap two or more adversaries found independently.

## Must express

- Kind Contract, supplied by a webhook (new contracts and counterparty redlines on existing ones) and by the operator. State in the document system via its API. Flow: `draft` (agent), halt `counsel` (outside counsel, days), halt `signoff` (finance), `execute` (command that is wrong to repeat).
- **Bounded retry as a lane policy.** A failed attempt retries under a policy declared on the lane, not on the kind: `contracts-eu` retries three times with exponential backoff, `contracts-us` retries once; both lanes handle the same kind. When the policy is exhausted the unit moves where the kind says, and nowhere else. A kind with no declared move and an exhausted policy is a startup error, not an infinite loop.
- **A halt with a clock.** If finance does not answer `signoff` within 30 minutes, the halt resolves itself to "approve under $500, else reject", recorded as resolved by timeout, distinct from a human resolution and from a policy resolution. The same attempt continues; nothing is cancelled or restarted. The 30 minutes are measured from the recorded halt, never from a field in unit data or from unit creation; at 20 minutes a deputy is paged and either person may resolve.
- **A policy-resolved halt is a policy.** Contracts in a category with 200 approved samples and zero rejections skip `counsel`. The skip is a registered policy with a recorded decision carrying the metric it read and its sample count, not a predicate inline in the handler.
- **Scoped resolvers.** Counsel resolves `counsel` through a plain HTTP dashboard and nothing else. Finance resolves `signoff` through a Claude Code supervisor and nothing else. An auditor client reads every decision and resolves none. The grant names the halt, not a capability string.
- **Waiting holds no capacity.** Drafting WIP is 3. Forty contracts awaiting counsel consume none of it and are not active on the board.
- **Returns bounded without ledger reads in the flow.** Counsel may return a contract; after the second return the unit ends in Declined, a failure. The flow contains no count of returns and reads nothing from the ledger; the bound is declared.
- **An event mid-attempt is neither dropped nor fatal.** A redline arriving while `draft` runs does not cancel the attempt and is not lost; it is applied in the next round. A redline arriving while the unit waits on counsel re-enters the flow at `draft`.
- Metrics: median time to decision per halt and per resolver, with sample counts; retries per lane this month; share of `signoff` halts resolved by timeout.

## Hostile aspects

- A retry policy that lives on the lane and differs per lane for one kind, with a declared end.
- A timer that resolves a halt instead of cancelling an attempt, and a third resolver kind beside human and policy.
- A halt as an entity that grants, metrics, timers and policies all reference by identity, never by string.
- Two clients on two transports with disjoint rights over the same unit.
- Position honesty: a unit waiting on a human is at `waiting`, holds no WIP, and the board says so.
- A bound on re-entries that the author declares and the kernel enforces, with no attempt arithmetic in the flow.
