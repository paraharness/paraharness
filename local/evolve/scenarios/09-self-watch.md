# Scenario 9: a harness watching itself

The support harness of scenario 2 observes its own metrics and acts on them. Nothing here is new work from outside; every unit created here is created by the harness about itself.

## Must express

- A trigger whose source is a metric threshold: when the approval rate for a category over the last 7 days falls below 0.9 with at least 50 samples, the harness creates one Audit unit for that category in an `audits` lane with a human-only handler. While an Audit for that category is open, no second one is created, however many samples cross the threshold.
- The same crossing records a candidate experience item scoped to the drafter role and the category: "when drafting for {category}, recall the stricter phrasing, because approvals fell to {rate}".
- When the category's rate recovers above 0.95, the open Audit is cancelled. Below 0.9 and above 0.95 are two thresholds on purpose: the trigger fires on a crossing, once, not on every sample.
- A trigger that pauses the `conversations` lane when the harness's own model error rate over the last hour exceeds 0.2 with at least 20 invocations, and resumes it when the rate falls below 0.05. Paused means: nothing new starts in the lane, running attempts finish. Both the pause and the resume are recorded on the ledger and visible on the board, with the metric value that caused them.
- Each conversation's SLA can be extended by the reviewer through the supervisor. The breach timer moves with the new deadline; the old deadline never fires.
- A policy elsewhere must be able to ask "how many Audits were opened per category this month" and "how long was the lane paused in total".

## Hostile aspects

- A trigger source that is a metric, not a transition, a time or an external event; it still fires only from recorded ledger state and its firings are recorded.
- Hysteresis: two thresholds, one firing per crossing.
- Deduplication by a group key (the category), not by kind.
- A consequence that acts on a lane, not on a unit, and is itself a recorded, queryable fact.
- A timer whose deadline changes after it was armed.
