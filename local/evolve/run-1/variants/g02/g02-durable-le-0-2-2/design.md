# harness-dsl, durable lens, generation 2 (inference pass)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, with a stable id and a `key` (from `Kind.key`). At most one non-terminal unit per lane holds a given key. Signals route by key, and creation deduplicates by key.
- **Attempt**: one pass of the lane's flow over a unit, from a start step to an exit. It ends with exactly one of three outcomes: succeeded, failed, cancelled (rule 3 says which). While open, its status is one of:
  - *running*: executing a step, holds capacity;
  - *blocked*: stopped at a halt, a cost ceiling, or crash recovery, waiting for an outside decision, holds nothing;
  - *waiting*: at an `await`, a `wait`, a `spawn` or a submitted batch, holds nothing.
- **Step**: a named node of a flow. A `halt` step *blocks* the attempt. "Halt" is the flow node, "blocked" is the status it produces; no third word exists. "Parked" means blocked for reason `recovery`; it is no longer a separate status.
- **Invocation**: one call of an executable within a step. Each retry is a new invocation.

"Run" and "suspended" are not used.

## Lifecycle

1. **States are where a unit rests.**
   - `H.state(name, 'pending' | 'waiting')` declares a resting state.
   - `H.terminal(name, verdict)` declares a terminal state; the verdict has no default.
   - The kind declares `.initial`, an optional `.onAttemptFailed`, and `.onCancelled`. Without `onAttemptFailed`, a failed attempt leaves the unit at its pending state under the lane's retry policy.
2. **Position is derived, never declared twice.**
   - A unit with a running attempt is `active`.
   - A unit whose attempt is blocked or waiting is at `waiting`.
   - Otherwise the unit is at its state's position.
   - The board shows the state, plus the attempt's current step when an attempt is open ("Backlog · build, round 2").
   - Stores that mirror progress implement the optional `Store.progress`.
   - There are no "active" states and no step-to-state map. This repairs critique 3; see "What changed".
3. **Attempt outcome is derived from the kind's verdicts.**
   - An attempt is **failed** if a step failed after its retries, or if its exit maps to a terminal state whose verdict is `failure`.
   - It is **cancelled** if it was cancelled (by `H.cancel`, a `restart`, or `enter` into a terminal state).
   - Otherwise it **succeeded**.
   - So "the flow finished" is never success by itself. `exhausted → Exhausted (failure)` is a failed attempt.
   - Interrupted attempts are reported apart and never enter a denominator.
4. **Two queries, one definition of success.**
   - `outcomes({ of })` counts unit verdicts: success, failure, neutral, and `byState`.
   - `attempts({ of, model, agent, runner, account })` counts attempt outcomes, which rule 3 derives from those verdicts.
   - Model, agent, runner and account metrics use `attempts` (principle 12). A model participates in attempts, not in units.

## Entities

**Kinds** (vocabulary): work kind, state, signal, role (driver-neutral intents), memory kind, command, flow, operation, metric.

**Instances** (subpaths): account, model, runner, workspace, supplier, store, memory store, ledger, account ledger, client, observer. `H.clock` and `H.operator` are kernel suppliers. Instances carry no relationships: an account names no model family, and a model names no pool.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exits, params) | managed units |
| Agent | role × model or model policy | a model-call executable |
| Pool | accounts × share caps × drain rank × served models × account ledger | quota-eligible access to those models |
| Journal | memory kind × store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | declared name and measure → source → samples or amounts | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | all of the above, plus ledger, clients, observers | a running harness |

## Rules

1. **Flows know no states.** A flow ends at named exits. The lane maps every exit to a state of its kind (`{ exits }`, total and compile-checked) and supplies `params`. One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`).

2. **Signals.**
   - A supplier route may `create` a unit or `signal` one, by key or by a typed predicate.
   - `Lane.on(signal, { update, restart, enter })`. A `restart` cancels any open attempt and starts a new one at a typed step. Entering a terminal state cancels any open attempt.
   - Unhandled signals are buffered for `await`.

3. **Creation deduplicates by key.** A duplicate create is recorded as `createSkipped`.

4. **Timers re-arm** on creation and after every `attributesUpdated`. The old deadline is cleared, and terminal units clear their timers.

5. **Trigger sources** are `transition`, `pattern`, `timer`, `step`, `invocation` and `crossing`. All fire only from recorded ledger events, and every firing is recorded.
   - A crossing has hysteresis: it fires once on `entered`, and cannot fire again until it has `exited`.
   - `H.trigger(name, source)` takes its source at construction, so the event type is known before any consequence is written.

6. **Trigger consequences** are `create`, `signal`, `record` (optionally as a candidate), `pause` and `resume`.
   - Pause and resume are ledger events, shown on the board.
   - `metrics.paused` returns the total paused milliseconds and the count.

7. **Steps.**
   - Retry and timeout are declarations on the step.
   - `acceptExitCodes` makes non-zero exit codes into output instead of failure.
   - A preflight runs on the runner it guards and counts against that step's retries.

8. **Halts.**
   - `.halt(name, decisionSchema, { ask, skip? })`. The schema comes first and positionally, so the decision type is fixed before `ask` and `skip` are checked.
   - A `skip` that returns a decision records it with `auto: true`.
   - `StepEvent.decidedBy` carries the client that resolved the halt.

9. **Cost ceiling.**
   - `Lane.ceiling({ maxUsd, onExceed })` checks projected unit cost before every invocation.
   - With `'halt'`, the attempt blocks for reason `ceiling` before that invocation. The ask is kernel-written: unit, spent, ceiling, and the next step. The decision is the kernel shape `CeilingDecision`:
     - `raise` (with `raiseToUsd`) resumes the same invocation;
     - `stop` cancels the attempt and the unit goes to `onCancelled`.
   - With `'fail'`, the attempt fails.

10. **Determinism.**
    - Exit predicates, loop bounds, `skip`, and model, account and scheduler choices are each recorded once as a `policyDecision` and read back on replay.
    - Policies read a `Metrics` snapshot taken at decision time.

11. **Capacity and scheduling.**
    - Only running attempts hold runner slots, lane WIP and account reservations.
    - `AdmitCtx.count(lane, ...positions)` counts units of a lane at the given positions. With no positions, it counts all non-terminal units.
    - "No new Backup while an Incident is open" is `count(incidents) === 0`. A blocked Incident counts because it is non-terminal.
    - `rank` is ascending.

12. **Metrics.**
    - `H.metric(name, 'rate' | 'total')` declares the metric. It is vocabulary and depends on nothing.
    - `.from(source, extract)` defines it. The extractor returns `Sample`s for a rate or `Amount`s for a total, typed by the measure. `undefined` entries are dropped, so a conditional sample is an array element and no `push` is needed.
    - Policies, skips and crossings may reference the declared metric before the lane it reads exists. Both descriptors carry the same name and measure.
    - Only the defined metric is registered with `Harness.metrics`. Startup fails if a referenced metric has no registered definition.

13. **Pools serve named models** (repairs critique 1).
    - `Pool.serves(...models)` is the relationship between models and accounts. It lives on the pivot whose product is "access to these models under quota".
    - Startup fails if a model used by any agent or model-policy candidate is served by zero registered pools, or by more than one.
    - Startup fails if any account of a pool is not accepted by the driver of a model the pool serves (`ModelDriver.accepts`).
    - There is no string family and no registration order.
    - `Pool.drain(H.policy.account(name, rank))`: the kernel filters out accounts in cooldown or over their share cap, picks the lowest rank, and falls back to `fallback` when none is left.

14. **Shared quota.**
    - `AccountLedger` is an append-only partition of quota events (`append`, `cooldown`). Each harness folds the window at `state()` read time, with no lock across harnesses.
    - Share caps are per pool, so per harness.

15. **Memory.**
    - Recall is deterministic: filter by scope, rank by specificity or backend similarity score, break ties by track record.
    - Reads take the union of all journals visible to a role. Each write names one journal.
    - Writers are agent roles in `recordedBy`, triggers, or clients holding `memoryWrite`.

16. **Restart.** The author writes no resumption code; the only author input is the per-step `afterCrash` and `alreadyDone` declarations.
    - **Single writer.** A writer claim with a TTL; appends from a stale writer are rejected.
    - **Completed steps** replay their recorded output at zero cost.
    - **The running step** gets an `attemptInterrupted` event, then its `afterCrash` applies:
      - `rerun`;
      - `park`, which blocks the attempt for reason `recovery` unless `alreadyDone` returns true;
      - `askDriver`, which calls `session(idempotencyKey)`.
    - **Halts.** Decisions are the only append allowed without the claim, so a halt resolved while the harness was down is found on restart.
    - **Batches** are collected by `batchId`, never resubmitted.
    - **Children** are read from their recorded positions.
    - **Changed definitions.** A `flowVersion` mismatch blocks the attempt for reason `recovery`; `attemptsRecover` restarts it from the top or abandons it.
    - The attempt id is kept throughout.

17. **Control API.** Clients are granted operations. The Claude Code supervisor and plain HTTP are two `Client` backends.

18. **Startup validation**, in addition to the checks above:
    - duplicate registered names;
    - a flow that can fall off its end;
    - unregistered references;
    - a cancel without `onCancelled` or a reaction;
    - a crossing over a total metric;
    - a batch step or `askDriver` step on a driver that lacks the capability.

## What changed and why

**Operator: inference.** Every place in the parent's scenarios that needed an explicit type argument or an annotation to type-check, and the surface change that removes it:

| Scenario | Annotation or type argument in the parent | Surface change |
|---|---|---|
| 1 | `.reduce<AccountState \| undefined>(…)` in the drain policy | `H.policy.account(name, rank)`: the author ranks one account, and the kernel does the eligibility filter (cooldown, share cap) it already knew how to do. |
| 7 | `(ctx: AccountPolicyCtx)` annotation | Removed by the same change. |
| 2, 9 | A shared router annotated `(event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route`, plus a generic `routeHelpdesk<SN>` | `Lane.supply(suppliers, route)` takes one supplier or an array of suppliers of the same event type, so the route is written inline and inferred. |
| 2, 5 | `skip: (ctx): DecisionValue \| undefined =>` | The decision schema is now the second positional argument of `halt`, so `D` is fixed before the options object is checked. `skip` gets a non-inferring contextual return type. |
| 2, 3 | Policies referencing metrics defined later from the lane, a type cycle (lane → flow → skip or policy → metric → lane) | Metrics are declared (`H.metric(name, measure)`) independently of their source and defined with `.from(source, extract)`. Declarations depend on nothing, so the cycle cannot form. `.samples` and `.amounts` collapse into one typed `from`. |
| 6, 9 | `const samples: Sample[] = []` with `push` | Extractors may return `undefined` entries, which are dropped. |
| all | `H.trigger(name).on(source)` started as `Trigger<never>` | `H.trigger(name, source)`; `.on` is removed. |

Scenario-local data arrays whose literal unions widened (scenario 4 hosts, scenario 5 sources) will be written inline inside routes, where contextual typing carries the union. That needs no surface change.

**Critique 1: model-to-pool routing through raw strings.**
- Repaired: `Account.family` and `Model.families` are deleted.
- The pool, which is the pivot, now names the models it serves (`serves`).
- Ambiguity (one model in two pools) and gaps fail at `start()`.
- Driver and account compatibility is a driver method (`accepts`), not a string match.
- Registration order no longer means anything.

**Critique 2: success defined two ways.**
- Repaired at the root: an attempt's outcome is now derived from the verdict of the state its exit maps to (Lifecycle rule 3), so "reached an exit" no longer means succeeded.
- `outcomes` lost its `model` filter, because a unit's verdict is not a model's.
- Model policies in every scenario read `attempts` (principle 12), and both readings now agree with the kind's terminal states (principle 18).

**Critique 3: the step-to-state map duplicates the lifecycle.**
- Repaired by deleting `HandlerMap.during` and active states. Position is derived from the attempt's status. A blocked or waiting attempt puts the unit at `waiting`, so the board never shows active work that holds no capacity.
- Vocabulary is down to one word per idea:
  - halt (node) blocks (status);
  - waiting (status and position, same meaning: holds nothing);
  - parked is blocked for reason `recovery`.
- The three axes are reduced to one derivation plus a reason: state → position, with attempt status overriding while open, and `blockedBy` or `waitingFor` as the reason.
- Store backends that want an "In Progress" column implement `progress`. Linear gets `whileActive` and `whileWaiting`.

**Other adversary findings.**
- *Ceiling halt has no shape.* Now a kernel block reason with a fixed decision (`CeilingDecision`) that resumes or cancels (rule 9).
- *Rejection loops to `New`.* This is a scenario defect, to be fixed in scenario 2: the approval sits inside a bounded `loop` with the drafter, which receives the reviewer's notes; exhaustion exits to a failure-terminal `Rejected`, so it counts.
- *Escalation cause guessed.* The SLA timer trigger will create the Escalation itself with reason `SLA breached`, and the failure path keeps its own trigger.
- *Human-only not enforced.* The `escalations` lane relies on its flow containing no model step. This is still not enforced; the gap is recorded here.
- *Halt-scoped grants (the "two signatures" scenario).* Not designed. `decidedBy` on `StepEvent` now makes per-client decision timing computable as an owner metric.

## Principles broken

None.

- **Principle 12.** States declare pending, waiting or terminal. `active` is a position a unit reaches only through a running attempt, which is what active means (holding capacity). The four positions and three outcomes stand, and the failure default stands.
- **Principle 11.** A declared metric and its defined metric share a name, but only the defined one is registered. The declared one is a reference resolved by name, like `H.env`.
- **Principle 15.** The `AccountLedger` is an append-only quota partition read by folding, with no cross-harness lock.
