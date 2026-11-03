# harness-dsl: ours-2, lane split

This child keeps the parent's ruled design. The operator is **split**: it picks the entity that does two jobs and splits it. The entity split is the **lane**.

In the parent, the lane was the pivot *kind × suppliers × store × handler*. It also turned flow outcomes into kind states, through the exit map, the retry policy and the exhaustion state. Principle 8 already names that second job as a noun, **handler**. The parent never gave it a builder.

This child makes the handler a pivot of its own. It also repairs three things:

- the adversary's three sharpest critiques;
- the worst scenario (4);
- the gaps found while writing scenarios 7 to 12. All of these are semantic, not type-level.

Each repair uses the smallest addition that keeps every principle.

## Entities

### Kinds (pure vocabulary, no backend)

| Builder | Produces |
|---|---|
| `H.work(name).schema(z).states(...)` | A work kind: its data shape and its named states. |
| `H.state(name).pending() / .active() / .waiting() / .terminal(verdict)` | A shareable state with its position. A terminal state carries `success`, `failure` or `neutral`, with no default. |
| `H.resource(name)` | A named shared thing: a file area, a database, a section, a category. |
| `H.halt(name).context(z).ask(...).decision(z)` | A named question with a typed context and a typed decision. |
| `H.memory(name).content(z).trust(...)` | A memory kind. The kernel owns the envelope. |
| `H.role(name)...` | What a model-backed participant knows and may do. |
| `H.skill(name)...` | A typed contract for one model call. |
| `H.facet(name)` | A metric dimension that is not a ledger column. |

### Instances (carry a backend)

- `H.account`
- `H.model`
- `H.runner.local` and `H.runner.ssh`
- `H.command`. A command is placed with `.runner(r)`, or with `.runners(policy)`.
- `H.job`

### Pivots

| Pivot | Connects | Produces |
|---|---|---|
| **pool** | accounts × policy | the account for one invocation |
| **seat** | role × models × choice policy | the model for one attempt. A seat with one model needs no policy; this is what the brief calls an agent. |
| **handler** | kind × flow × exit map × retry policy | the unit's next state after each attempt |
| **lane** | kind (through its handler) × suppliers × store × handler | the lane's units and attempts |
| **journal** | memory kind × store × recall | the recalled items |
| **grant** | client × operations | one client's rights |
| **trigger** | recorded source × consequences | recorded firings |
| **flow** | executables in order | the work an attempt performs |

### Policies

There are six policy constructors: `pool`, `seat`, `schedule`, `recall`, `halt` and `runner`.

- All six are deterministic.
- Every metric a policy reads is recorded on `policy.decided`, with its sample count.

### Vocabulary

| Word | Meaning |
|---|---|
| run | One process lifetime under one ledger claim. |
| attempt | One execution of a handler's flow for a unit. |
| step | One addressed node of a flow. |
| invocation | One model call. |
| agent | Not a builder. It is the word for a seat with one model. |

## The split: handler and lane

### Handler

A handler is built as a type-state chain:

```
H.handler('deliver-bug').of(bug).flow(deliver, u => ({ ...u.data, rounds: 3 })).exits({...}).retry({...})
```

- **`flow`** takes an optional map from unit to flow input. This is how one flow serves Bug (3 rounds) and Feature (5 rounds) without duplication.
- **`exits`** must map every exit label of the flow, either to a state of the kind or to `{ to, maxTimes, then }`.
- **`retry`** names `exhausted` in the kind's states.
- Only a handler that has passed through `retry` is a `Handler`. The parent's startup rule "a lane without retry" is therefore now a type error.

### Lane

`H.lane(name, handler)` takes the kind from the handler. The lane keeps only what concerns admission of its units and their events:

- suppliers and store;
- WIP, ceiling, unit ordering (`after`) and facets;
- the sources `enters`, `streak`, `due` and `updated`;
- the consequences `create`, `move`, `pause` and `resume`.

### Retry is per lane (principle 12)

A lane has exactly one handler, and each lane can have its own. In scenario 11, `contracts-eu` and `contracts-us` hold two handlers over the same flow and kind. Retry and exhaustion are still declared per lane, never on the kind.

## Rules (changes from the parent only)

### Scheduling reads lanes by identity

`SchedulePolicyInput` gives a policy two readers:

- `of(lane)` returns the lane's candidates.
- `units(lane, ...positions)` returns the lane's units at those positions.

A policy never compares `lane.name`.

### Runner choice is a policy

- `H.policy.runner(name, runners, decide)` returns an ordered list of runners.
- `Command.runners(policy)` places a command through that policy.
- The kernel uses the first listed runner that has a free slot.
- The choice is recorded on the step record, so a resumed step runs on the recorded runner.

### Create, dedup and move by key

- `lane.create(map, key)` keeps at most one non-terminal unit per key per lane. A duplicate firing is recorded as `trigger.deduplicated`.
- `lane.move(state, key)` moves the open unit that has that key.

### Move semantics

- **Moving a unit with an open attempt** cancels that attempt. The attempt's outcome is `cancelled`, and the trigger that caused it is recorded beside it. It is never counted as a failure of a model or a seat.
- **Moving a terminal unit to a non-terminal state** re-opens it. The unit keeps its id, and its earlier terminal entry stays in every metric.

### Unit updates are a source

- `lane.updated()` fires on every recorded `unit.updated`.
- Its payload carries the unit, its previous data, and the open attempt if there is one. The attempt's `step` is where it stands, including the halt it is blocked on.
- An update by itself never cancels anything. A trigger decides that.

### Pause carries its cause

The `lane.paused` event and `PauseView` carry the trigger, the metric, the value and the sample count.

### Metric addresses are entities

- `H.events.steps(flow, step)` takes a step name typed as a key of the flow.
- `H.events.decisions(halt, { credit })` attributes each decision to seats.

### Memory operations

`ops.memory` has three operations:

| Operation | Grants |
|---|---|
| `read` | Reading the named journals. |
| `write` | Writing to the named journals. |
| `curate` | Accepting, merging and dropping items. |

### Startup validation (`start()` rejects)

- duplicate names within an entity sort;
- an exit, retry or `after` target outside the handler's kind;
- a kind with two active states, or a terminal state without a verdict;
- a trigger, grant or journal that refers to an unregistered lane, journal or halt;
- a facet named like a column;
- a seat with more than one model and no policy, or a seat no pool serves;
- a role that recalls a memory kind no journal holds;
- a lease guard that is missing a leased resource;
- a duplicate step address;
- a batch without driver support;
- a runner policy that lists a runner it was not given.

## Rules fixed while writing scenarios 7 to 12

These rules change no types. Each was ambiguous enough that two readers could implement it two ways.

1. **A keyed supply creates or updates.**
   - A `Supply` with `.key(...)` creates a unit for an unseen key. For a key whose unit is open, it records `unit.updated` instead.
   - `.updatesOnly()` never creates. An unknown key is recorded and dropped.
   - Scenarios 2/9 (a customer reply on the same webhook) and 8 (tenancy status changes) rely on this.
2. **`due` re-arms on every update.**
   - The deadline function is re-evaluated on `unit.created`, `unit.updated` and `unit.moved`.
   - A changed deadline records `timer.armed` with the new time, and the old timer is disarmed.
   - `undefined` disarms the timer. No timer is armed for a terminal unit.
   - In scenario 9, the SLA extended through `ops.work.write` moves the breach, and the old deadline never fires.
3. **A blocked attempt makes its unit wait.**
   - While an attempt is blocked on a halt, a job or a batch, its unit stands at position `waiting` on the board and to the scheduler. The unit's state is unchanged, and the kind declares no state for this.
   - Such a unit holds no WIP and no runner slot.
   - When the attempt resumes, the unit re-enters the lane's WIP accounting. It waits as a pending candidate if the lane is full.
   - This is principle 12's "waiting on a human is the attempt's blocked state, recorded once" made visible (scenarios 11 and 12).
4. **Resolver sort is decided by the source.** A resolution is recorded with one of three resolver sorts:

   | Resolver sort | When |
   |---|---|
   | `clock` | `ops.resolve(halt).with(...)` fired from a halt clock (`halt.opened().after/at`). |
   | `policy` | `.by(policy)` returns a decision. |
   | `human` | A granted client resolves the halt. |

   - The first resolution wins. Clocks on a resolved halt are disarmed.
   - A policy that returns `undefined` leaves the halt open, and that is recorded too.
5. **`ExitBound`.** `{ to, maxTimes, then }` sends the unit to `to` at most `maxTimes` times over the unit's life. The next time, it sends the unit to `then`. Scenario 11's "after the second return, Declined" is `maxTimes: 1`.
6. **`lane.move` acts on its own lane only.** A payload unit from another lane is skipped, and the skip is recorded. One trigger may therefore carry the same move for several lanes, and nobody compares lane names.
7. **`flow.resources` applies from its position in the chain.**
   - Leases and memory scope take effect at the step after the declaration and hold until the attempt ends.
   - Declared first, they hold from the start. This is how scenario 9 scopes to the category that the classify step found.
8. **Loop iterations and batch items are addressed steps** (`rounds/2/build`).
   - On restart, completed iterations are not rerun. This is how scenario 12's backfill resumes at the next batch.
   - The address includes the flow hash, so a changed definition parks the attempt (`definitionChanged`).
9. **`ops.work.write` covers parked attempts.** It covers editing unit data and moving units. For a parked attempt (`interrupted`, `definitionChanged`, `stepFailure`), it also covers restarting from the top, continuing the parked step, or abandoning the attempt (`cancelled`). "Blocker resolution" in scenario 1 means this operation plus the `resolve` grants.
10. **Account identity across harnesses is the account's name within its quota partition.**
    - Two harnesses that declare `H.account('max-1', ...)` with the same partition share one quota series.
    - `maxQuotaShare` is per declaration, and therefore per harness.
    - A shared module exports a function that builds the accounts with a share, so no descriptor is derived and renamed (principle 11).

## What changed and why

1. **Handler split out of the lane** (operator; weakness 6). The parent's startup check "lane without retry" is now a type error.
2. **`lane.unitOf` replaced** by `SchedulePolicyInput.of(lane)` and `units(lane, ...positions)`.
3. **`H.agent` removed.** A seat with one model is the agent.
4. **Runner policy and `Command.runners`** added for scenario 4.
5. **Typed step addresses in metrics.**
6. **Decision credit to seats.**
7. **Pause and resume carry the crossing.**
8. **Dedup semantics of `create` and `move` by key are specified.**
9. **`Column` trimmed; `Effect 'external'` removed.**
10. **`LaneRef` moved to the kernel.**
11. **`lane.updated()` and `K.Updated<D>`.** Move semantics are specified as well.
12. **`H.ops.memory.read(...journals)`** (scenario 4).
13. **Ten semantic rules made explicit**, listed above under "Rules fixed while writing scenarios 7 to 12". Each is something scenarios 7 to 12 needed and the surface already typed but did not define:

    | Rule | Scenario that needed it |
    |---|---|
    | keyed-supply upsert | 8, 9 |
    | due re-arm | 9 |
    | waiting projection of blocked attempts | 11, 12 |
    | resolver sort by source | 11 |
    | `ExitBound` count | 11 |
    | lane-local move | 11 |
    | positional `resources` | 9 |
    | addressed iterations | 10, 12 |
    | parked-attempt operations under `work.write` | 10, 12 |
    | account identity in a shared partition | 7 |

    No declaration changed.

### Known open items

- Weaknesses 2, 5 and 8 are unchanged.
- Parallel halts in one attempt are not expressible.
- `Crossed.key` is a string. Scenario 9 maps it back to its resource by name. This is the one place a string meets a resource.

## Principles broken

none
