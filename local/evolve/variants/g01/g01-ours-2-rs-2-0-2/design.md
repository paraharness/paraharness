# harness-dsl: ours-2, net-shaped execution

This child keeps the owner's vocabulary: unit, attempt, step, state, lane, halt, trigger. It reads the execution model as a Petri net:

- states are **places**;
- units are **tokens**;
- attempts, moves and retries are **transitions**;
- WIP, runner slots and leases are **capacity places**.

Only one lens word enters the surface: **marking**, the count of tokens per lane and position that the scheduler reads. Everything else the lens gives is semantics, written down below.

## Entities

### Kinds (pure vocabulary, no backend)

| Builder | Produces |
|---|---|
| `H.work(name).schema(z).states(...)` | A work kind: its data shape and its places. |
| `H.state(name).pending() / .active() / .waiting() / .terminal(verdict)` | A place with its skeleton position. A terminal place carries `success`, `failure` or `neutral`, with no default. |
| `H.resource(name)` | A named shared thing. It is a capacity place for leases, and an identity for memory scope and metrics. |
| `H.halt(name).context(z).ask(...).decision(z)` | A named question. A flow places it at one or more addresses. |
| `H.memory(name).content(z).trust(...)` | A memory kind. The kernel owns the envelope. |
| `H.role(name)` | A prompt, intents, recall and record kinds, and plugins. |
| `H.skill(name)` | A typed contract for one model call. |
| `H.facet(name)` | A metric dimension that is not a ledger column. |

### Instances (carry a backend)

| Builder | Notes |
|---|---|
| `H.account`, `H.model` | As in the parent. |
| `H.runner.local / ssh` | A capacity place of `slots` tokens. |
| `H.command(name)` | A deterministic executable. `.effect('repeatable' \| 'unrepeatable')` sets its restart behaviour, and `.detect` probes whether it already ran. `.runner(r)` is the default runner. |
| `H.job(name)` | Submit, then collect by poll. |

### Pivots (each has a noun)

| Pivot | Connects | Produces |
|---|---|---|
| **pool** | accounts × policy × models served | the account for one invocation |
| **seat** `H.seat(name).role(r).models(...).policy(p?)` | role × models × choice policy | the model for one attempt. A seat with one model is what the brief calls an agent. |
| **lane** `H.lane(name).of(kind).from(...).store(s).handle(flow, arcs)` plus `wip`, `ceiling`, `after`, `facet`, `deadline` | kind × suppliers × store × handler | the lane's units and attempts |
| **journal** | memory kind × store × recall | recalled items |
| **grant** | client × operations | a client's rights |
| **trigger** `H.trigger(name).on(source).when(p).do(...)` | recorded source × consequences | recorded firings |
| **flow** | executables, halts, forks | the handler |

**Executables.** Every executable implements `Executable<I, O>`. There are four:

- a `Command`;
- a `Job`;
- a `Call`, made by `seat.call(skill)`;
- a `Batch`, made by `seat.batch(skill)`. A batch is a job whose submit and collect belong to the account driver. It is a step like any other, not a flow method.

**Sources** are top-level builders:

- `H.entered(lane, ...states)`
- `H.streak(lane, state, n, { by })`
- `H.due(lane)`
- `H.opened(halt)`, with `.after(d)` or `.at(fn)`
- `H.resolved(halt)`
- `H.crossing(metric, opts)`, with `.falls()` and `.rises()`

**Consequences** are top-level builders too:

- `H.create(lane, map, { key })`
- `H.move(lane, state, key?)`
- `H.pause(lane)` and `H.resume(lane)`
- `H.record(journal, map)`
- `H.run(command, map)`
- `H.resolve(halt, decide | policy)`

A lane is no longer a source or a consequence.

**Policies** have six constructors: `H.policy.pool`, `.seat`, `.schedule`, `.recall`, `.halt` and `.runner`. Every one is deterministic, and every metric it reads is recorded on `policy.decided` with its value and sample count.

### Words

- **run**: one process lifetime under one ledger claim.
- **attempt**: one firing of a lane's handler for a unit. Its outcome is succeeded, failed or cancelled.
- **step**: one addressed node of a flow (`flow/path`, plus the flow hash).
- **invocation**: one model call.
- **marking**: the scheduler's read-only view of how many units each lane holds at each position.

## Execution model (the net)

1. **Unit marking.** Each unit is one token in one of its kind's places. Its position is the place's position, with one refinement: an attempt whose every branch token sits at a waiting address (a halt, a job, a batch or a spawn) shows the unit at `waiting`.
2. **Attempt start** is a transition from a pending place to the kind's active place. It is enabled when all of these hold:
   - the lane is not paused;
   - the lane's WIP place has a free token;
   - every lease the flow selects is available. An exclusive lease takes the whole resource place; a shared lease takes one token and is inhibited by an exclusive holder;
   - every `after` predecessor is terminal at a success verdict;
   - the schedule policy ordered the unit this tick.
3. **Inside an attempt** the flow is a sub-net.
   - Each step is a transition that consumes a runner slot while it runs.
   - `parallel(name, { a, b })` forks one token per branch and joins when all branches complete. The fork and the join are recorded (`branch.forked`, `branch.joined`), and branch addresses are `name/branch/step`.
   - A token at a waiting address holds no runner slot and no WIP. When the address completes (a halt is resolved, a job is collected, the children of a spawn are terminal), the attempt becomes a `resuming` candidate. To continue, it takes a WIP token through the schedule policy, like any start.
4. **Attempt end** is a transition from the active place along an arc of the lane's `handle(flow, { exits, retry, input? })`:
   - an exit label leads to a place, or to a bound `{ to, maxTimes, then }`, which the kernel counts per unit;
   - a failure returns the unit to the pending place it started from, under `retry`;
   - exhaustion leads to `retry.exhausted`.

   Exits and retry are the arcs of one handler, so they now live in one argument and are typed against the flow's labels.
5. **External transitions.**
   - `H.move(lane, state, key?)` withdraws every token of the open attempt. The attempt is cancelled and the running step's signal is aborted. The unit moves to the place, and the move is recorded.
   - Operator moves are the same transition, made through `H.ops.work.write`.
6. **Signals.** A supplier offer whose key matches a non-terminal unit updates that unit. What happens next depends on where the attempt's tokens are:
   - If any branch token is running, the update is deferred to the next attempt. It is recorded and not lost.
   - If every token waits at a halt, the attempt is cancelled (`interrupted`) and the unit returns to pending, so the next attempt starts from the top.
   - If the unit sits in a waiting place, it returns to pending.
7. **Keys and deduplication.** A key names at most one non-terminal unit per lane.
   - `H.create` with a key that is open records `unit.deduplicated` and creates nothing.
   - Once that unit is terminal, the key may be reused: the next create, or the next supplier offer, makes a new unit with a new id.
   - This is scenario 9's "one Audit per category while open", and scenario 3's weekly re-opening of a reported Topic.
8. **Time.**
   - `lane.deadline(fn)` arms one timer per unit. The timer re-arms on every recorded update, so an extended SLA disarms the old deadline; both `timer.disarmed` and `timer.armed` are recorded. A deadline function that returns `undefined` disarms the timer.
   - `H.due(lane)` fires on the timer.
   - Halt clocks run from the recorded `halt.opened`.
   - A schedule candidate carries its `deadline`, so ordering by time to breach needs no unit-data access.
9. **Pause.**
   - `H.pause(lane)` puts an inhibitor on the lane's start transition. Running attempts finish.
   - The `lane.paused` event records the firing trigger and its source payload. When the payload is a crossing, its `value` and `samples` become the board's `PauseView`. There is no free-text reason.

## Rules

- **Scheduler.** `harness.schedule(policy)` (`H.scheduler()` is removed). The policy receives:
  - `candidates`, each with its unit, the lane descriptor itself (compare by identity), the waiting time, the deadline and the `resuming` flag;
  - `running`, the current attempts;
  - `marking`, with `count(lane, ...positions)` and `paused(lane)`.

  It returns an ordered subset. "No new Backup while an Incident is active" reads `marking.count(incidents, 'active', 'waiting') > 0`.
- **Runner choice.** A step's runner may be a `RunnerPolicy` from `H.policy.runner(name, runners, decide)`.
  - It receives the typed flow state and each candidate runner with its free slots.
  - It returns runners in order of preference. The chosen runner is recorded with the decision.
  - One flow and one lane therefore serve two backup hosts.
- **Metrics.**
  - Columns are exactly principle 18's: `kind`, `lane`, `state`, `model`, `seat`, `resource` and `halt`. The resolver sort is a filter on `decisions`, not a column.
  - `where.seat` / `where.model` select events whose own column matches, or whose attempt invoked that seat on that model.
  - `H.events.steps(flow, step)` takes the flow entity and a step name typed from that flow's steps, so a renamed step is a compile error.
  - `H.events.credits(halt, d => seats)` emits one event per seat a decision credits, with the `seat` column set. It is how scenario 6 keys "acted on" by seat.
- **Halts.**
  - The three resolver sorts are human, policy and clock, as in the parent.
  - Two halts may be open at once in parallel branches. Each has its own address, its own clock and its own grant.
- **Resumption.** Replay over the memoizing ledger, as in the parent.
  - Completed addresses return their recorded output.
  - The address that was started at the crash follows its effect:
    - a `repeatable` command reruns;
    - an `unrepeatable` command calls `detect`, and otherwise blocks the attempt (`interrupted`);
    - a `Call` asks its driver to `recover`;
    - a `Job` or `Batch` with a recorded ref is collected;
    - a halt reads its resolution;
    - a spawn reads its children.
  - Fork and join records restore every branch token.
  - A flow-hash mismatch blocks the attempt (`definitionChanged`).
  - Ledger claims are exclusive and taken over only from a stale holder.
  - The author writes nothing for any of this.
- **Quota.** Accounts name a `QuotaPartition`. Consumption is append-only and folded at read time.
- **Startup validation.** `start()` rejects all of the following:
  - duplicate names within an entity sort;
  - an exit label or retry target outside the lane's kind;
  - a kind with two active places, or a terminal place without a verdict;
  - a lane, journal or halt referenced by a trigger, spawn, grant or observer but not registered;
  - a facet named like a column;
  - a seat model no registered pool serves;
  - a recalled memory kind no journal holds;
  - a resource leased or scoped by a flow that no `fileLeaseGuard` maps, when that flow's roles use one;
  - a step address used twice;
  - a `Batch` whose driver lacks `submitBatch`;
  - a runner policy listing a runner whose command runs elsewhere;
  - a `deadline` source on a lane without `deadline`;
  - a `sqlite.reopen` supplier whose path is not the path of the store of the lane it feeds.

## What changed and why

1. **Parallel branches** (`flow.parallel`, the Petri fork and join). The adversary's scenario 13 needs two halts open at once. Branch outputs are typed per branch.
2. **Runner policy** (`H.policy.runner`, step option `runner`). It answers the adversary's critique of scenario 4 (one lane per host) and scenario 13 (a host chosen per attempt).
   - Scenario 4 now has one Backup lane, one flow and one set of triggers.
3. **Marking in the schedule input.** It replaces the opened-minus-closed metric arithmetic that faked preemption.
   - Lane order is by descriptor identity, never by `lane.name`.
4. **Lane split** (critique 3).
   - Sources and consequences move to `H.*` top-level builders.
   - `exits` and `retry` move into `handle(flow, arcs)` as the handler's arcs.
   - `unitOf` is removed: candidates carry `deadline`, and `UnitView.facet(f)` reads facets by entity.
   - The lane keeps 9 methods, down from about 21.
5. **Pause records its cause.** The board's `PauseView` carries the trigger's crossing value and sample count. `pause(reason: string)` is gone.
6. **Key semantics are specified** (rule 7 of the execution model).
7. **`H.agent` is removed** (critique 2, weakness 1). A single-model seat is the agent. There is one noun, one builder, and metrics key on the seat.
8. **Column is trimmed** to principle 18's seven columns. The `external` effect is removed because no scenario used it.
9. **Step metrics address by entity.** They take `H.events.steps(flow, step)` with a typed step name, not a bare string (critique 1).
10. **A/B keys on the seat.** `H.events.credits` attributes editor decisions to seats. The scenario 6 policy reads `where: { seat }`, so a model swap keeps the series.
11. **Batch is a step**, made by `seat.batch(skill)` (weakness 2). This removes `flow.batch`.
12. **`H.scheduler()` is replaced by `harness.schedule(policy)`.** It was an entity with one method.
13. **`lane.deadline` plus `H.due(lane)`** replace `lane.due(fn)`. The deadline is now visible to the scheduler, and its re-arming is recorded.
14. **`sqlite.reopen({ path, cron, schema, where })`** (adapter only, no kernel change). This comes from scenario 3: a weekly schedule re-opens topics tagged `recurring`.
    - A plain `supply.schedule` cannot see which units exist, because its context resolves settings only. The re-opening needs to read the first-party store.
    - The supplier belongs to the store's own adapter, so the kernel `Store` interface stays load/save. It offers each matching stored topic under its existing key.
    - Rule 7 then makes a new unit only when the previous one is terminal.
    - Deleting the sqlite adapter deletes this supplier with it, so the delete test still passes.
15. **`H.ops.memory.read(...journals)`.** This comes from scenario 4, where a journal of operational experience is read by the operator and by no prompt.
    - `write` and `curate` both grant more than reading, so neither is the honest grant for a read-only client.
    - Reading memory is an operation like any other, granted per journal.

## Principles broken

none
