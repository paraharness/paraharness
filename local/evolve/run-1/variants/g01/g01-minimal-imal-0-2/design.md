# harness-dsl: minimal, cut (child of g00-minimal-0)

This variant takes the parent's design and applies two changes:

- It cuts surface.
- It repairs the principle-12 break against the amended skeleton.

It also adds the smallest vocabulary that scenarios 9 and 10 need. Those two scenarios were the parent's missing coverage.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`; for terminal states, `H.state(name, 'terminal', verdict)` | A named, shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape plus a set of states. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do, stated as intents. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each carrying its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?).suppliers(...).store(s).wip(n).maxUsdPerUnit(x)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source: memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy?)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(ctx => state)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(runner).recovery(r)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

The following are plain values, not entities:

- `H.clock(...)` and `H.operator`. These are kernel suppliers with no backend, because time and the control API belong to the kernel.
- `H.env(name)`.
- `TimeSpec`, `Scope`, `Bound`.
- `SupplyOf<K>`.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of a lane's flow for one unit.
  - Its states are `running`, `blocked` (halted for an outside decision) and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable inside an attempt. A retry is a new invocation, and each batch item is its own invocation.
- **Step** is not a word in this design. "A policy on the step" means a `RunOptions.retry` on one `ctx.run`.

## Rules

### 1. Skeleton (principle 12, as amended)

A unit has one of four **positions**:

- `pending`: schedulable.
- `active`: an attempt runs in this state.
- `waiting`: parked. It holds no capacity and is not schedulable.
- `terminal`.

States are entities, and each one declares its position. Every terminal state declares a verdict: `success`, `failure` or `neutral`. There is no default verdict, so the overload without one does not type-check for `'terminal'`. States are shared by sharing the constants, for example Bug and Feature spread the same `ticketStates`.

An attempt's outcome is separate from the unit's verdict:

| How the flow ends | Attempt outcome | What happens to the unit |
|---|---|---|
| Returns a state | `succeeded` (it ran to completion) | Moves to the returned state, whatever that state's verdict. |
| Returns `ctx.fail(reason)` or throws | `failed` | Stays at the state it had when the attempt started (see below). |
| Interrupted by a move, a preemption or a cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

- After a failed attempt, `unit.failures` counts consecutive failed attempts. A flow or scheduler may use it to give up deliberately.
- No kernel path maps an attempt failure onto a domain state. A model error is therefore never recorded as "vendor replied" or "escalated".

### 2. Success rate

- `successRate(kind)` is `success / (success + failure)`, counted over terminal transitions.
- Neutral terminal states (inconclusive, parked, churned, walked away, rejected) are excluded from that rate.
- Neutral states stay countable by state name through `rate` and `rateBy`.
- Every rate carries `hits` and `samples`. `value` is `null` when `samples` is 0.
- Policy metric reads are recorded on `decision` entries. Trigger reads are recorded on `firing` and `lane` entries.

### 3. Flow return value

| The flow returns | Effect |
|---|---|
| A pending state | Re-queues the unit. |
| A terminal state | Ends the unit. |
| A waiting state | Parks the unit until a supply, trigger or operation moves it. |
| `ctx.until(waitingState, { at \| children, then })` | Parks the unit with a wake condition. |
| An active state | Fails the attempt. |

Any move from outside clears the wake condition. A suspended tenancy therefore never wakes into review.

### 4. Moving a unit that has a live attempt cancels the attempt first

This covers moves made by a supplier update, a trigger and an operation. The cancelled attempt is recorded with a reason.

### 5. Supply and keys

- A `create` whose key belongs to a non-terminal unit is ignored. A `create` whose key belongs only to terminal units creates a new unit.
- `update`, a trigger's `move(lane, key, state)` and the control API's `work.update` address the open unit with that key.
- Together these give per-group deduplication without a new concept (scenario 9: key `audit-{category}`).
- The ledger keeps every unit's snapshot, so a storeless kind still has data, state and telemetry.

### 6. Triggers

**Unit sources:**

- `on.enters(kind, states)`
- `on.streak(kind, state, n, group)`, a pattern of consecutive transitions per group.
- `on.deadline(kind, due, whileIn)`.
  - `due` is re-evaluated on every data update, so the timer moves with the deadline and the old deadline never fires (scenario 9 SLA extension).
  - A fixed cutoff such as "09:00 of this night" is a deadline computed from data. The parent's separate `clock` source is gone.

**Metric source:**

- `on.metric(read, { trip, reset, minSamples })` evaluates `read` over the ledger after each recorded entry.
- `read` returns rates keyed by group.
- Each group is a two-state latch:
  - It fires `tripped` once when it crosses `trip` with at least `minSamples`.
  - It fires `reset` once when it crosses `reset`.
  - This is the hysteresis.

**Effects:** `create`, `move` (the source unit, or `lane + key`), `remember`, `pause(lane)` and `resume(lane)`.

**The firing record:**

- Every firing is a `firing` entry carrying the metric values that caused it.
- The entry's `status` is `fired` (unit sources) or `tripped` / `reset` (metric sources).
- The entry's `tags` include `group` when the source has one.
- So "Audits opened per category this month" is `rateBy({ among: { entry: 'firing', trigger, status: 'tripped' }, count: same, byTag: 'group', since })`. Its `samples` per group is the count.

**Lanes:**

- Pause and resume are `lane` entries. A resume entry carries the paused `durationMs`, so "total time paused" is `metrics.sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed' } })`.
- A paused lane starts nothing new, and its running attempts finish.

### 7. Scheduler

- The harness has one `H.policy.scheduler`. It returns an ordered `start` list and an optional `preempt` list.
- The kernel starts units in that order while lane WIP, runner slots, account eligibility and lane pause allow.
- Preempted attempts end `cancelled`, and their units return to their prior pending state.
- Blocked attempts release runner slots but count toward lane WIP.
- Waiting units count toward nothing.

### 8. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it halts the attempt with the kernel halt `cost-ceiling`.
- Daily budgets are scheduler reads of `metrics.sum`.

### 9. Accounts and quota

- Quota is ledger state (principle 15), always: the `Ledger` interface carries `accountState`, `recordUsage` and `recordCooldown`.
- Where the quota rows physically live is the ledger backend's choice. `sqlite.ledger(path, { sharedQuota })` keeps runs in `path` and quota in a shared file, keyed by account name.
- Two harnesses that name the same accounts and use ledgers with the same `sharedQuota` see each other's cooldowns, read fresh on each eligibility check.
- Accounts no longer select a quota book, so one account cannot be declared two ways.
- Shares belong to pools, and therefore to one harness.

### 10. Memory

- The kernel owns the envelope: `id`, `created`, `when`, `status`.
- Candidates are never recalled until accepted.
- Recall is the kernel's deterministic ranking over what the store's `search` returned. It orders by similarity when the store reports it, then specificity, then track record. A vector store is only a backend.
- `RunOptions.scope` narrows recall for one invocation.
- Reads union across `recalls`, and writes go to the one `records` library. Trigger `remember` names its library explicitly.

### 11. Durability (scenario 10); the author writes nothing but declarations

**Replay.**

- Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember` and `spawn` is a ledger entry with a sequence number.
- After a restart the flow body is re-executed, and recorded results are returned without invoking anything again. A completed step costs nothing.
- Flows use `ctx.now()` and do no ambient I/O.

**The invocation that was running at the crash.** An invocation has a `started` entry and no `ended` entry. The kernel calls the executable's `recover`:

- **Commands** follow `.recovery(...)`:
  - `'rerun'` runs the command again.
  - `'park'` blocks the attempt with the kernel halt `interrupted`. Park is the default.
  - A check command returning `true` means the effect happened, and the flow continues.
- **Agents** ask the model driver (`Model.recover(invocation)`): finished, still running, or unknown. Unknown parks the attempt.

**Batches.** A batch records its submitted handle before waiting, and after a restart it is collected, not resubmitted.

**Halts and operations.**

- A halt resolution is an `operation` entry.
- A client adapter that runs while the harness is down appends `requested` entries to the ledger. On start the kernel applies them in order, so a halt resolved during downtime is found.

**Children.** Spawned children are units in the ledger. On start the kernel re-evaluates `until(children)` from their recorded positions. Running children are recovered by the same rules and are never re-created.

**The attempt record.**

- The resumed attempt keeps its id.
- The crash is an `attempt: interrupted` entry, not an outcome.
- Interrupted invocations carry `interrupted: true` and are excluded from model and agent rates.

**A flow that changed under a running attempt.**

- Each attempt records its flow `fingerprint`: the step sequence.
- If the fingerprint differs on restart, the attempt is blocked with the kernel halt `definition-changed` and a reason.
- The supervisor resolves that halt with `restart` (a new attempt from the top) or `abandon` (the attempt is cancelled).

**Single writer.**

- `start()` takes `ledger.lease('harness:<name>', run, ttl)` and renews it.
- A second process refuses to start while the lease is live. It takes over after expiry and records a `run: took-over` entry.

**Multi-attempt flows.** A flow re-entered after `until(children)` is a new attempt. It branches on `ctx.unit.state`, which is the `then` state the wake moved it to. That branch is lifecycle, not resumption: the kind's states say which phase the unit is in.

### 12. Control API

- The API is made of operations, and clients are granted operations.
- `claude-code.supervisor` is one client. `http.control` is a plain-HTTP client.

### 13. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names;
- a lane/flow state mismatch;
- an unknown state in a flow or trigger;
- an unregistered lane in a trigger;
- an agent that no pool can serve;
- a command without argv or runner;
- a missing ledger;
- a batch call on a model without `submit` and `collect`.

A harness with no pools, agents or models is valid.

## What changed and why

### Repaired: principle 12

- The parent's seven outcomes are replaced by the amended skeleton: four positions plus a verdict on terminal states.
- The parent's `idle` becomes `waiting`. The parent's `ended` becomes `terminal` with a `neutral` verdict.
- States are entities again (`H.state`), because the amended principle makes them shareable entities. `H.lifecycle` is gone; sharing a state is sharing the constant.

### New: `ctx.fail`

`ctx.fail(reason)` separates attempt failure from unit verdict. It answers the critique's charge that a model failure was mapped onto a domain state.

### Cut

| Cut | Reason / replacement |
|---|---|
| `H.lifecycle` | States are entities; share the constants. |
| `MemoryKind.data`, `MemoryDraft.data` | Never called. |
| `Library.recall`, `H.policy.recall` | One caller. The kernel's ranking already uses similarity. |
| `H.slot.port` | Never called. `Ref` is env-only. |
| `InferSchema` | Never used. |
| `DataOf`, `StateOf` | Merged into one `SupplyOf<K>`. |
| `H.on.clock` | Covered by `deadline`. |
| `TriggerEvent.streak` | Never read. |
| `Command.on(fn)` | Removed; it put runner names in kind data (critique b). Commands are bound per runner. |
| `flow.for` three-kind overload | Never called. |
| `Intent 'ask'`, `ModelResponse 'asked'` | One halt mechanism, `ctx.halt` (critique a). |
| `QuotaBook` interface and the account `quota` option | Moved into `Ledger` (critique c). |
| `sqlite.quota` | Replaced by `sqlite.ledger(path, { sharedQuota })`. |
| `Supplier.operator` flag | Not needed. |
| `GroupBy` union | Replaced by `byTag`; only tags were used. |
| `Issue.identifier`, `labels`, `status` | Unused. |
| `http.control` port `Ref` form | Unused. |

### Made optional

`H.pool`'s account policy is now optional. The kernel default is "first eligible member in declaration order". Five scenarios repeated that policy as boilerplate.

### Renamed

These renames end the "schedule" overload of critique a:

- `H.schedule` → `H.clock`, the time supplier.
- `H.policy.schedule` → `H.policy.scheduler`.
- Memory sort `'fallible' | 'owner'` → `'experience' | 'taste'`, the principle's own words.

### Added for scenario 9

- `on.metric` with `trip`, `reset` and `minSamples` latches.
- `act.pause`, `act.resume` and `act.move(lane, key, state)`.
- The `lane` ledger entry.
- `Window.hours` and the `mode` filter.
- Deadline re-evaluation on update (a rule, not surface).

### Added for scenario 10

- `Command.recovery`.
- `Executable.recover`.
- `Model.recover`, and `Model.submit`/`collect` replacing `batch`.
- Invocation `status` and `handle`, and the attempt `fingerprint`.
- Operation `requested` entries.
- The single-writer lease rule.

### Added in the battery pass for scenarios 6–10

Writing scenario 9 showed that the question "how many Audits were opened per category this month" could not be asked:

- Firing entries were not filterable by trigger.
- A metric trip could not be told apart from a reset.
- The group was not a tag, so `rateBy` could not split by it.

The fix adds three things and nothing else:

1. `FiringEntry.status`: `fired` / `tripped` / `reset`.
2. `EntryFilter.trigger`.
3. A rule that a firing entry is tagged with its `group`.

Two alternatives were rejected:

- Counting Audit units' transitions would have needed creation-time tags on units, a larger surface.
- Counting Audit attempts would conflate attempts with openings.

The multi-attempt rule (re-entry branches on the `then` state) is now written down. Scenario 10's Release and scenario 7's Epic depend on it.

## Principles broken

None. The parent's break of principle 12 is repaired: positions and verdicts now follow the amended text. Principle 15 holds because shared quota is a section of the ledger whose backend places it, not a second kernel store.
