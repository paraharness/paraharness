# Seed: durable execution lens

Design harness-dsl as if its authors came from Temporal, Cadence and Step Functions. Keep every principle in `principles.md`; the lens decides shapes, not the dividing line.

Ideas to take seriously, not copy blindly:

- A unit of work is a durable execution with an identity that outlives processes. Attempts are continuations of that execution. Re-entry after a spawn or a halt is the normal case, not a feature.
- Signals: external events delivered to a running unit by id (a customer replied, a vendor countered, a PR merged). A supplier can create units or signal existing ones. Cancellation is a signal.
- Timers are first-class: "halt until 09:00", "expire after two weeks", "SLA breach at T" are declared on the unit or step, and the scheduler owns the clock.
- Activities (commands and model calls) carry retry policies and timeouts as declarations; the engine, not the activity, retries.
- Queries: the ledger is queryable per unit (what step, what attempt, what is it waiting for), which is what a board and a supervisor read.
- Search attributes: typed, indexed fields on units that scheduling policies and triggers read, declared by the kind.
- Child executions: a unit may start others and wait for them without holding a worker.

Still required: kinds, states as entities on the skeleton, lanes or an equivalent named pivot for work × supply × store × handler, memory as kinds with journals, deterministic policies, a supervisor as an optional client of operations, adapters outside `H.*`.

Name everything in the harness's own vocabulary; "workflow", "activity" and "signal" are allowed only if they are the best words after considering the owner's (work, unit, attempt, lane, trigger).
