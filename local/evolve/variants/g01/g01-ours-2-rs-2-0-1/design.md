# harness-dsl: ours-2, agent deleted

This child is the parent with one entity removed: **`H.agent`**. A seat with one model is now the only way to name "role × model". The repairs the adversary demanded sit on top of that deletion. Each repair is listed under *What changed and why*.

## Entities

### Kinds (pure vocabulary, no backend)

| Builder | Produces |
|---|---|
| `H.work(name).schema(z).states(...)` | A work kind: its data shape and its named states. |
| `H.state(name).pending() / .active() / .waiting() / .terminal(verdict)` | A shareable state with its position. A terminal state carries a verdict (`success`, `failure` or `neutral`). There is no default verdict. |
| `H.resource(name)` | A named shared thing. |
| `H.halt(name).context(z).ask(...).decision(z)` | A named question with a typed context and a typed decision. |
| `H.memory(name).content(z).trust(...)` | A memory kind. The kernel owns the envelope. |
| `H.role(name)` | What an agent knows and may do. |
| `H.skill(name)` | A typed contract for one model call. |
| `H.facet(name)` | A metric dimension that is not a column. |

### Instances (each carries a backend)

| Instance | Notes |
|---|---|
| `H.account` | Names its quota partition. |
| `H.model` | Carries pricing. |
| `H.runner.local / .ssh` | Provides slots, which are capacity. |
| `H.command` | `.runner(r)` takes a fixed runner, or a deterministic selector `(input) => Runner`. |
| `H.job` | Submitted, then collected by poll. Holds no slot and no WIP while it runs. |

### Pivots (each has a noun)

| Pivot | Connects | Produces |
|---|---|---|
| **pool** | accounts × policy | the account for one invocation |
| **seat** `H.seat(name).role(r).models(...).policy(p?)` | role × models × choice policy | the model for one attempt |
| **lane** `H.lane(name).of(kind).from(...).store(s).handle(flow, map?).exits({...})` | work kind × suppliers × store × handler | the lane's units and attempts |
| **journal** | memory kind × store × recall | the recalled items for one invocation |
| **grant** | client × operations | one client's rights |
| **trigger** | source × consequences | recorded firings |
| **flow** | executables in order | a lane's handler |

Notes on seats:
- A seat without `.policy` uses its first model.
- A seat with one model is what the parent called an agent.
- A call is `seat.call(skill)`.

### Words

- **run**: one process lifetime under one ledger claim.
- **attempt**: one execution of a lane's flow for one unit. Its outcome is succeeded, failed or cancelled.
- **step**: one addressed node of a flow. Its address is `flowName/path` plus the flow hash, and it is used only for resumption.
- **execution**: one run of an executable entity at a step. Metrics address executions by the executable entity, never by the step name.
- **invocation**: one model call. It is the execution of a `Call`.

## Rules

### Lifecycle and exits

A flow names no state. It ends in `.exit(label)`. The lane's `exits` map covers every flow label plus the reserved label `failed`:

```ts
.exits({ delivered: done, roundsExhausted: ownerReview,
         failed: { tries: 2, backoff: 'exponential', delaySeconds: 300, then: abandoned } })
```

Rules for the map:
- Every entry is a state of the kind, or a re-entry bound `{ to, maxTimes, then }`.
  - The first `maxTimes` exits under the label go to `to`.
  - The next one goes to `then`.
- `failed` is required by the type.
  - `tries` counts attempts in total, the first included.
  - A failed attempt leaves the unit pending under that retry.
  - When the tries are exhausted, the unit moves to `then`. `then` may be a non-terminal state.
- A missing failure exit is therefore a compile error, no longer a startup error.
- A flow label named `failed` is a startup error.

Blocked is an attempt state, with these reasons: `decision`, `stepFailure`, `budget`, `interrupted`, `definitionChanged`.
- A blocked attempt holds no slot and no WIP.
- Its unit shows at `waiting`.
- The same holds while a job, a batch or a spawn is outstanding.

Signals arrive as an offer whose key matches an open unit. What happens depends on where the unit is:

| Where the unit is | What the signal does |
|---|---|
| A step is running | The update is deferred. It applies when the step ends. If the attempt then blocks on a halt, the blocked-on-a-halt rule applies. Otherwise the update reaches the next attempt. |
| Blocked on a halt | The attempt is cancelled (`interrupted`) and the unit is re-queued. |
| At a waiting state | The unit is re-queued at the kind's pending state. |

Other lane rules:
- `lane.move(state)` is the one consequence that moves a unit from outside. A move of a unit with a blocked attempt cancels that attempt.
- `lane.after(fn, { failed })` orders units against their predecessor.

### Unit keys and deduplication

- A unit key is unique among the lane's **non-terminal** units.
- An offer, or a `create(map, key)`, whose key matches a non-terminal unit does not create a unit. A supplier offer updates that unit. A trigger's `create` records `unit.deduplicated` against it.
- A key that matches only terminal units creates a new unit.
- `create` without a key never deduplicates.
- Operator units take the key of `supply.manual<D>().key(fn)`. Without a key function, each operator unit gets a fresh key.
- An `updatesOnly()` supply never creates a unit. An offer whose key matches no open unit is recorded and dropped.

### Supply over known units

- A supplier opens with the lane's latest unit per key (`known`), each with its state and position.
- A schedule can re-offer them.
  - A re-offered terminal key creates a new unit, as when re-opening recurring topics.
  - A re-offered open key updates that unit, which re-queues it if it is waiting. This is how hourly experiment ticks and monthly tenancy reviews are expressed.
- No supplier writes state and no flow reads the ledger.

### Deadlines

- `lane.deadline(fn)` declares each unit's deadline from its data.
- The deadline is re-armed on every recorded update, and the superseded timer is cancelled on the ledger.
- `lane.overdue()` is the source that fires when a deadline passes.
- The deadline also appears on every scheduling candidate as `candidate.unit.deadline`.

### Scheduling

A schedule policy receives:
- `candidates`
- `running`
- `load(lane)`, which gives pending, active and waiting counts per lane, plus whether the lane is paused
- `metrics` and `now`

Candidates expose:
- `candidate.unit.facet(f)`: facet values by entity.
- `candidate.lane`: the registered lane descriptor itself, so policies compare lanes by identity.

### Halts

- `.halt(stepName, halt, context)`: the address and the entity are distinct.
- There are three kinds of resolver: human (by grant), policy (`resolve(halt).by(policy)`) and clock (`resolve(halt).with(fn)` on `opened().after(d)` or `.at(fn)`).
- Each resolution records its resolver sort and its client entity.
- A clock resolution does not cancel the attempt.
- A clock whose halt was already resolved records nothing and does nothing.

### Policies

- There are five typed constructors.
- Every metric read is recorded with its value and sample count on `policy.decided`.

### Metrics

- Dimensions are the seven columns of principle 18 (`kind, lane, state, model, seat, resource, halt`) or declared facets. Resolver sort is a filter on decision event sets, not a dimension.
- `H.events.executions(executable, { outcome })` addresses an executable by entity.
- `H.events.decisions(halt, { match, credit, resolver })`:
  - `credit(decision)` returns the seats the decision credits.
  - On a credited set, `where: { seat }` keeps the decisions crediting that seat.
  - On any other set, `where: { seat }` keeps events of attempts in which the seat was invoked.
- When `where` names both `seat` and `model`, the model means the model that seat ran in that attempt.
- Every reading is `{ value, samples }`.
- `crossing({ below, above, samples, window, by })` gives `falls()` and `rises()`. It fires once per band entry per key.

### Lane pause

- `lane.pause()` and `lane.resume()` are consequences of a `Crossed` payload only.
- `lane.paused` and `lane.resumed` record the metric, value, samples and key of the crossing that caused them.
- The board's `paused` field carries the same record.

### Operations

- `H.ops.work.write` lets a client create, update and move units.
- It also lets a client restart a blocked attempt from the top, or abandon it. These are the supervisor's only answers to `interrupted` and `definitionChanged`.
- Restarting from the top opens a new attempt.
- Abandoning cancels the attempt and applies the lane's `failed` exit.

### Memory, leases, quota, resumption, startup validation

These are as in the parent.

**Memory and leases**
- Memory capture is a trigger consequence.
- Curation is an operation.
- Reading a journal is an operation (`ops.memory.read`).
- Leases are ledger state.

**Quota**
- Quota is an append-only partition that the account names.
- The quota partition's events carry the account name.
- Two harnesses that declare an account with the same name and the same partition share its window.
- The descriptor rename rule holds per harness. Two harnesses may each hold one `claude-subscription-1` with a different `maxQuotaShare`.

**Resumption**
- Resumption is replay over a memoizing ledger.
- The ledger has a single-writer claim, with takeover of a stale holder.
- Restart behaviour is declared per effect: `repeatable` reruns; `unrepeatable` runs `detect`, or blocks with `interrupted`; a call runs the driver's `recover`; a job, batch or spawn is collected.
- A changed hash at a recorded address blocks the attempt with `definitionChanged`.

**Startup validation** rejects:
- duplicate names in one sort;
- exit targets outside the kind;
- a flow label `failed`;
- a kind with two active states;
- a terminal state without a verdict;
- references to unregistered lanes, journals or halts;
- a facet named like a column;
- a seat with no models, or with models no pool serves;
- a role recalling an unheld memory kind;
- a `fileLeaseGuard` missing a resource that a flow leases;
- duplicate step addresses;
- a batch on a driver without batch support;
- a runner selector returning an unregistered runner. This is checked per execution and blocks the attempt with `stepFailure`.

## What changed and why

1. **Deleted `H.agent`** (operator, weakness 1, critique 2).
   - An agent was already typed `EntityRef<'seat'>`, so two builders named one pivot. That broke principle 22.
   - Every scenario now writes `H.seat(n).role(r).models(m)`.
   - `Seat.policy` is optional: with no policy the first model is used.
2. **Metric addresses are entities** (critique 1).
   - `H.events.steps('name')` is replaced by `H.events.executions(executable)`.
   - Scenario 6's A/B credits seats through `decisions(halt, { credit })`.
3. **`Column` trimmed** to principle 18's seven. `resolver` is an event-set filter only.
4. **`Effect: 'external'` removed** (principle 21). No scenario used it.
5. **Lane slimmed** (weakness 6).
   - `retry` folded into `exits` as the required `failed` exit.
   - `unitOf` removed.
   - `due(fn)` split into the setting `deadline(fn)` and the source `overdue()`.
6. **Pause records the crossing.** `pause()` and `resume()` take a `Crossed` payload.
7. **Dedup semantics specified.** Keys are unique among non-terminal units.
8. **Scenario 4 repairs.**
   - `load(lane)` in the schedule input.
   - Lanes compared by identity.
   - The `Command.runner` selector.
9. **Concurrent halts within one attempt** remain unexpressed; no battery scenario needs them.
10. **Schedules see known units** (scenario 3).
    - Re-opening topics tagged "recurring" every week needs the schedule to know which topics exist. No supplier could see them, and hard-coding the list would lie about the requirement.
    - `supply.schedule`'s `units` callback now receives `known`.
    - The kernel's `Supplier.open` context gains `known()`.
    - Re-offered keys create new units under the existing dedup rule, so no new entity is needed.
11. **`ops.memory.read(...journals)`** (scenario 4).
    - A journal that no agent recalls is read by the supervisor, here a plain-HTTP operator.
    - Grants could write and curate memory, but not read it, and `telemetry.read` does not cover memory items.
12. **`known` carries every unit's latest record, not only terminal ones** (scenario 8).
    - An Experiment ticks every hour and a Tenancy is reviewed every month. Both are open units resting at a waiting state.
    - A schedule that re-offers their keys re-queues them through the existing signal rule. This needs no timer entity and no ledger read in a flow.
    - With terminal-only `known`, the schedule could not see which units to tick. Scenario 3 filters `known` to terminal units itself.
13. **`supply.manual<D = never>()`** (scenario 8).
    - Updates from a schedule or a webhook find their unit by key, so operator-created units must be keyed by the same function.
    - `manual()` stays `Supply<never>` by default, so existing scenarios are unchanged.
    - `manual<D>().key(fn)` keys operator units.
14. **Deferred updates specified** (scenario 11).
    - A redline that arrives while `draft` runs is applied when the step ends.
    - If the attempt then halts at `counsel`, the redline interrupts it and the unit re-enters at `draft`.
    - So the redline is neither lost nor fatal, and no flow code handles it.
15. **Restart and abandon named under `work.write`** (scenario 10).
    - These are the operations the supervisor uses on an attempt parked with `interrupted` or `definitionChanged`.
    - No new operation is added.
16. **Rename rule is per harness** (scenario 7).
    - Two harness files that build the same account with different shares each hold one descriptor of that name.
    - The shared quota partition folds by account name.

## Principles broken

none
