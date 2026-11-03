# harness-dsl: minimal, read through OTP (child of g01-minimal-0-2-2--0-2-2-2)

Operator lens: **redesign the execution model through Erlang/OTP**. The model covers units, attempts, re-entry, cancellation, time and external events.

The owner's vocabulary is kept. A lens word replaces an owner word only where it is clearly better:

- `call` replaces `run` (rule 0).
- `postpone` replaces `deferred` (rule 3).
- *Exit* names how an attempt ended, beside its outcome.
- *Monitor* is the mechanism behind waiting on children and behind order.

## The OTP reading in one table

| OTP | harness-dsl | Consequence |
|---|---|---|
| gen_statem process | **unit** | A unit's named states are its statem states. Each state declares a position. The unit lives as long as the work, for years if needed (Tenancy). |
| Process spawned and linked to the statem for one job | **attempt** | It has one exit: `normal` → succeeded, `error` → failed, `shutdown` → cancelled. Exit reasons are the track record. The attempt dies, the unit does not. |
| Mailbox | **the unit's messages** | Every supplier update is a message to an existing unit (`MessageEntry`). It is never a second unit. |
| `postpone` in gen_statem | `{ update, postpone: true }` | A postponed message is held while the attempt is at `active`, and delivered at the next point where it can be handled (rule 3). |
| `exit(Pid, shutdown)` | outside cancellation | A delivered message that moves the state shuts the live attempt down. Its outcome is `cancelled`. |
| Supervisor restart intensity | `H.retry(name, { retries, backoff })` on a lane | The lane restarts failed attempts within a declared bound, then moves the unit to the declared `exhausted` state. |
| Named generic timeout (re-setting replaces it) | `H.on.deadline` | The timer is a ledger entry. Re-arming supersedes the old timer, so an old deadline can never fire (rule 4). |
| `state_timeout` | `halt.timeout(after, f)` | Measured from the recorded raise. Resolved by `clock`. The attempt continues. |
| `monitor` / `'DOWN'` | `ctx.wait(state, { children })`, `lane.order` | The parent sees children's terminal transitions, as recorded on the ledger. |
| Node restart | harness restart | Not a process exit. Attempts resume by replay. A crash is never an `error` exit (rule 8). |
| `gen_server:call` | `ctx.call(executable, input)` | One invocation. |

**What OTP does not supply, and is kept owner-shaped:**

- Positions.
- Verdicts.
- Halts as entities.
- Policies as deterministic functions.

A process that waits in OTP still exists, but a unit at `waiting` holds no capacity. That is the owner's rule, and the lens does not override it.

## Entities

| Sort | Entity | Builder | Is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A statem state with a position. Terminal states require a verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, sort)` | Experience or taste. |
| Kind | halt | `H.halt(n, decision).about().timeout().policy()` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing. |
| Kind | facet | `H.facet(n, schema)` | A declared metric dimension. |
| Kind (kernel-owned) | `H.parked` | — | The one halt the kernel raises itself. Its decision is `resume \| restart \| abandon`, and its about carries the reason. |
| Instance | account, model, runner, store, memory store, quota partition, supplier, ledger, guard, observer, client | adapters | Each carries its backend. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)` | role × models × choice policy. |
| Pivot | lane | `H.lane(n, kind).handler().suppliers().store().wip().retry().order()` | kind × suppliers × store × handler, plus the restart and admission rules for its units. |
| Pivot | journal | `H.journal(n, memory, store)` | memory kind × store. |
| Pivot | pool | `H.pool(n, members, policy?)` | accounts × policy. |
| Pivot | trigger | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, retry, report, operation | as named | Executables, bounds, named queries, grants. |

### The new nouns

**`H.report(name, read)`** is a named, deterministic query over `Metrics`.

- It is registered with `harness.reports(...)`.
- It is rendered by the telemetry observer.
- It is served by `ControlApi.telemetry.report(report)`.
- A policy reads it by calling `report.read(metrics, now)`.
- This is the answer to "a policy elsewhere must be able to ask": the parent pasted metrics into halt text. No scenario does that any more.

**`H.batch(name, seat)`** is a job. Its submit and collect are the seat's model driver's `submit` and `collect`. Each item is its own invocation, with `batchOf` naming the job invocation. Items are priced with `batchDiscount`.

**`H.retry(name, { retries, backoff })`** is a declared bound.

## Execution vocabulary

| Word | Definition |
|---|---|
| Run | One lifetime of a harness process, the node. Nothing else is called run. |
| Attempt | One execution of a lane's flow for one unit. Status is running, blocked, waiting or ended. Exit is normal, error or shutdown, recorded as outcome succeeded, failed or cancelled. |
| Invocation | One `ctx.call` of one executable. Each retry is an invocation, and each batch item is an invocation. |
| Message | One supplier update addressed to an existing unit. |
| Step | Not a word. |

## Rules

### 0. `call`, not `run`

`ctx.run` and `act.run` used the word that defines a process lifetime (principle 22). They are now `ctx.call` and `act.call`.

### 1. Skeleton (principle 12)

**Position.**

| Condition | Position |
|---|---|
| A running attempt | `active` |
| A blocked attempt (halt), a waiting attempt (timer, children) or a job in flight | `waiting` |
| No live attempt | The position its state declares |

**How an attempt ends.**

| Attempt ends with | Exit | Outcome | Unit |
|---|---|---|---|
| A returned state | `normal` | succeeded | Moves to that state. |
| `ctx.fail` or a throw | `error` | failed | Restarted under the lane's retry. When exhausted, moves to the lane's `exhausted` state. |
| A message moving the state, `act.move`, an operation, preemption, a ceiling without `over`, or `H.parked` → `abandon` | `shutdown` | cancelled | Handled by whatever caused it. |

**The default.** A lane with no `.retry` restarts unboundedly: backoff from 1 minute, capped at 1 hour. It never exhausts, so it needs no end state.

**A human "no" is a state, not a failure.** In the parent's scenario 9 a rejected draft called `ctx.fail` and was laundered into `escalated` through retry exhaustion.

- The rule now stated: a halt decision returns the flow to a state, or loops inside the attempt.
- `ctx.fail` is for an executable that did not do its job.
- The drafter's track record is charged only for its own failures.

### 2. Retry: one bound, one meaning (critique 2)

`H.retry('three', { retries: 3, backoff: { initialMs: 60_000, factor: 2 } })`.

- **`retries` counts re-tries after the first try**, so total tries = `retries + 1`. This is stated once, in the kernel, and nobody writes a boundary comparison.
- `retries: 0` means never retry.
- Kernel `RetryView` is `{ retriesUsed }`, renamed from `failures`, which meant two counts.

| Attached to | It restarts | When exhausted |
|---|---|---|
| `lane.retry(retry, exhausted)` | attempts of a unit | The unit moves to `exhausted`, a state of the lane's kind (checked at startup). |
| `command.retry(retry)` | that invocation | The flow receives the failed `Result`. |

The thing being restarted is fixed by the attachment, exactly as an OTP supervisor's intensity applies to its own children.

### 3. Mailbox (external events)

A supplier's `{ update: key, ... }` is a message to unit `key`. It is recorded as `received`.

| Unit is at | Plain message with `state` | `postpone: true` |
|---|---|---|
| `active` | Delivered now. The patch applies, the state move shuts the attempt down (cancelled), and the unit re-enters at that state. | Recorded `postponed`. Delivered when the attempt reaches `waiting`, or after the attempt's own move if it ends first. |
| `waiting` | Delivered now. Same as `active`. | Delivered now. Same as `active`. |
| `pending` | The patch and the move apply. | The patch and the move apply. |
| `terminal` | Recorded. Ignored unless it moves the unit to a non-terminal state (re-opening). | Recorded. Ignored unless it moves the unit to a non-terminal state (re-opening). |

How the battery's events map onto this:

- A customer reply during approval is a plain message, so the attempt is cancelled and the unit returns to classifying.
- A redline during drafting is postponed, so it is neither dropped nor fatal and is applied in the next round.
- A redline during counsel is delivered at `waiting`, so it re-enters at drafting.
- A vendor reply in a Negotiation moves `their-turn` → `our-turn`. That is a new attempt for the same unit.

Messages are ledger entries. A message received while the harness was down is supplied again by its supplier (webhooks retry, polls re-read), and supply keys deduplicate it.

### 4. Time (named timers)

**`H.on.deadline(kind, due, whileIn)` is one named timer per unit, named by its trigger.**

**Arming.** The kernel computes `due(data)` and records `timer armed { trigger, due }` at each of these points:

- the unit enters a `whileIn` state;
- the kernel applies a patch to its data (a message, `ctx.update` or `work.update`);
- the unit's store is reloaded.

**Supersession.** When the new due differs from the armed one, the previous entry is recorded `superseded` in the same transaction.

**Withdrawal.** Leaving the `whileIn` states records `withdrawn`.

**Firing.** A timer fires only if it is the latest `armed` entry for `(trigger, unit)`.

So an extended SLA (`work.update(conversations, key, { slaDueAt })`, granted by `writeWork`) moves the timer, and the old deadline cannot fire. After a restart, `Ledger.armedTimers(now)` finds timers that came due while the process was down.

**Halt timeouts** are `state_timeout`s on the attempt's blocked status. They run from the recorded `raised` entry, never from unit data. They resolve with `resolver: 'clock'` and the attempt continues.

### 5. Halts and grants (critique 1, principle 17)

**The blanket grant is gone.**

- `H.ops.resolveHalts` is **deleted**.
- The only way to grant resolution is `H.ops.resolve(...halts)`, which names halt entities.
- The kernel-owned `H.parked` halt must be granted by name like any other.

So one concept has one word, and no grant is a capability string.

**The control API is typed by descriptors.**

- `work.create(lane, data)` checks `data` against `T`.
- `work.move(lane, key, state)` checks `state` against `S`.
- `halts.resolve(halt, id, decision)` checks `decision` against `D`.
- `memory.*` take the journal.
- `accounts.setShare` takes the pool and the account.
- `telemetry.report` takes the report.

**Transports carry names.** A client adapter receives a `Registry` and converts each wire name to its descriptor:

- An unknown name is refused before the kernel sees it.
- A decision is parsed with `halt.decision` before it reaches the kernel.
- A client whose grants do not cover a method is refused, and the refusal is recorded `refused`.

`Operation.methods` is a typed union of control methods, not strings.

**Halt addressing.**

- `HaltEntry.occurrence` numbers the raises of one halt within an attempt: 1 for the first, 2 for the second.
- `EntryFilter.occurrence` lets metrics tell the first `go-no-go` from the second.
- `Metrics.medianBy` gives decision time per halt and per resolver.

### 6. Credits: operator uptake without coupling a halt to seats (critique 3)

The parent's `editorReview` decision hard-coded `actedOnA` and `actedOnB`, so the halt knew which seats existed.

**Now:**

- Every `Result` carries its `invocation` id.
- `ctx.halt(halt, show, about, { credit: [first, second] })` offers those invocations to the resolver. They appear in `HaltView.offers` with their seat and output.
- The resolver passes `credited` invocation ids to `halts.resolve`.
- The kernel records one `CreditEntry` per offered invocation, with typed `seat`, `role` and `model` columns and `credited: true | false`.

**The halt's decision schema knows nothing about seats.** Uptake per seat is computed like this:

```
rateBy({ among: { entry: 'credit', role }, count: { entry: 'credit', role, credited: true }, by: 'seat' })
```

Per model, use `by: 'model'` on credit entries.

**`{ modelOf: seat }` on any entry.**

- **What it groups by.** It groups an attempt-scoped entry (a halt resolution, a command invocation, an attempt end) by the model of that seat's latest invocation earlier in the same attempt.
- **Entries that cannot be grouped.** An entry whose attempt never invoked the seat is not a sample. It is dropped from both `among` and `count`, and the drop is visible in the sample count.
- **Why.** "Approval rate by drafter model" (scenario 2) and "citation-check pass rate by synthesizer model" (scenario 3) are metrics over entries that carry no model column. Before this, `modelOf` was only defined for credit entries.
- **What it costs.** No new column, no facet repeating a column, and no type change.

**Consequences.**

- Adding a third reviewer is one more element in `credit`.
- Renaming a seat starts a new series by design, because the seat is the series key.
- Swapping a model does not start a new series.

### 7. Lane: four principle concerns plus restart and admission (critique 3)

**The lane now carries:**

- kind, handler, suppliers, store (principle 8's pivot);
- `wip` and `order`, which are inputs principle 16 assigns to the scheduler per lane;
- `retry`, which principle 12 assigns to the lane.

**Removed from the lane:**

- **`locks`** moved to **commands** (`command.locks(input => Lock[])`). A lease is held for the life of the invocation, and released at its end.
  - An invocation interrupted by a crash with recovery `park` keeps its lease until `H.parked` is resolved.
  - So a crashed migration keeps its exclusive lock, and no backfill can run against a database the harness cannot vouch for.
  - Step-scoped locking (the adversary's scenario 13) falls out of this: a lock is not held while a job runs between two locked commands.
  - A Backfill holds its shared lock per batch. A Migration therefore waits at most one batch, and never interleaves with a batch.
- **`maxUsdPerUnit`** moved to the **flow** (`flow.maxUsdPerUnit(limit, over?)`). The flow is what spends, and the ceiling is per unit across its attempts. The `over` halt has kernel-fixed `CeilingAbout` and `CeilingDecision`. `continue: true` raises that unit's ceiling by one more `limit`.

**`order` has no back door.**

- Only the scheduler starts attempts, and the scheduler enforces order.
- `work.move` can move a unit out of `onEarlierFailure` only to a state of its kind. If that state is `pending`, the order check (a monitor on every earlier unit) runs again before any attempt.
- There is no operation that starts an attempt.

**What a parked unit carries.** It shows `H.parked` with `reason: 'earlier-failed'` on the board.

### 8. Durability (the node restarts, processes resume)

**Writer.** On start, `Ledger.claimWriter(run, ttlMs)` is taken. A live writer refuses a second start. A dead writer whose ttl has lapsed is taken over, recorded as `took-over`.

**Replay.** Every non-terminal attempt is replayed from `Ledger.replay(attempt)`:

- recorded invocation results are returned without calling;
- recorded halt resolutions, timers, messages and spawns are returned as recorded.

The flow body re-executes deterministically against recorded values. That is the author's only constraint, and the same constraint OTP's replay-free design avoids by keeping state in the process.

**Live state found, not replayed.** Each kind of outside state is read fresh from its own record:

| State that may have moved while down | How it is found |
|---|---|
| A halt resolved while down | Its `resolved` entry exists. |
| A job | Its handle is polled. It is never resubmitted. |
| A batch | Collected by its handle. |
| A child | Its terminal transitions are read. Running children are not restarted. |

**The interrupted invocation** follows its executable's recovery:

| Recovery | Behaviour |
|---|---|
| `'rerun'` | The invocation runs again. |
| `'park'` | `H.parked` with `reason: 'interrupted'`. |
| A probe | `true` → recorded finished. `false` or a failed probe → parked. |
| A seat | The model driver's `recover`. |
| A job | Its poll. |

**Changed definitions.** A changed flow fingerprint parks the attempt with `reason: 'definition-changed'`. `resume` is refused for that reason.

**What `H.parked` decisions do.**

| Decision | Effect |
|---|---|
| `resume` | Re-invokes the interrupted invocation. The operator vouches for it. |
| `restart` | Starts the same attempt id from the top. |
| `abandon` | Shuts the attempt down as cancelled. The unit moves to the lane's `exhausted` state. A lane that can park must declare `.retry` (startup error otherwise). |

**What a crash is not.** It is not an `error` exit. The attempt keeps its id and is counted once in every metric. Models, seats and accounts are never charged for it.

**The author writes `.recovery` on commands that are not safe to rerun, and nothing else.**

### 9. Jobs (one submit-and-collect step kind)

`ExternalJob<I, O>` is the only submit-and-collect executable. There are two builders:

- `H.job(name).output(z).submit(cmd).collect(poll, every)` for an outside service;
- `H.batch(name, seat)` for a model batch.

While a job is in flight:

- the attempt is at `waiting`;
- WIP and runner slots are released;
- the handle is on the ledger.

A remote failure is an `error` exit, and so an attempt failure. `ctx.batch` is **deleted** (known weakness 2).

### 10. Accounts and quota (principle 15)

Unchanged from the parent:

- the account names its `QuotaPartition`;
- the partition is append-only and is folded at read time;
- shares stay on pools, per harness;
- there is no ledger option for quota.

### 11. Entities, not strings, in filters

`EntryFilter` changes:

- `state` takes `State` descriptors.
- `status` is the typed union of ledger statuses.
- `lane`, `halt`, `executable`, `trigger`, `model` and `role` take descriptors.

Decision matching should be built with `halt.resolved({ match, by })`, which is typed by `Partial<D>`.

### 12. Startup validation

`start()` fails in each of these cases:

- duplicate names, including halts, resources, facets, seats, reports, and `H.parked`'s reserved name;
- a facet repeating a column;
- flow states outside the lane's kind;
- a `wait` or `order` target at the wrong position;
- a `retry` exhausted state outside the kind;
- a lane whose flow can park (a `park` or probe recovery, or any seat) without a declared `.retry`;
- a trigger on an unregistered lane;
- a report reading an unregistered lane;
- a seat no pool can serve;
- a command without argv or runners;
- a batch on a model without `submit` and `collect`;
- a halt (including `H.parked` and ceiling halts) that is raised but granted to no client and has no timeout or policy;
- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

| Change | Reason |
|---|---|
| `H.ops.resolveHalts` deleted. Kernel-raised halts unified as `H.parked`, granted by name. | Critique 1: a blanket capability string, and two words for one grant (principles 17, 22). |
| Control API typed by descriptors. `Registry` for transports. `Operation.methods` typed. `EntryFilter.state` and `status` typed. | Critique 1: the API was string-typed (principle 8). |
| `H.retry(name, { retries, backoff })` replaces hand-written retry policies. `RetryView.retriesUsed`. | Critique 2: three boundary conventions in three scenarios. "Retries" is now defined once. |
| `H.batch` returns an `ExternalJob`. `ctx.batch` deleted. | Critique 2 and known weakness 2: two submit-and-collect step kinds. |
| `CreditEntry` and `ctx.halt(..., { credit })`. | Critique 3: a halt's decision schema encoded seat identities. |
| `locks` moved to commands. `maxUsdPerUnit` moved to flows. | Critique 3 and known weakness 6: the lane had ten concerns. It now has the four principle 8 names, plus the three rules principles 12 and 16 assign it. |
| No operation starts an attempt. `work.move` re-enters the order monitor. | Critique 3: the `order` back door. |
| Mailbox semantics (`postpone`, delivery by position). `MessageEntry`. | OTP lens. Messages to units are first-class and recorded, so "neither dropped nor fatal" is a ledger fact. |
| Named timers with supersession (`TimerEntry`). `Ledger.armedTimers`. | OTP lens and the scenario 9 critique: SLA extension, where the old deadline must never fire. |
| Attempt `exit` beside `outcome`. | OTP lens. It makes plain that a node crash is not an exit at all. |
| `HaltEntry.occurrence`, `Metrics.medianBy`. | Known weakness 3 and the adversary's scenario 13: two raises of one halt are distinguishable. |
| `H.report` and `harness.reports`. `telemetry.report`. | Scenario 9 critique: required metrics were stuffed into prompts. |
| `ctx.run` / `act.run` renamed `call`. | Principle 22: "run" is a process lifetime. |
| `ctx.fail` reserved for executables that did not do its job. | Scenario 9 critique: a human rejection was charged to the drafter and laundered into a neutral verdict. |
| `{ modelOf: seat }` defined for every attempt-scoped entry, not only credit entries (rule 6). | Writing scenarios 2 and 3: approval rate by drafter model, and citation-check pass rate by synthesizer model, are rates over halt and command entries, which carry no model column. The `Dimension` type already allowed it; only its meaning was missing. |

**Left open:**

- One supervisor session across two harnesses (known weakness 8). Each harness registers its own client.
- Counted resources: semaphores with more than one holder. They are not in the battery (principle 21).
- Turning outcomes into candidate memories automatically (known weakness 10). Triggers still author it.
- A command cannot record memory itself. Scenario 6's fact-check command reports repeat mistakes, and the flow records them.

## Principles broken

None.
