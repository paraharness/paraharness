# Scenario 8: lifecycles that do not fit

Three kinds of work chosen to break a pending/active/succeeded/failed/cancelled skeleton. A variant must express them without lying: mapping an outcome onto a skeleton state it does not mean is a failure of this scenario.

## Must express

- **Experiment**: an A/B test unit runs for two weeks, collecting a metric from a command every hour. It ends in one of: A wins, B wins, inconclusive. None of these is failure. The scheduler must treat all three as terminal; metrics must distinguish them; a policy elsewhere must be able to ask "how often are experiments inconclusive?"
- **Tenancy**: a customer's tenancy is a unit of work that is never terminal while the customer is a customer. It is re-evaluated monthly (usage review, a model-written summary, a human decision to upsell or not) and may be suspended and reinstated any number of times. It ends only on churn, which is neither success nor failure. The scheduler must not consider an active tenancy as occupying capacity between evaluations.
- **Negotiation**: a procurement negotiation unit alternates between the harness (an agent drafts the next offer) and the outside world (the vendor replies, via a webhook supplier that updates an existing unit rather than creating one). It may end in agreement, walk-away by us (a decision, not a failure), walk-away by them, or expiry (a time trigger). Each attempt is one round; the unit outlives many attempts.

## Hostile aspects

- Terminal states that are neither success nor failure, needed by metrics.
- A unit that is active for years and must not hold capacity.
- A supplier that updates an existing unit instead of creating one.
- An attempt-per-round model where the unit's identity spans attempts and external replies.
- If the variant changes the skeleton (adds outcomes, replaces the five with something else), its design notes must say what success rate means afterwards.
