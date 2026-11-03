# harness-dsl: minimal, renamed (child of g01-minimal-0-2-2--0-2-2-1)

The operator is **rename**. The weakest noun in the parent is **`library`**, the pivot memory kind × store. The brief and principle 8 call this pivot a *journal*, and the battery says "taste journal" and "journal of operational experience" throughout. The principle defines a journal as memory kind × store × **recall**, and the parent's library had no recall slot, so the wrong noun hid a missing part of the pivot.

The fix:

- `H.library` becomes **`H.journal(name, memory, store, recall?)`**.
- The optional recall is a registered **`H.policy.recall`**.
- Everything that touched library is adjusted: `Seat.recalls` and `Seat.records`, `ctx.remember`, `act.remember`, `MemoryItem.journal`, `MemoryStore.list(journal)`, `MemoryStore.search({journal})`, and `ControlApi.memory.*(journal)`.

While the operator was renaming, two collisions of one word for two things (principle 22) were renamed as well. Both are renames, not new concepts.

| Old | New | Why |
|---|---|---|
| `H.clock` (supplier) | **`H.schedule`** | "Clock" was also a halt resolver (`resolver: 'clock'`). Principle 16 already names this supplier a *schedule*. "Clock" now means only the timeout resolver. |
| `ctx.wait` and attempt status `'waiting'` | **`ctx.suspend`** and attempt state **`suspended`** | "Waiting" is now only a position. See critique 2 below. |

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A shareable lifecycle position. A terminal state carries its verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about().timeout().policy()` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing that locks, memory scope and the `resource` column reference. |
| Kind | facet | `H.facet(n, values)` | A declared metric dimension and memory-scope axis. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | A specific thing with its backend. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)` | Role × model, chosen at attempt time. It is the metric column for a role. |
| Pivot | lane | `H.lane(n, kind).handler(flow[, params]).retries(n, {backoff?, exhausted})` then `.suppliers() .store() .wip() .maxUsdPerUnit() .locks() .sequence() .facet()` | A work queue: kind × suppliers × store × handler. |
| Pivot | **journal** | `H.journal(n, memory, store, recall?)` | A place memory is kept and recalled from: memory kind × store × recall. |
| Pivot | pool | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | trigger | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation, harness | | Unchanged from the parent. |

The kernel exports three halts in `H.halts`: `interrupted`, `definitionChanged` and `costCeiling`. All three take the decision `{ action: 'restart' | 'continue' | 'abandon' }`.

## Execution vocabulary (one word each)

| Word | Meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. |
| **Attempt state** | `running`, `blocked`, `suspended` or `ended`. |
| **Outcome** | What an ended attempt reports: `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable. |
| **Retry** | Running the same thing again after it failed. A lane retries attempts; a command retries invocations. |

The attempt states:

- **`blocked`** means waiting on a halt. Per principle 12, this is the one place a human wait is recorded.
- **`suspended`** means waiting on a timer, children, a job or batch in flight, or a lock.

## Rules

### 1. Skeleton (principle 12)

**Positions.**

| Attempt | Unit position |
|---|---|
| `running` | `active` |
| `blocked` or `suspended` | `waiting` |
| No live attempt | The position its state declares |

"Waiting" is a position and nothing else.

**Every lane declares its retry bound, and the type system enforces it.**

- `H.lane(n, kind).handler(flow)` returns a `LaneHandled`.
- `LaneHandled` has exactly one method, `.retries(n, { backoff?, exhausted })`, and only that returns a `Lane`.
- `harness.lanes()` takes `LaneRef`, which only `Lane` satisfies.
- There is no kernel default and no unbounded retry.
- `retries(0, { exhausted })` means "do not retry".
- When the bound is exhausted, the unit moves to `exhausted`, a state of the lane's kind, and nowhere else.
- Startup also rejects an `exhausted` state that is not in the kind.

**Cancellation does not land in a track record.** A cancelled attempt, whether by supply, trigger, operation or preemption, is recorded with `cancelledBy`. Its invocations end with status `cancelled`. Seat, model, runner and account rates count only succeeded and failed attempts, and ok and not-ok invocations.

### 2. Supply into a live unit

`Supply.update` takes `cancels?: ('active' | 'waiting')[]`. When an update arrives, the kernel looks at the unit's position:

- **No live attempt:** the update applies at once.
- **A live attempt whose position is listed in `cancels`:** the attempt is cancelled (`cancelledBy: 'supply'`) and the update applies at once.
- **Otherwise:** the update is deferred, recorded, and applied when the attempt ends. Deferred updates are counted in `UnitRecord.deferredSupply`.

The default is to defer. `deferred: true` is removed.

How the battery uses this:

| Scenario | Update | `cancels` | Behaviour |
|---|---|---|---|
| 2 | Customer reply | `['active', 'waiting']` | The attempt is cancelled and the unit returns to classifying. |
| 11 | Redline | `['waiting']` | While `draft` runs, the redline is deferred. While waiting on counsel, the attempt is cancelled and the unit re-enters at `draft`. |

### 3. Entities, not strings

**Facets come from data, not from flow side effects.**

- `lane.facet(facet, data => value | undefined)` declares how a unit's facet value is read.
- `ctx.facet` is deleted.
- Every entry about a unit is stamped with the facet value its data has at that moment. This covers transitions, attempts, invocations, halts, leases, and firings caused by the unit.
- A flow that learns a category writes it with `ctx.update`. From then on, every entry carries it.
- A firing of a metric trigger grouped by a facet is stamped with its group's facet value. So `count({ of: { entry: 'firing', trigger, facets: [category.of(v)] } })` counts real firings.
- A facet named like a column is a startup error.

**Breakdowns are keyed by entity.** `rateBy` returns a `Breakdown<K>`, which has `keys` and `of(key): Rate`. `of` returns a zero-sample rate for an absent key.

| `by` | Returns |
|---|---|
| A `Facet<V>` | `Breakdown<V>` |
| `{ modelOf: seat }` | `Breakdown<Model>`, read as `byModel.of(sonnet)` |

No model is addressed by its name string. Grouped metric triggers take `Breakdown<V>`.

**Preflight is a command.**

- `ssh.host({ preflight })` takes an `Executable<void, unknown>`.
- The kernel runs it on the candidate runner before placement.
- It is a recorded invocation, so it has a ledger row, recovery and metrics.
- A command used only as a preflight needs no `.on()`.

**Kept as strings, on purpose.** These are backend configuration inside adapters, which principles 5 and 7 permit:

- `http.store.stateField`, the external system's field name;
- `qdrant.embedder`, the vendor's model identifier;
- linear `statuses`.

None of them names a harness entity, so no entity is being replaced by a string.

### 4. Memory and recall (principle 14)

- The kernel owns the envelope.
- Candidates are not recalled until they are accepted.
- Recall scope is the attempt's kind, the seat's role, the unit's facet values, and the resources it has locked or named in `RunOptions.resources`.

**Without a recall policy,** a journal uses the kernel ranking: specificity first, then the success rate of attempts each item was present in.

**With `H.policy.recall`,** the policy receives a `RecallChoice` and returns the items to recall. The `RecallChoice` holds:

- the candidates, as `RankedItem`, each with its specificity, the store's `similarity` when it is a vector store, and its success `Rate` with sample counts;
- the scope;
- the limit;
- the metrics.

Similarity is an input to the policy. The policy itself stays deterministic, and its decision is recorded.

### 5. Triggers

These are unchanged from the parent, with three clarifications.

**A self-move on `enters` is atomic.** When an `on.enters` trigger moves the same unit, the move is applied in the same ledger transaction as the transition it fired on, so no attempt can start in between. This closes the race the adversary found in scenario 11's return bound:

- `returned` is entered for the second time;
- the unit moves to `declined` in the same transaction;
- no attempt starts, so no attempt is cancelled.

**A create reuses keys by position.** `act.create(lane, data, key)` behaves as follows:

- If a non-terminal unit has that key, nothing is created, and the firing records `deduplicated`.
- If the only unit with that key is terminal, a new unit is created with a new id, and the latest unit per key is the current one.

**One firing per crossing.** Hysteresis is the parent's: `trip`, `reset` and `minSamples`.

### 6. Scheduler, locks, ordering, jobs, cost, quota, durability

These are unchanged from the parent:

- WIP and slots are held only at position `active`.
- Locks are scoped either to an invocation (on a command) or to an attempt (on a lane).
- A parked holder keeps its locks, and they stay visible.
- `lane.sequence` orders a lane's units, with a parked exit.
- A job is submitted, then collected, and is never resubmitted.
- `maxUsdPerUnit` is cumulative.
- `Account.quota` is a `QuotaPartition`, and the ledger is the default partition.
- Restarts replay by invocation `seq` and use each command's `.recovery`.
- A changed definition parks the attempt on `definitionChanged`.
- `claimWriter` ensures a single writer.

One rule changes. Suspension on children, a timer, a job or a lock is now spelled `ctx.suspend(state, until)`. The state must be a `waiting` state of the kind, and the board shows it. The attempt's state is `suspended`.

### 7. Control API (principle 17)

Grants name halts. "Either person may resolve" (scenario 11) is two clients, each granted `H.ops.resolve(signoff)`. The first resolution wins and is recorded with its `by`.

### 8. Startup validation

`start()` fails, naming the offender, on each of these:

**Names and references**

- duplicate names across all entity sorts;
- a facet named like a column;
- a trigger, spawn or create on a lane that is not registered.

**States**

- a flow state, `exhausted` state or `sequence` parked state that is not in the lane's kind;
- a parked state or `suspend` state that is not a waiting state.

**Seats, models and recall**

- a seat model, or a policy candidate, that no pool serves;
- a batch on a model without `submit` and `collect`;
- a recall policy on a journal whose memory kind no seat recalls.

**Executables and halts**

- a command with neither runners nor a role as some host's preflight;
- a halt whose `.timeout` or `.policy` reads facts but has no `.about`.

**Harness**

- a missing ledger.

A missing lane retry bound cannot reach startup, because it does not type-check. A harness with no pools, seats or models is valid.

## What changed and why

| Problem | Change |
|---|---|
| Operator: weakest noun | `library` becomes `journal`, which gains its principle-8 recall part (`H.policy.recall`, `RecallChoice`, `RankedItem`). |
| Principle 22: `clock` meant both a supplier and a resolver | The supplier is `H.schedule`. |
| Critique 1: the kernel retry default was unbounded and broke principle 12 and scenario 11 | `LaneHandled` makes `.retries(n, { exhausted })` mandatory at the type level. The default is deleted, and scenario 8's lanes must now declare bounds. |
| Critique 2: "waiting" had four meanings | Only the position is called "waiting". The attempt state is `suspended` and the flow verb is `ctx.suspend`. `deferred` is replaced by `cancels`, which is stated in positions. `LiveView.position` is typed `LivePosition`, a subset of position, not a new idea. |
| Critique 3a: facets were imperative and invisible to firings | `lane.facet(f, read)` derives facets from data. Every entry is stamped, including grouped firings. `ctx.facet` is removed. |
| Critique 3b: model keys were strings | `Breakdown<K>.of(key)` takes entities, and `rateBy({ modelOf })` returns `Breakdown<Model>`. |
| Critique 3c: the preflight was a shell string | `preflight` is an `Executable`, so it has a ledger row and metrics. The remaining adapter strings are argued above as backend configuration. |
| Scenario 11: a redline during counsel did not re-enter | `cancels: ['waiting']`. |
| Scenario 11: the deputy could not resolve | A second client granted `resolve(signoff)`. |
| Scenario 11: the return bound raced the scheduler | `enters` self-moves are atomic with the transition. |
| Scenario 9: `auditsOpened` was always 0 | Grouped firings carry the facet value. |
| Scenario 9: key reuse was unspecified | Defined by position (rule 5). |
| Cancelled attempts counted against seats | `cancelledBy` is recorded, and cancellations are excluded from track-record rates. |

**Surface.**

- Added: `H.journal` (renamed), `H.schedule` (renamed), `ctx.suspend` (renamed), `H.policy.recall`, `Lane.facet`, `LaneHandled`, `Breakdown`, `Supply.cancels`.
- Removed: `H.library`, `H.clock`, `ctx.wait`, `ctx.facet`, `Supply.deferred`, the kernel retry default, the string-keyed `rateBy` return, and string preflights.

### Weaknesses left open

- **Known weakness 3 and the adversary's scenario 13.** Two gates of one halt in one flow are still told apart only by `seq`. Grants, timeouts and policies sit on the halt entity, so scenario 13 needs two halt entities. The cure is an address noun, a new entity, not a rename, so it is left for a later operator.
- **Batch and job remain two forms.** The parent's reason still holds: the batch discount is a model-only price.

## Principles broken

None.

The parent claimed none while breaking principle 12 through its unbounded default retry. That break is repaired here: the default is gone, and a lane without a declared bound does not type-check.
