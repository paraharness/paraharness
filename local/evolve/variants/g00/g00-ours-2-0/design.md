# harness-dsl: ours-2, materialized

This is the owner's ruled design of 2026-11-01, written as a surface that compiles. Where the battery forced a change, the change is the smallest one that keeps every principle. Each change is listed under *What changed and why*.

## Entities

### Kinds (pure vocabulary, no backend)

| Builder | Produces |
|---|---|
| `H.work(name).schema(z).states(...)` | A work kind: its data shape and its named states. Nothing else. |
| `H.state(name).pending() / .active() / .waiting() / .terminal(verdict)` | A shareable state with its skeleton position. A terminal state also carries its verdict: `success`, `failure` or `neutral`, with no default. A kind has at most one active state. |
| `H.resource(name)` | A named shared thing: a file area, a database, a section or a host. |
| `H.halt(name).context(z).ask(text \| fn).decision(z)` | A named question with a typed context and a decision schema. |
| `H.memory(name).content(z).trust('experience' \| 'taste')` | A memory kind. The kernel owns the envelope: id, created, status, and `when: { kinds, roles, skills, resources }`, where every field is an entity reference. |
| `H.role(name).prompt / promptFile / intents / recall / record / use` | What an agent knows and may do. |
| `H.skill(name).input(z).output(z).prompt(fn).assert(fn).maxRetries(n)` | A typed contract for one model call. |
| `H.facet(name)` | A metric dimension that is not a ledger column. |

### Instances (carry a backend)

| Builder | Backend |
|---|---|
| `H.account(name, driver).maxQuotaShare(r).quota(partition)` | A `ModelDriver`. Quota lives in a `QuotaPartition` that the account names. |
| `H.model(id, options).pricing(pricing)` | A `Pricing`. A model is not bound to an account or a pool. |
| `H.runner.local(name, { slots })`, `H.runner.ssh(name, {...})`, `.env({...})` | A `Runner`. Slots are capacity. |
| `H.command(name).input.output.runner.effect.detect.run` | A deterministic executable. `effect` declares its restart behaviour. |
| `H.job(name).input.output.submit.collect.poll` | An external job: submitted, then collected by poll. It holds no slot and no WIP while it runs. |

### Pivots (each has a noun)

| Pivot | Connects | Produces |
|---|---|---|
| **pool** `H.pool(name, accounts).serves(...).policy(p).fallback(a)` | accounts × policy × models served | the account for one invocation |
| **seat** `H.seat(name).role(r).models(...).policy(p)` | role × models × choice policy | the model for one attempt; metrics key on the seat |
| **agent** `H.agent(name).role(r).model(m)` | a seat with one model | the same entity sort (`seat`), so metrics do not change if it later becomes a seat |
| **lane** `H.lane(name).of(kind).from(...).store(s).handle(flow, map?).exits({...}).retry({...}).wip(n).ceiling({...}).facet(f, fn).after(fn, {...})` | work kind × suppliers × store × handler | the lane's units and attempts |
| **journal** `H.journal(name).of(memoryKind).store(ms).recall(policy)` | memory kind × store × recall | the recalled items for one invocation |
| **grant** `H.grant(client, ...operations)` | client × operations | one client's rights on the control API |
| **trigger** `H.trigger(name).on(source).when(pred).do(...consequences)` | a recorded source × consequences | recorded firings |
| **flow** `H.flow(name)...` | executables in order | the handler of a lane |

Executables are `Command`, `Job` and `Call`. A `Call` is made by `seat.call(skill)` or `agent.call(skill)`. All three compose through `Executable<I, O>`. A batch of model calls is `.batch(name, { items, call })` inside a flow, and it is submitted through the account driver's batch capability.

### Vocabulary of words

- **run**: one harness process lifetime under one ledger claim.
- **attempt**: one execution of a lane's flow for a unit. Its outcome is succeeded, failed or cancelled.
- **step**: one addressed node of a flow (`step`, `halt`, `batch`, `spawn`, or a loop iteration). Its address is `flowName/path` plus the flow hash.
- **invocation**: one model call.

## Rules

### Lifecycle

- A unit is at pending, active, waiting or terminal. The scheduler and the board use these positions. An active unit's progress is its attempt's current step, read from the ledger.
- A flow names no state. It ends in `.exit(label)`, where the label is static or chosen by a selector. The lane maps every label to a kind state, or to `{ to, maxTimes, then }`. That form is a declared re-entry bound, which the kernel counts per unit.
  - An unmapped label is a type error.
  - A state outside the kind is a type error where TypeScript can express it, and a startup error otherwise.
- A failed attempt leaves the unit pending under `lane.retry({ tries, backoff, delaySeconds, exhausted })`. A lane without `retry` is a startup error. When retries are exhausted, the unit moves to the `exhausted` state.
- A step may carry two options:
  - `{ retry }` retries the step inside the attempt.
  - `{ onFailure: 'block' }` blocks the attempt with reason `stepFailure` and carries the step's error output.
- Blocked is an attempt state. Its reasons are `decision`, `stepFailure`, `budget`, `interrupted` and `definitionChanged`.
  - A blocked attempt holds no slot and no WIP.
  - Its unit shows at `waiting` on the board, with the blocked row beside it.
  - The same holds while a job, batch or spawn is outstanding.
- **Signals.** When a supplier offer's key matches an open unit, the offer updates that unit. `updatesOnly()` suppliers send `Update<Partial<D>>`; other suppliers send full data. What happens next depends on where the unit is:
  - While a step runs, the update is deferred to the next attempt.
  - While the attempt is blocked on a halt, the attempt is cancelled (reason `interrupted`) and the unit returns to pending.
  - While the unit is at a waiting state, it returns to pending.
- `lane.move(state)` is the one consequence that moves a unit from outside. It cancels any open attempt and records the move. Operator cancellation is a `move` through `H.ops.work.write`.
- `lane.after(fn, { failed })` orders units. A unit whose predecessor key is not yet terminal with a success verdict is not a scheduling candidate. If the predecessor ends at a failure verdict, the unit moves to `failed`, and the predecessor is recorded as the reason.

### Facets

- `lane.facet(f, fn)` writes a facet value derived from unit data onto every event of the lane's units.
- `flow.facet(f, fn)` writes a facet value derived from the flow state, including earlier steps. The value applies from that point in the attempt onward and is kept on the unit.
- A facet names an entity, never a column.

### Halts

- `.halt(stepName, halt, context)`: the step name is the address and the halt is the question. One halt entity may appear at several addresses.
- A halt has three kinds of resolver:
  - **Human**: through a grant on `H.ops.resolve(halt)`.
  - **Policy**: through `H.ops.resolve(halt).by(H.policy.halt(...))`, as a trigger consequence on `halt.opened()`.
  - **Clock**: through `.with(fn)`, on `halt.opened().after(d)` or `.at(fn)`. Clock deadlines run from the recorded `halt.opened` event.
- Every resolution records its resolver sort (`human`, `policy` or `clock`) and its client.
- A clock resolution does not cancel the attempt. The flow continues from the halt with the decision.
- `halt.resolved()` is a source. Its payload carries the context, the decision, the resolver and the client. This is how outcomes of human decisions become memory candidates without an agent tool.

### Policies

A policy is one entity with five typed constructors: `H.policy.pool`, `.seat`, `.schedule`, `.recall` and `.halt`.

- Every policy is deterministic.
- Every metric read through `metrics.read` or `metrics.group` is recorded, with its value and sample count, on `policy.decided`.
- A schedule policy returns an ordered subset of the candidates. Omitted candidates do not start this tick.

### Metrics

- A metric is `H.metric(name).rate(hits, of) | count | sum | mean | median`, computed over `H.events.*` sets.
- Dimensions are typed `Column`s or declared `Facet`s.
- `where: { seat | model }` selects events of attempts in which that seat or model was invoked.
- Every reading is `{ value, samples }`.
- `metric.crossing({ below, above, samples, window, by })` gives two sources, `falls()` and `rises()`, for hysteresis.
  - Each source fires once on entering its band: below `below`, or above `above`.
  - It fires per `by` key.
  - It fires only after the opposite band was entered, or on the first qualifying reading.
- `harness.metrics(...)` publishes metrics to telemetry observers and to the control API's telemetry operation. A metric read only by a policy or a crossing is registered through that reference and need not be listed.

### Memory

- Journals own the store and the recall policy. Roles name the memory kinds they recall and record.
- Recall scope is the attempt's kind, the role, the skill and the flow's declared `.resources(...)`.
- An item recorded by a trigger or a command is `status: 'candidate'` when the mapper says so. Recall reads only `accepted` items.
- Curation (`accept`, `merge`, `drop`) is `H.ops.memory.curate(journal)`.

### Resources and leases

- `flow.resources(select)` returns plain resources, which only set memory scope, or `H.lease.exclusive(r)` / `H.lease.shared(r)`.
- Leases are ledger state (`lease.requested`, `lease.acquired`, `lease.released`).
  - A lease is acquired before the first step and held through the attempt.
  - It is released when the attempt ends, or when the attempt blocks on a halt for longer than its lease.
- Agent plugins may lease at write time through `PluginContext.lease`.
- `plugins.fileLeaseGuard([{ resource, globs }])` maps resources to file patterns by identity.

### Resumption (the scenario 10 mechanism)

The mechanism is replay over a memoizing ledger.

1. On start, the harness claims the ledger, which has a single writer.
   - A second instance is refused.
   - The exception is a holder whose heartbeat is stale. Then the new instance takes over and records the takeover.
2. Each open attempt replays its flow. Every address with a `completed` record returns its recorded output at no cost.
3. The address that was `started` at the crash is handled by its executable:
   - `repeatable` reruns.
   - `unrepeatable` calls `detect` if one is declared, and otherwise blocks the attempt (`interrupted`).
   - A `Call` asks its driver's `recover`.
   - A `Job` or a batch with a recorded ref is collected.
   - A halt reads its resolution.
   - A spawn reads its children.
4. A changed flow hash at a recorded address blocks the attempt (`definitionChanged`). The supervisor restarts it from the top or abandons it.
5. Loop iterations are addresses, so a loop of batches resumes at the next iteration.

The author writes nothing for any of this.

### Quota

- Each account names a `QuotaPartition`.
- Drivers report quota through `DriverContext.reportQuota`. The kernel appends events and folds the window at read time.
- Harnesses that name the same partition share it. No harness locks another.

### Startup validation (`start()` rejects)

- Duplicate names within one entity sort.
- A lane without `retry`.
- An exit or retry target outside the lane's kind.
- A kind with two active states, or a terminal state without a verdict.
- A trigger, grant or journal that refers to an unregistered lane, journal or halt.
- A facet named like a column.
- A seat or agent whose models no registered pool serves.
- A role that recalls a memory kind no registered journal holds.
- A `fileLeaseGuard` that is missing a resource which a flow leases or a memory item scopes.
- A step address used twice in one flow.
- A batch whose account driver lacks batch support.

## What changed and why

1. **Halt step address** (weakness 3): the step is now `.halt(stepName, halt, context)`, so the address and the entity are distinct.
2. **Halt context**: `H.halt(...).context(z)` types what `ask`, policies and clocks read. Without it, the timeout decision of scenario 11 cannot be typed.
3. **Policy constructors**: `H.policy.pool/seat/schedule/recall/halt`. A policy is still one entity sort, but its input is now inferred without annotation (principle 20).
4. **Supervisor merged into grant**: `H.supervisor` is removed. A supervisor is a `Client` from an adapter (`claudeCode.client`, `http.client`), and the client names its transport (weakness 8). One session pointed at two harnesses is two clients with the same session name.
5. **`unit.cancel()` replaced by `lane.move(state)`**: a cancellation must land somewhere in the kind's states. One consequence now covers cancel, expire and park.
6. **`lane.due(fn)`** is the per-unit time source. Deadlines from unit data re-arm on every recorded update, which covers the scenario 9 SLA extension. `H.time` and `H.signal` are removed, because the battery uses them only through suppliers and `due`.
7. **`lane.exits` source renamed**: the brief had `lane.exits` as both the exit map and a source. The source is gone (it was unused); `enters` remains.
8. **Crossing** returns `falls()` and `rises()` sources for hysteresis.
9. **Exit bounds** `{ to, maxTimes, then }` express scenario 11's return limit without counting in the flow.
10. **`lane.after`** orders units (scenario 12), and **`lane.facet`** sets facet values. Both are lane settings because both are about the lane's units.
11. **`flow.resources`** carries leases and memory scope (scenario 12 locks, scenario 6 sections). `flow.use` is removed; plugins live on roles.
12. **`handle(flow, map)`**: the lane maps unit data to flow input, so one flow serves Bug (3 rounds) and Feature (5).
13. **Loop carry**: `initial` and `next` carry typed state between iterations. Iterations are addresses.
14. **Supply builder**: `Supply<D>.map/key/updatesOnly`. Update-only suppliers emit `Partial<D>`.
15. **`fileLeaseGuard`** takes `{ resource, globs }` by identity and is checked at start (weakness 4, partially).
16. **`anthropic.batch()` removed**: batch submission is a driver capability, and batch pricing is `Usage.batch` in `Pricing`. This narrows weakness 2: a batch is a job that the driver knows how to submit.
17. **`flow.facet(facet, fn)`** (scenario 2). The support conversation's category is decided by the classifier step, not by the helpdesk, so no lane-level facet over unit data can carry it.
    - Without a flow-level facet, "approval rate by category" and the safe-category policy (`where: { facet }`) have nothing to read.
    - The value is written onto subsequent events of the attempt and kept on the unit.
    - `lane.facet` remains for facets that derive from unit data.
18. **`halt.resolved()` source** (scenarios 2 and 6). Taste grows from a human's decision: the reviewer's edit in scenario 2, the editor's notes in scenario 6. That decision lives on the halt resolution, not in unit data, so a trigger on a state entry cannot see it.
    - A resolution source keeps memory capture a trigger consequence (principle 13), with no agent tool and no command that copies the decision.
    - It needs one new kernel payload type, `HaltResolved<C, D>`. It is fired from the recorded `halt.resolved` ledger event.
19. **`harness.metrics(...)`** (scenarios 9, 11 and 12). Each of these scenarios asks for metrics that are read by people, not by a policy or a crossing: median time to decision per halt, retries per lane, timeout share of signoffs, GPU job seconds in flight, and lock wait per database.
    - Before this change, a metric existed only through a reference from a policy or a crossing. Nothing told the telemetry observer or the auditor's `telemetry.read` that these metrics exist.
    - Registering them on the harness is the only change. Their definitions are unchanged, and their names are checked for duplicates at start with the other entities.

## Principles broken

none
