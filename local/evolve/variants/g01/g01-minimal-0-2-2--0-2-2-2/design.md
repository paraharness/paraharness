# harness-dsl: minimal, renamed (child of g00-minimal-0-2-2)

Operator: **rename**.

## The rename

The weakest noun in the parent was **library**. Principle 8 names the pivot `journal = memory kind × store × recall`. The parent called it "library", a word for a shelf of books, and that word does not say what the pivot produces: a place memory is written to and recalled from, forward-phrased, in order.

- `H.library` becomes `H.journal`.
- `Library` becomes `Journal`, carrying `entity: 'journal'`.
- The `library` fields in `MemoryItem`, `MemoryStore` and `ControlApi.memory` become `journal`.
- `seat.recalls(...journals)` and `seat.records(journal)` take journals.

The same pass renamed the second-weakest noun, **agent → seat**. The reason is the adversary's second critique: a metric keyed on a model breaks when the model is swapped.

Principle 8 defines an agent as "a seat with one model". Keeping both nouns would be two words for one pivot (principle 22, known weakness 1).

- `H.seat(name, role).model(model | policy)` is the only form.
- A fixed model is a seat whose choice is constant.
- Invocations record `seat`, `role` and `model` as typed columns.
- Metrics may key on `seat`, so a series survives a model swap. They may also key on `{ modelOf: seat }` to compare the models a seat used.

## Entities

| Sort | Entity | Builder | Is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A shareable lifecycle position. Terminal states require a verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about(z).timeout(after, f).policy(rule)` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing. Locks and memory scope reference it by identity. |
| Kind | facet | `H.facet(n, schema)` | A declared metric dimension whose values come from data, such as `category`. |
| Instance | account, model, runner, store, memory store, quota partition, supplier, ledger, guard, observer, client | adapters only | Each carries its backend. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy).on().recalls().records().guards()` | role × models × choice policy, picked at attempt time. |
| Pivot | lane | `H.lane(n, kind).handler().suppliers().store().wip().maxUsdPerUnit(limit, over?).retry().locks().order()` | kind × suppliers × store × handler. |
| Pivot | **journal** | `H.journal(n, memory, store)` | memory kind × store, recalled by the kernel's recall policy. |
| Pivot | pool | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | trigger | `H.trigger(n, source, effects)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation | as named | Executables and decisions. |
| Root | harness | `H.harness(n)...start()` | The running thing. |

## Execution vocabulary

| Word | Definition |
|---|---|
| Run | One lifetime of a process. |
| Attempt | One execution of a lane's flow for one unit. Its states are running, blocked, waiting and ended. Its outcome is succeeded, failed or cancelled. |
| Invocation | One call of one executable. Each retry and each batch item is its own invocation. A job is one invocation. |
| Step | Not a word in this design. |

## Rules

### 1. Skeleton (principle 12)

**Position.** A unit's position comes from its attempt, then its state:

| Condition | Position |
|---|---|
| A running attempt | `active` |
| A blocked or waiting attempt, or a job or batch in flight | `waiting` |
| No live attempt | The position its state declares |

**How a flow ends.**

| How the flow ends | Attempt outcome | What happens to the unit |
|---|---|---|
| Returns a state | `succeeded` | Moves to that state. |
| `ctx.fail` or a throw | `failed` | The unit returns to pending under the lane's retry policy. |
| An outside move, a preemption, or the cost ceiling without an `over` halt | `cancelled` | Handled by the rule that interrupted it. |

**Retry exhaustion.**

- `lane.retry(policy, exhausted)` names where exhaustion leaves the unit. That state must belong to the lane's kind.
- Without `.retry`, the kernel default is exponential backoff from 1 minute, capped at 1 hour, unbounded. It needs no end state.
- `KindDescriptor.failsTo` is **deleted**. `H.kind(...).states(...)` returns a plain `Kind`.

### 2. Retry: one policy type, two attachment points, one meaning

`RetryView { failures, counting: 'attempts' | 'invocations' }`. `'stop'` always means "give up on the thing the policy is attached to".

| Attached with | `counting` | `failures` counts | On `'stop'` |
|---|---|---|---|
| `lane.retry(policy, exhausted)` | `'attempts'` | The unit's failed attempts | The unit moves to `exhausted`. |
| `command.retry(policy)` | `'invocations'` | That invocation's consecutive failures | The flow receives the failed `Result`. |

This is scenario 5's "policy on the step": it is declared on the command, not passed per call. `RunOptions.retry` is deleted.

### 3. Waits, success rate, outside moves, supply

These are unchanged from the parent:

- Durable `ctx.wait`.
- Success rate is `success / (success + failure)`, with neutral excluded and `samples` shown.
- An outside move cancels a live attempt.
- Supply keys deduplicate creates.

**`deferred` updates.** A `deferred` update is held while its unit's attempt is at position `active`.

- If the attempt reaches position `waiting` (a halt, a wait, a job), the update applies there. Its state move then cancels the attempt, and the unit re-enters the flow from that state.
- If the attempt ends first, the update applies after the attempt's own move.

So a redline that arrives during drafting is not lost and does not interrupt the draft. A redline that arrives while the unit waits on counsel re-enters at drafting (scenario 11).

### 4. Entities, not strings

**Filters.** `EntryFilter` takes descriptors for kind, lane, seat, model, halt, resource, executable and trigger. Free-form tags are **deleted**.

**Facets.**

- A data-derived dimension is a declared facet: `H.facet('category', z.string())`.
- A flow records a value with `ctx.tag(category, value)`. The value is typed by the facet's schema.
- Filters match facet values with `category.value(v)`.

**Dimensions.** `Metrics.rateBy({ by })` takes a `Dimension`. It is one of:

- a typed column: `kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`, `resolver`, `group`;
- a facet;
- `{ modelOf: seat }`, which groups any attempt-scoped entry by the model that seat used in the same attempt.

`{ modelOf: seat }` is how approval rate by model (scenario 2), citation pass rate by synthesizer model (scenario 3) and editor uptake per reviewer model (scenario 6) are computed. The flow writes no tags.

**Startup errors.**

- A facet whose name equals a column.
- Two facets with one name.

**Memory scope.**

- `Scope` takes `KindRef[]`, `RoleRef[]`, `Resource[]` and `FacetValue[]`. The principle's "skills" are facet values, so there is one word fewer.
- The store sees a `ScopeRecord` of names. Only the kernel converts descriptors to names.
- Recall scope is the union of:
  - the unit's kind;
  - the seat's role;
  - the attempt's facet values;
  - `RunOptions.scope`.

### 5. Halts (principle 17)

These are unchanged:

- The resolvers are `human` (a client granted `H.ops.resolve(halt)`), `policy` (a registered rule, with its reads recorded) and `clock` (`.timeout`, measured from the recorded raise, continuing the attempt).
- `H.on.halted(halt, after)` escalates.
- `ControlApi.halts.resolve` takes the halt entry id.

### 5a. Cost ceiling (scenario 2, scenario 3)

The two forms:

| Form | What happens when an invocation would pass the ceiling |
|---|---|
| `lane.maxUsdPerUnit(limit)` | The kernel cancels the attempt before it makes the call. |
| `lane.maxUsdPerUnit(limit, over)` | The kernel raises `over`, a `Halt<CeilingDecision, CeilingAbout>`, before it makes the call. |

The halt's types:

- **About:** `{ spentUsd, limitUsd }`.
- **Decision:** `{ continue }`.

How the decision is applied:

- `continue: true` raises that unit's ceiling by one more `limit`, and the attempt proceeds.
- `continue: false` cancels the attempt.

The ceiling halt is an ordinary halt entity: grants, timeouts and metrics reference it by identity.

### 6. Triggers

These are unchanged: `enters` (with `times`), `streak`, `deadline`, `metric` with hysteresis, and `halted`. Every firing is recorded.

**Grouped metric firings.** A grouped metric firing records `group`. That makes "audits opened per category" countable as `count({ entry: 'firing', trigger, status: 'tripped', group })`.

**`trippedAt`.** A metric event carries `trippedAt`, the recorded time of the trip that opened the current crossing.

- The trip and its matching reset carry the same value.
- So a trip's consequence can create a unit keyed by `(group, trippedAt)`, and the reset can address that same unit.
- The next crossing gets a fresh key, so a closed Audit never deduplicates the next one.

### 7. Scheduler, capacity, locks and order

**The scheduler view** is `{ pending, active, waiting }`:

- `active` holds only attempts at position `active`. The `blocked` flag is deleted.
- `waiting` lists units at `waiting`, with what they wait on.

This repairs "active" meaning two things (principle 22). It also lets scenario 4 ask "is an Incident open" over `active` and `waiting` together, while only `active` can be preempted.

**Capacity.** WIP and runner slots are held only at position `active`.

**Locks.** `lane.locks(data => Lock[])` takes leases for the life of the attempt.

A parked attempt keeps its locks on purpose. A migration that crashed mid-run leaves its database in a state the harness cannot vouch for, and releasing the exclusive lock would let a backfill run against it. Leases are ledger entries, and the board shows each held lease next to its holder's halt. The lock is therefore visible as a lock, not as a mystery stall.

**Lock scope.** A lane whose flow submits a long job and must not pin a resource declares no locks for that lane. Scenario 12's EvalRun lane declares none. Step-scoped locks (the adversary's proposed scenario 13) are not in the battery and are left out under principle 21.

**Order.** `lane.order(by, onEarlierFailure)` replaces `after(predecessorKey)`.

- A unit waits until every unit of the lane with a smaller `by` value has reached a `success` terminal.
- If an earlier unit ends at failure or neutral, the unit moves to `onEarlierFailure`. That state must be at position `waiting`, and the transition carries a `reason`.
- Gaps in numbering do not matter, because no key is computed.
- **The exit.** `ControlApi.work.move(key, state, reason)`, granted by `writeWork`, moves a parked unit out. Moving it back to a pending state re-enters the order check.

### 8. Jobs, cost, durability

**Jobs, batch and cost** are unchanged from the parent.

**Durability (scenario 10)** works the same way:

- **Replay.** Recorded invocations, halts, waits and spawns replay from the ledger after a restart. The flow is not re-run against live effects.
- **Interrupted invocations.** The invocation that was running at the crash follows its `.recovery`.
- **Changed definitions.** A changed flow fingerprint blocks the attempt on the kernel halt `definition-changed`.
- **The author's part.** The author writes `.recovery` on each command, and nothing else.

**What a probe's answer means.** When `.recovery` is a probe executable, it is invoked with the interrupted invocation's input.

| The probe returns | The kernel |
|---|---|
| `true` | Records the interrupted invocation as finished. The flow continues. |
| `false` | Parks the attempt for the supervisor. |
| A failed `Result` | Parks the attempt for the supervisor. |

The kernel never reruns an invocation whose recovery is a probe.

**Seats.** A seat's recovery is its model driver's `recover`.

**Single writer.** `Ledger.claimWriter(run, ttlMs)` replaces the overloaded `lease`. Resource leases now take a `Resource`.

### 9. Accounts and quota (principle 15)

**The partition belongs to the account.** The account names its quota partition. The ledger carries no option for it.

- `sqlite.ledger(path)` has no options.
- `claude.subscription(name, { token, quota })` and `anthropic.account(name, { apiKey, quota })` take a `QuotaPartition`.
- `sqlite.quota(path)` is one backend of that interface.

**Writes and reads.**

- `QuotaPartition` is append and read only. Each harness appends its own `QuotaEvent`s, including cooldowns.
- The kernel folds the window at read time.
- No lock is taken, and it is not the ledger's writer claim.

**Default and sharing.**

- An account that names no partition uses `ledger.quota`, its own harness ledger's partition.
- Scenario 7 declares the three accounts once in a shared module, each with `quota: sqlite.quota('~/.harness/accounts.db')`. Both harnesses import the same account entities.

**Interface changes.** `Ledger.accountState`, `recordUsage` and `recordCooldown` are deleted. Shares stay on pools, per harness.

### 10. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names, including halts, resources, facets and seats;
- a facet that repeats a column;
- flow states outside the lane's kind;
- a `wait` or `order` target at the wrong position;
- a `retry` exhausted state outside the lane's kind;
- a trigger that references an unregistered lane;
- a seat that no pool can serve;
- a command without argv or runners;
- a job whose commands have no runner;
- a batch on a model without `submit` and `collect`;
- a halt with a resolver that reads facts but has no `.about`;
- a ceiling halt that no registered client is granted to resolve;
- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

| Change | Reason |
|---|---|
| `library → journal` | The operator: principle 8's own noun for the pivot. |
| `agent → seat`. Invocation `seat` and `role` columns. `ModelChoice.seat`. `Dimension` with `'seat'` and `{ modelOf }`. | Known weakness 1, and critique 2: an A/B series keyed on the seat survives a model swap. |
| `H.facet`, typed `ctx.tag(facet, value)`, `EntryFilter.facets`. Tags and `byTag` removed. | Critique 2: metric dimensions must be typed columns or declared facets (principle 18). |
| `Scope` takes descriptors. `ScopeRecord` is for stores. | Critique 2: memory scope used strings where `H.resource` and roles exist (principle 8). |
| Quota partition moved from `sqlite.ledger` options to the account's `quota`. Ledger quota methods removed. `QuotaPartition` interface added. | Critique 1: principle 15 forbids the ledger option by name. |
| `failsTo` deleted. `RunOptions.retry` replaced by `command.retry`. `RetryView.counting` added. | Critique 3: retry is now expressed one way per attachment point, and "failures" says which count it is. |
| `SchedulerView.active` is position `active` only. `waiting` added. `blocked` removed. | Critique 3, last point (principle 22). |
| `lane.after(key)` replaced by `lane.order(by, onEarlierFailure)`. `work.move` added. `claimWriter` split from `lease`. | Scenario 12 critique: gaps in numbering, parked units with no exit, one method for two leases. |
| `GuardContext.lease` renamed `leasePath`. `InvocationContext.lease` removed. | File-path leases are a guard's business. Resource leases are kernel leases on a `Resource`. |
| `lane.maxUsdPerUnit(limit, over?)` with `CeilingDecision` and `CeilingAbout`. | See below. |
| `MetricEvent.trippedAt` added. | Scenario 9: a reset could not address the Audit its trip created. A key from the group alone would deduplicate every later crossing against a closed Audit. The key is now `(group, trippedAt)`. |
| `deferred` semantics stated: held while active, applied at waiting. | Scenario 11: a redline must not interrupt a draft, and must re-enter at drafting when it arrives during the counsel halt. The parent's wording ("while the attempt runs") left the waiting case undefined. |
| Recovery probe semantics stated: `true` means finished, `false` means park, never rerun. | Scenario 10: `announce` must continue if the post happened and park otherwise. The parent left the meaning of `false` unstated. |

**The cost ceiling change.** Scenario 2 requires that a unit that would pass its ceiling halts for a human. The parent could only cancel.

- The halt is named by the author, so it can be granted, timed and measured by identity (principle 8, principle 17).
- Its decision shape is fixed by the kernel, so the kernel knows how to apply it.
- Scenario 3 keeps the cancelling form.

**Left open:**

- **Halt address** (known weakness 3). Two raises of one halt in a flow differ only by `seq`. No battery scenario asks for metrics by address, so no address field is added.
- **Locks held across a job in one lane.** See rule 7.
- **One supervisor session over two harnesses** (scenario 7, known weakness 8). Each harness registers its own supervisor client, and the adapter's session reaches both endpoints. There is no entity naming "one session".

## Principles broken

None.

The parent's break of principle 12 (`failsTo`) is repaired by deleting `failsTo`. Its break of principle 15 (the quota option on the ledger) is repaired by moving the partition onto the account.
