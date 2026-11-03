# Scenario 3: research pipeline

A team runs literature-style research: a topic goes in, a sourced report comes out.

## Must express

- Kind Topic, supplied by the operator and by a weekly schedule that re-opens topics tagged "recurring". Topics are stored in the harness's own store (no external system), so the first-party store is the right choice here.
- Handler: fan out 20 search-and-extract calls as one cloud batch on a cheap model (the batch API discount matters), gather, then one synthesis call on a strong model, then a deterministic citation check command that fails the attempt if a citation does not resolve.
- Memory with a vector-store backend: prior report findings are a memory kind recalled by the synthesizer by semantic similarity. Recall is still a deterministic policy; the vector store is a backend. Experience about sources ("when the source is a preprint server, downgrade confidence") is a second kind in a JSONL store.
- Per-topic cost ceiling of $3; the scheduler never starts a topic whose projected cost (from the metric: mean cost of succeeded attempts of this kind) would pass the remaining daily budget of $40.
- Outcome: a report is delivered, or the topic is parked (not enough sources), or it is cancelled by the operator. Parked is not failure.
- The synthesizer's model is chosen by a policy that compares two strong models on a metric the owner defines: citation-check pass rate.

## Hostile aspects

- A memory backend that is not a file and a recall policy that uses similarity, while recall stays deterministic.
- A cloud batch step inside a flow, priced at the batch discount in telemetry.
- Budget as a scheduling input (daily, across units).
- A terminal outcome, parked, that is neither success nor failure.
