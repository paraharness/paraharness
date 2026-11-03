# harness-dsl, durable lens, generation 3 (rename: journal → corpus)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child of `g02-durable-le-0-2-0` does two things:

- It renames the weakest noun in the set: the **journal** pivot becomes the **corpus**.
- It repairs the adversary's three sharpest critiques of the parent: the retry policy that did not exist, the stringly store maps, and the `during` map that let positions lie.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a given key.
  - `UnitView.attempts` counts its ended attempts.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: succeeded, failed or cancelled.
  - While open, it is *running* (in a running step, holding a slot) or *blocked* (in a blocking step, holding nothing).
  - `blockedOn` is one of `decision`, `timer`, `children`, `batch` or `recovery`.
- **Step**: a named node of a flow. There are two sorts:
  - **Running steps**: `step`.
  - **Blocking steps**: `halt`, `wait`, `spawn` and `batch`.

  `loop` and `exit` are structure, not steps.
- **Invocation**: one call of an executable within a step. A retry is a new invocation.

"Run" is not used.

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state with its position.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict is required.
- **The lane's map is total and position-honest.**
  - `exits` maps every flow exit to a state.
  - `during` maps every running step to an `active` state (`ActiveState<S>`) and every blocking step to a `waiting` state (`WaitingState<S>`). Both are compile-checked, as type errors.
  - So a unit whose attempt is blocked is at `waiting`.
  - A unit whose attempt is running is at `active`.
  - Only `pending` units are schedulable.
  - Board and scheduler read positions, and positions never contradict attempt status.
- **Failure default (now real).**
  - A failed attempt returns the unit to its pending state under the lane's **retry policy**: `Lane.retry({ maxAttempts, backoff, initialDelayMs })`.
    - The default is `{ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 }`.
    - The next attempt carries `notBefore` and is recorded as `retryScheduled`.
  - When the budget is spent, the unit moves to the kind's `onAttemptFailed` state, recorded as `retriesExhausted`.
  - A kind used by a lane must declare `onAttemptFailed`. The kernel refuses to start otherwise, because an unbounded loop is the defect the rule exists to prevent.
  - `Retry` is one shape used in two places: step invocations and lane attempts.
- **Cancellation.** `onCancelled(state)` is where `H.cancel` takes the unit.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state and signal;
- role (intents);
- **resource** and **skill** (`H.resource`, `H.skill`, refined with `.of(value)`);
- memory kind (`H.memory(name, trust)`, where trust is `experience`, `taste` or `reference`);
- command, flow and operation.

**Instances** (carry a backend): account, model, **embedder**, runner, workspace, supplier, store, memory store, ledger, client and observer.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store (with state map) × flow (exit and step maps, params) × retry | managed units |
| Agent | role × model or model policy × pool | a model-call executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| **Corpus** | memory kind × memory store × recall × reader and recorder roles | a recallable, curated body of memory items |
| Crossing | metric × band (enter and exit thresholds, window, minimum samples) | recorded entered and exited edges per group |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, corpora, triggers, metrics, scheduler, clients, observers | a running harness |

## Rules

1. **Flows know no states.** One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`).
2. **Attempt outcome follows the kind's verdicts.** An attempt fails when:
   - a step fails after its retries;
   - its exit maps to a `failure` terminal; or
   - a `fail` ceiling is exceeded.

   Otherwise it succeeds. `H.cancel`, `restart` and `enter`-terminal cancel it. A crash is never an outcome.
3. **Signals.**
   - A supplier route may `create` a unit or `signal` one, by key or by predicate.
   - `Lane.on(signal, { update, restart, enter })` reacts to a signal.
   - An unhandled signal is a startup error.
4. **Creation deduplicates by key**, recorded as `createSkipped`.
5. **Timers re-arm** after `attributesUpdated`, recorded as `timerCleared('rearmed')` followed by `timerSet`. An old deadline never fires.
6. **Trigger sources.** All of them fire only from recorded ledger events, and each firing is recorded:
   - `transition`;
   - `pattern`;
   - `timer`;
   - `step`;
   - `invocation`;
   - `entered(crossing)` and `exited(crossing)`.

   **Crossings:**
   - A crossing is a pivot. It watches a rate or total metric per group with hysteresis and appends a `crossing` event per edge.
   - A group cannot enter again until it has exited.
   - The two edges are two sources, so no consequence filters on an edge field.
7. **Consequences:**
   - `create`;
   - `signal`;
   - `record` into a corpus;
   - `pause` and `resume` a lane, recorded with the reason (`lanePaused`, `laneResumed`).

   A consequence returning `undefined` is skipped and recorded as skipped.
8. **Steps.**
   - Step retry uses the `Retry` shape.
   - `acceptExitCodes` widens success; accepted codes are output.
   - Runner preflight runs before each command placed on that runner.
   - **`batch`:**
     - `Flow.batch(name, agent, tasks)` submits one cloud batch and blocks on `batch`.
     - Invocations are recorded with `batch: true` and priced by the driver at the batch rate.
     - This replaces the parent's `Agent.batch()`. A batch is a way of stepping, not a different agent.
9. **Determinism.** Exit predicates, loop bounds, `halt.skip`, model, account and scheduler choices are each recorded once as a `policyDecision` and replayed.
10. **Capacity.**
    - Only running attempts hold slots, WIP and account reservations.
    - `AdmitCtx.count(lane, ...positions)` counts units at those positions, or every non-terminal unit when no position is given.
    - `rank` is ascending.
11. **Cost ceiling.**
    - `onExceed: 'halt'` blocks the attempt on a `CeilingDecision`.
    - `onExceed: 'fail'` fails the attempt and **exhausts the retry budget at once**, because a spent unit cannot spend less on a retry. The unit moves to the kind's `onAttemptFailed` state.
    - This closes the parent's ceiling livelock.
12. **Metrics.**
    - `.samples` gives a rate; `.amounts` gives a total. Every figure carries `samples`.
    - `TransitionEvent.attempt` carries `durationMs` and `costUsd` of the attempt that caused the transition. "Mean cost of succeeded attempts" is therefore an amounts metric of `attempt.costUsd`, not of unit spend.
    - Built-ins:
      - `outcomes` (unit verdicts, `byState`);
      - `attempts` (by kind and model);
      - `paused` (time per lane).
13. **Quota** is a partition of the ledger: append-only `QuotaEvent`s, folded at read time. `sqlite.ledger({ quotaPath })` shares that partition across harnesses without a lock.
14. **Memory.**
    - **Envelope and scope.**
      - The kernel owns the envelope.
      - Scope names entities: kinds, roles, `Skill` and `Resource`. A refined entity (`section.of('sports')`) matches items scoped to itself or to its parent, and the more specific match ranks higher.
    - **Recall** is deterministic:
      - it filters by scope and status;
      - it ranks by specificity, or by the memory store's similarity score (computed by an `Embedder` instance);
      - it breaks ties by track record.
    - **Reads and writes.**
      - Reads take the union of the corpora visible to a role.
      - Each write names one corpus. The writer is a recorder role, a trigger, or a client holding `memoryWrite`.
    - **Curation.** `memoryCurate` covers accept, merge and drop.
15. **Restart.** The author writes no resumption code. The mechanisms are unchanged from the parent:
    - writer claim with TTL;
    - completed steps replayed;
    - `afterCrash` set to `rerun`, `park` with `alreadyDone`, or `askDriver`;
    - decisions appended without the writer claim;
    - batches collected by id;
    - children read from their positions;
    - a `flowVersion` mismatch parks the attempt as `definitionChanged`.
16. **Control API.**
    - Clients are granted operations.
    - Each client serves at its harness's name. The supervisor no longer carries a free-string `endpoint`.
17. **Startup validation.** `start()` fails on any of:
    - duplicate names;
    - an unexited flow;
    - an unregistered lane, corpus or metric;
    - an agent without a pool;
    - a model whose driver serves none of the pool's accounts;
    - a kind in a lane without `onAttemptFailed`;
    - a cancelled kind with no `onCancelled` or reaction;
    - an unhandled signal;
    - an `askDriver` step on a driver without `session`;
    - a `batch` step on a driver without `submitBatch`;
    - a similarity corpus on a memory store without `similar`.

## What changed and why

### Rename (operator): Journal → Corpus

- **Why journal was weakest.**
  - A journal is a dated, append-only log of what happened.
  - Principle 14 forbids exactly that: memory is forward-phrased, never history.
  - Its items are also curated: accepted, merged, dropped and retired. Nobody curates a journal.
  - Weakness 17 already named it.
- **Why corpus.** The pivot produces a body of texts that is curated, scoped and recalled. That is what "corpus" means. The alternatives each fail:
  - "Library" collides with principle 16's "library, not a harness".
  - "Archive" implies history.
  - "Collection" is a database word, and would leak a backend into vocabulary.
- **Touched everywhere:**
  - `H.corpus`, `Corpus` and `Harness.corpora`;
  - `Trigger.record(corpus, …)`;
  - `MemoryItem.corpus`, `MemoryFilter.corpus` and `ModelResponse.recorded[].corpus`.
- **Memory kind.** The memory kind is unchanged in name, but gains a third trust, `reference`, for established knowledge such as research findings. Reference items are neither fallible advice (experience) nor preference (taste). This answers the critique that findings were forced into `experience`.

### Critique 1: the retry policy did not exist

- `Lane.retry(Retry)` now exists, and the failure default is bounded.
- `onAttemptFailed` is redefined as the move once retries are spent. Adversary scenario 11's give-up after three attempts with delays of 10 and 40 minutes is now expressible: `retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000 })` with `onAttemptFailed(GaveUp)`.
- `UnitView.attempts` is restored, because give-up counts need it: "gave up after exactly two retries" is an amounts metric over transitions to `GaveUp` grouped by `unit.attempts`.
- Ceiling `fail` exhausts at once, which fixes the scenario 3 livelock.
- The scenario 3 projection now reads `attempt.costUsd`.

### Critique 2: stringly store maps and stringly scope

- **Stores.**
  - `Store<V>` declares the backend's own state vocabulary: `LinearStatus`, `ZendeskStatus`, `ContentfulStatus`.
  - `Lane.store(store, states)` requires a map that is total over the kind's state names, `{ [K in S['name']]: V }`, compile-checked on the pivot, never on the instance. Renaming a state is now a compile error.
  - Stores with no external vocabulary (sqlite, folder frontmatter) are `Store<never>` and take no map. The overloads make passing a map to one, or omitting the map from the other, a type error.
- **Scope.**
  - Scope and agent tasks take `Resource` and `Skill` entities (weakness 4), refined by `.of()` for runtime values such as a classifier's category.
  - Each refinement is a renamed descriptor (`category/billing`), so principle 11 holds.
- **Supervisor endpoint.** The free-string `endpoint` is removed.
- **Embedder.** The raw embedding-model string is now an `Embedder` instance (`harness-dsl/voyage`), passed to `pgvector.memoryStore`.

### Critique 3: `during` made positions lie

- Flows now track running and blocking step names separately (`N`, `B`).
- `during` is total and sorted by step type:
  - running steps map to `active` states;
  - halts, waits, spawns and batches map to `waiting` states.

  So:
  - an `AwaitingApproval` unit is waiting and holds nothing;
  - an Experiment between hourly measurements is waiting;
  - an Epic delivering through children is waiting.
- `AdmitCtx.active` and `AdmitCtx.pending` are replaced by `count(lane, ...positions)`. Scenario 4's gate becomes `count(incidents) === 0`, which counts every non-terminal incident, including one still `Open`.
- Crossings are now a pivot with two sources, `entered` and `exited`. The edge filter is no longer hand-written into every consequence lambda.
- Crossings over totals are allowed. This was one startup check fewer, and it lets adversary scenario 11 pause a lane on dollar spend.

### Not addressed

Adversary scenario 11's midnight resume needs a lane-scoped time source. It is not in the battery, so by principle 21 no `when.tick` was added.

### Surface delta

**Added:**
- `Lane.retry`;
- `Flow.batch`;
- `H.resource`, `H.skill`;
- `H.crossing`, `when.entered`, `when.exited`;
- the `Embedder` and `Store<V>` mapping;
- the `reference` trust;
- `UnitView.attempts` and `notBefore`.

**Removed:**
- `Agent.batch`;
- `when.crossing`;
- `AdmitCtx.active` and `AdmitCtx.pending`;
- the supervisor `endpoint`;
- `CrossingEvent.edge`;
- the free-string store map and the embedding-model string.

## Principles broken

None.

Principle 12 reading: "a kind may declare a move for a failure". This variant requires the move on any kind placed in a lane, because the default (pending under a retry policy) is only honest if the policy is finite, and a finite policy needs an end. Retries remain the default. The declared move is the end of the default, not a replacement for it.
