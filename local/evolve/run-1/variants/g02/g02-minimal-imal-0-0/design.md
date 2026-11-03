# harness-dsl: split ledger (child of g00-minimal-0)

## The split

The parent's `Ledger extends QuotaBook`. One interface held two jobs with opposite concurrency rules:

- **the harness's own record** (runs, attempts, invocations, transitions, the pending queue). It is single-writer by necessity: two schedulers writing it would double-start work.
- **an account's quota history**. It is multi-writer by necessity: two harnesses share one subscription and each must see the other's consumption a second ago.

Putting both behind one object produced the defects the adversary named. Quota "by default" lived in the ledger and "sometimes" in another book. Nothing stopped harness A from declaring a shared book while harness B fell back to its ledger, which double-counts. And any quota write had to pass the single-writer lock.

This child splits the ledger into **partitions**. The ledger is still the kernel's only state (principle 15); it is now made of three sorts of partition, each with its own writer rule.

| Partition | Interface | Writers | Lock | Owned by |
|---|---|---|---|---|
| harness partition | `Ledger` (`append`, `units`, `replay`, …) | one claimed holder | fenced claim (`claim`/`renew`, `fence` on every write) | the harness (`.ledger(...)`) |
| quota partition | `QuotaPartition` (`append`, `read`) | every harness using the account | none: append-only events, folded at read time | the account (`quota:` option, required) |
| inbox | `Ledger.post` / `Ledger.inbox` | control clients, even while the harness is down | none: append-only, consumed by the holder | the harness |

**Surface added by the split:**

- `QuotaPartition` and `QuotaEvent` in the kernel.
- `Ledger.claim`, `renew`, `release`, `post`, `inbox`, and a `fence` argument on writes.
- A required `quota` option on every account adapter.

**Surface removed by the split:**

- `QuotaBook`.
- `Ledger extends QuotaBook`.
- The default quota fallback.
- `AccountState` writes (`recordUsage`, `recordCooldown`). `AccountState` is now a fold that the kernel computes, not a method any backend implements.

The net change is +6 methods and −3 methods.

Other repairs appear in "What changed and why". They are not splits, but the adversary's critiques and the battery's new scenarios required them.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **kind** | `H.kind(n).data(z).states(map, initial).onFailure(s?)` | A data shape plus a lifecycle of named states. Each state declares a place. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'fallible' \| 'owner')` | A memory kind: experience or taste. |
| Kind | **resource** | `H.resource(n)`, `H.resources(n, ids)` | A named thing that work touches: a database, a service, a section. It has no backend. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | Each carries its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params).suppliers(...).store(s).wip(n).maxUsdPerUnit(x).retry(p).touches(f)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | The recall source for one memory kind. |
| Pivot | **pool** | `H.pool(n, members, policy)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Composite | **flow** | `H.flow(n).for(...kinds).params(z).does(ctx => …)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(runner).restart(rule)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model,account,scheduler,recall,retry,rule}` | One entity with six decision shapes. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger(l).lanes().pools().triggers().scheduler(p).clients().observers()` | The running thing. |

These are plain values, not registered entities: `H.lifecycle(map)`, `Cadence`, `H.env`, `H.slot.port`, `H.recurring(...)`, `H.operator`, `DataOf` and `StateOf`.

## Execution vocabulary (one definition each)

- **Run**: one process lifetime holding the ledger claim. It is recorded as `run` entries with a fence number.
- **Attempt**: one execution of a lane's flow for one unit. Its outcome is `succeeded`, `failed` or `cancelled`. While it runs it may also be `blocked` (halted), `interrupted` (its process died) or `parked` (waiting on the supervisor after a restart problem). Those are attempt states, not outcomes.
- **Invocation**: one call of one executable. A retry is a new invocation. Each batch item is its own invocation.
- **Step**: the ordinal position of an invocation or halt inside an attempt's flow body: 1, 2, 3 and so on. A step is how replay matches the body to the record. A step is not a separate entity; it is the `step` number on `invocation` and `halt` entries.

## Rules

### 1. Lifecycle (principle 12 as amended)

**States and places.** Each named state declares a place:

- `pending`, `active` or `waiting`;
- or a terminal verdict: `success`, `failure` or `neutral`.

The terminal verdict has no default. States are shared between kinds by sharing a `H.lifecycle` value.

**Positions.**

- The four positions are pending, active, waiting and terminal.
- The scheduler and the board read positions only.
- Waiting units hold no capacity and are never schedulable.

**Success rate.**

- Success rate is `success / (success + failure)` over terminal transitions.
- `neutral` (inconclusive, parked, churned, walked away) is counted beside it, by state name, and never in the denominator.
- "Loaded with warnings" is a separate `success` state: success to the scheduler, distinct by name in metrics.

**Attempt outcomes.**

- The attempt's outcome is about execution and is independent of the unit's state.
- A flow that returns a state ends its attempt as `succeeded`.
- `ctx.fail(reason)` ends it as `failed`.
- A move from outside, or a preemption, ends it as `cancelled`.

**Failure default.**

- By default, a failed attempt returns the unit to the pending state it held when the attempt started. Re-entry then follows `lane.retry(policy)`; with no retry policy the unit stays pending and the scheduler sees it.
- Only a kind that declares `.onFailure(state)` moves the unit on attempt failure.
- This repairs the parent's lie of `return 'vendor-replied'` on a model error. A failed model call is now a failed attempt, counted as one, and the unit's state is untouched.

### 2. Flow return value

| Return value | Effect |
|---|---|
| A pending state | Re-queues the unit. |
| A terminal state | Ends the unit. |
| A waiting state | Parks the unit with no wake condition. |
| `ctx.until(rest, {at \| children, then})` | Parks the unit with a wake condition. |
| `ctx.fail(reason)` | Fails the attempt (Rule 1). |
| An active state | Fails the attempt, with reason `returned-active`. |

### 3. Moves clear wakes and cancel attempts

- Any move from a supplier update, a trigger, or `work.update` clears the unit's wake condition.
- If the unit has a live attempt, that attempt is cancelled first.
- A flow's own `ctx.move` does neither.
- This closes the parent's race in which a suspended tenancy woke into `review-due`.

### 4. Supply and dedupe

- **`create`.**
  - `create` with `key` is ignored if a unit with that key exists.
  - `create` with `dedupe` is ignored while a non-terminal unit in the same lane carries that dedupe value. This is deduplication by group key, as scenario 9 needs: "one open Audit per category".
- **`update`.** `update` patches the store and may set a state. The update supplier for Negotiation changes an existing unit.
- **Supplied snapshot.** The ledger keeps each unit's supplied snapshot, so a kind with no store still has data, a state and telemetry.

### 5. Resources

- `H.resources('databases', ['orders', 'users'])` produces a set of resources with a typed `schema`.
- Kind data uses that schema, so a unit says it backs up `'orders'`, a domain fact, and never names a host.
- Placement on runners is the command's concern: `.on(input => placement[input.database])` over a `Record<'orders' | 'users', Runner>`. That map is exhaustive at compile time, so a typo cannot silently route to another host.
- `lane.touches(data => Resource[])` declares what a unit touches. It feeds two things:
  - recall scope, through `RecallView.scope.resources`;
  - `UnitView.resources`, so a scheduler can exclude work by resource rather than by kind.
- Memory `when` scopes take `Resource`, `KindRef` and `RoleRef` descriptors, not strings.

### 6. Triggers

**Sources.**

| Source | Fires when |
|---|---|
| `enters(kind, states)` | A unit enters one of the states. |
| `streak(kind, state, n, group)` | A pattern holds: n consecutive transitions of one group into the state. |
| `deadline(kind, due, whileIn)` | The due time passes while the unit is in one of the states. |
| `time(kind, cadence, whileIn)` | The cadence ticks while the unit is in one of the states. |
| `threshold({ read, enter, exit })` | A grouped metric crosses into or out of a band. |

**Deadlines.** `deadline` is re-armed whenever a unit's data changes, because `due` is a function of the current data. When the reviewer extends an SLA through `work.update`, the timer moves, and the old deadline never fires.

**Thresholds.**

- `read` is evaluated after each committed ledger append, debounced by the kernel.
- When a group's rate crosses into the `enter` band (with `minSamples`) or out through the `exit` band, the kernel writes a `crossing` entry with the value and the sample count.
- Whether a group is currently "inside" is folded from earlier crossing entries.
- This gives hysteresis, and exactly one firing per crossing.

**Effects.**

| Effect | Does |
|---|---|
| `create(lane, data, {key, dedupe})` | Creates a unit in a lane. |
| `close(lane, dedupe, state)` | Moves the open unit carrying that dedupe key to a state. |
| `remember(library, draft)` | Records a memory item. |
| `pause(lane)` | Stops new starts in the lane. Running attempts finish. |
| `resume(lane)` | Lets the lane start work again. |
| `move(state)` | Moves the source unit. Unit sources only. |

**Recording.**

- Every firing is a `firing` entry that references its source entry.
- A threshold firing's tags always carry `group` (the crossing's group key) and `direction` (`entered` or `exited`), so firings filter and group like any tagged entry.
- `pause` and `resume` write `lane` entries that reference the firing, so the board shows the metric value that caused them.
- `metrics.duration({opened: paused, closed: resumed})` answers "how long was the lane paused".
- `metrics.count({among: {entry: 'firing', trigger, tags: {direction: 'entered'}}, by: {tag: 'group'}})` answers "how many Audits per category this month".

### 7. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass the ceiling raises the kernel halt `cost-ceiling`.
- Daily budgets are read by the scheduler policy through `metrics.sum`.
- Batch invocations are priced at `Price.batchDiscount` and recorded with `mode: 'batch'`.

### 8. Scheduler

- The harness has one `H.policy.scheduler`. It returns an ordered `start` list and an optional `preempt` list.
- The kernel starts units in that order while lane WIP, runner slots, account eligibility and lane pause allow.
- A preempted attempt ends `cancelled`, and its unit returns to its prior pending state.
- A blocked attempt releases its runner slot and keeps its WIP slot.
- Waiting units count toward nothing.

### 9. Accounts and quota

- Every account names its quota partition. The same descriptor, imported by two harnesses, carries the same partition, so the two harnesses cannot diverge on it.
- Each harness appends `usage` and `cooldown` events tagged with its own name.
- Eligibility folds the window, across all harnesses, at read time. There is no lock.
- Shares belong to the pool, and so to one harness: A at 0.6, B at 0.3, each checked against its own `byHarness` fold.

### 10. Memory

- The kernel owns the envelope: id, created, `when` and status.
- `candidate` items are never recalled until accepted.
- Recall always runs the library's recall policy over what the store's `search` returned. The store may rank by similarity; the policy decides.
- Reads union across every library an agent `recalls`. Writes go to the one library it `records`.

### 11. Restart (scenario 10)

The author's restart work is one `.restart(...)` per command that is unsafe to repeat. Everything else is kernel behaviour.

**Write-ahead.**

- Every invocation writes `started` (or `submitted`, with the batch handle) before it calls its executable, and `finished` after.
- Every halt writes `raised`, then `resolved`.

**Replay.**

- On restart, each interrupted attempt's flow body is re-executed.
- Steps with a `finished` entry, or a resolved halt, return their recorded results. They run nothing and cost nothing.

**The step that was in flight** (`started` with no `finished`) is handled by the executable's `restartMode`:

| Mode | Declared by | Behaviour |
|---|---|---|
| `rerun` | `command.restart('rerun')` | Invoke again. |
| `park` | the default for commands | The attempt becomes `parked` with the reason `in-flight:<step>`. |
| `ask` | agents (default), or `command.restart({ check })` | Call `recover`. |

How `ask` resolves:

- An agent's `recover` calls the model driver's `recover(invocationId)`. The invocation id was the session key.
- A command's `check` executable runs instead. Success means the effect happened, and its output stands in for the step's output.
- A `recover` answer of `'running'` re-polls. An answer of `'unknown'` parks the attempt.

**Other state that moved while the harness was down.**

- **Batches.** A `submitted` batch is collected with `collect(handle)`, never resubmitted.
- **Halts.** A halt resolved through a client while the harness was down was `post`ed to the ledger inbox. The new holder consumes the inbox first, records each item as an `operation` entry, and the replay finds the halt resolved.
- **Children.** Spawned children are separate units with their own attempts. The parent's attempt ended at `until({ children: true })`. On restart, the kernel folds the children's positions from the ledger and wakes the parent if they are all terminal. Children's in-flight steps follow their own rules; nothing is restarted wholesale.

**Same attempt.**

- An interrupted attempt keeps one id. Its entries go `interrupted` → `resumed`.
- A recovered invocation has `recovered: true`.
- No crash ever produces `ok: false`, so model, agent and account metrics never count it.

**Changed definitions.**

- At start, the attempt records a fingerprint of the flow.
- During replay, if the body's next call does not match the recorded entry at that step (a different executable or halt name, or a step inserted before), replay stops.
- The attempt is parked with the reason `definition-changed`, and the step and both names are shown.
- The supervisor calls `halts.restart(attempt)` to start from the top. That is the same attempt id, with its completed steps discarded from replay. Or it calls `halts.abandon(attempt)`, which ends the attempt `cancelled`.

**Single writer.**

- `start()` calls `ledger.claim(holder)`.
- If a live holder renews within its TTL, `start()` rejects.
- If the holder's TTL has lapsed, the claim succeeds with a higher fence. Every append carries the fence, and the ledger rejects appends with a stale fence. A paused-not-dead first copy that wakes up can therefore no longer write.

**Step order.** Flow bodies run their steps sequentially, which keeps step numbers deterministic for replay. The scenario battery never needs concurrent steps inside one attempt; fan-out is `ctx.batch` or `ctx.spawn`.

### 12. Control API

- The API is made of operations, and clients are granted operations.
- The supervisor is one client (`claude-code.supervisor`). Plain HTTP is another (`http.control`).
- `resolveHalts` covers `halts.resolve`, `halts.restart` and `halts.abandon`.

### 13. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names;
- a lane/flow mismatch;
- an unknown state in a flow, trigger or `onFailure`;
- an `onFailure` state with an active place;
- an unregistered lane in a trigger effect;
- an agent no pool can serve;
- two accounts with one name but different quota partitions;
- a batch call on a model without `submit`/`collect`;
- an unavailable ledger claim.

A harness with no pools, agents or models is valid.

## What changed and why

**The split.** Ledger and quota are now separate partitions (adversary critique c; principle 15 as ruled after generation 1).
- Quota events are append-only per account, folded at read time, with no lock.
- The partition is required on the account, so a shared descriptor cannot be half-shared.

**Principle 12 repaired.** The parent's seven outcomes are now the amended form: four positions, three attempt outcomes, and per-state verdicts.
- `idle` is now `waiting`.
- The parent's `ended` is now terminal with a `neutral` verdict.

**`ctx.fail` and the failure default.** These repair adversary §1:
- Negotiation no longer maps errors to `vendor-replied`.
- Support no longer maps classifier crashes to `escalated`.
- An experiment's missing sample can be a failed attempt rather than a silently dropped observation.

**One word for scheduling** (critique a).
- The supplier is `H.recurring`.
- The time-based trigger source is `H.on.time`.
- `H.policy.scheduler` produces what `.scheduler()` takes.
- `TimeSpec` is renamed `Cadence`.
- The word "schedule" now means only the scheduler.

**One mechanism for asking a human** (critique a).
- `Intent 'ask'` and `ModelResponse 'asked'` are removed.
- An agent that needs a decision returns it in its output, and the flow halts.

**Resources are entities** (critique b; seed weakness W4).
- Kind data names domain resources from a typed set, never runner names.
- Placement on runners is an exhaustive map on the command.
- `lane.touches` supplies recall scope and lets the scheduler exclude by resource.

**Metric-threshold triggers** (scenario 9).
- New: hysteresis bands, dedupe-keyed creation, `close`, lane `pause` and `resume`.
- New metrics: `count`, `duration`, and `Window.hours`.

**Deadlines re-arm** on data change (scenario 9, the SLA extension).

**Restart semantics** (scenario 10).
- Write-ahead invocation entries, `restartMode` and `recover` on executables, and batch `submit`/`collect` on models.
- The ledger inbox, fenced claims, and the `halts.restart` / `halts.abandon` operations.

**Moves clear wake conditions** (the tenancy race).

**`RunOptions.scope` narrowed** to `skills`. Resources now come from `lane.touches`.

**Scenario pass 06–10.**
- Threshold firings now always carry the tags `group` and `direction`. Scenario 9 counts Audits opened per category from firings. Without the `direction` tag, a recovery firing (exited) would be counted as an opening. This is a contract on existing entries; no type changed.
- Rule 3 now states explicitly that a flow's own `ctx.move` neither cancels nor clears a wake. Only moves from outside do.
- Rule 11 now states that steps run sequentially, which keeps replay deterministic. Scenario 6 runs its two reviewers one after the other for this reason.
- No change to `h.d.ts` or `kernel.d.ts`.

**Not done.** A per-invocation timeout, from the adversary's canary scenario, which is not in the battery.
- Principle 21 forbids methods no scenario calls, so it is still absent.
- If the canary scenario joins the battery, the fix is `command.timeoutMs(n)`: the invocation is killed, ends `ok: false`, and frees its slot.

## Principles broken

None.

- **On principle 12, "a kind's named states are entities (shareable)".** Here each state is a named declaration inside a lifecycle. States are shared by sharing a `H.lifecycle` value, and addressed by `(kind, name)` in triggers and metrics. If the owner means a standalone `H.state` builder per state, this variant does not have one. It would add a builder that no scenario needs beyond what `H.lifecycle` already shares.
- **On principle 15.** The inbox and quota partitions are ledger partitions under principle 15's partitioning clause. Neither takes the harness partition's single-writer claim. There is no kernel work store.
