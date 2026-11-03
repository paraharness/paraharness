# harness-dsl: minimal, scenario 9 fixed (child of g01-minimal-0-2-2--0-2-2-2)

Operator: **scenario-fix**. The worst-handled scenario was **9, a harness watching itself**. The adversary named four defects there:

- no SLA extension;
- human rejection booked as attempt failure;
- "a policy elsewhere" answered inside a flow;
- approval rate by model dropped.

This child repairs all four. It also repairs the adversary's three sharpest critiques of the parent:

- capability strings and a string-typed control API;
- the two meanings of `RetryView.failures`, plus the batch/job overlap;
- a halt coupled to seats, plus an overloaded lane.

## Entities

| Sort | Entity | Builder | Is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A shareable lifecycle position. A terminal state requires a verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about(z).timeout(after, f).policy(rule).credits(select)` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing that locks and scope reference. |
| Kind | facet | `H.facet(n, schema)` | A declared metric dimension whose values come from data. |
| Kind | **deadline** | `H.deadline(n, kind, due, whileIn)` | A named, recorded unit timer. It can be rescheduled. |
| Kind | retry | `H.retry({ times, firstDelayMs?, factor?, maxDelayMs? })` | A declared bounded backoff. |
| Kernel | `H.parked` | — | The kernel's own halt for attempts the kernel will not resume blindly. |
| Instance | account, model, runner, store, memory store, quota partition, supplier, ledger, guard, observer, client | adapters only | Each carries its backend. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)...` | role × models × choice policy. |
| Pivot | lane | `H.lane(n, kind).handler().suppliers().store().wip().maxUsdPerUnit().retry().order()` | kind × suppliers × store × handler. |
| Pivot | journal | `H.journal(n, memory, store)` | memory kind × store, under the kernel's recall. |
| Pivot | pool | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | trigger | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Pivot | **report** | `H.report(n, read)` | Metrics × a name: a telemetry projection that observers render and clients read. |
| Composite | flow, command, job, policy, operation | as named | Executables and decisions. |
| Root | harness | `H.harness(n)...reports()...start()` | The running thing. |

**Execution vocabulary** is unchanged:

| Word | Definition |
|---|---|
| Run | One process lifetime. |
| Attempt | One execution of a lane's flow for one unit. |
| Invocation | One call of one executable. A job is one invocation, including a model batch. |
| Step | Not a word. |

## Rules

### 1. Skeleton (principle 12)

These are unchanged from the parent:

- position derives from the attempt, then the state;
- a flow returns a state, which means succeeded;
- `ctx.fail` or a throw means failed, and the unit goes to pending under the lane's retry;
- an outside move or a preemption means cancelled.

**A human decision is never an attempt failure.** A flow that receives a rejection from a halt either loops (redraft with the reviewer's notes) or returns one of the kind's states. The battery never `ctx.fail`s on a decision.

**Why this matters:**

- Model and seat track records count only work that broke.
- The quality signal from humans is the halt's own decision series. It is read as approval rate by `{ modelOf: seat }`.

This is the repair for scenario 9's "rejection recorded as failure, laundered into neutral by retry". In scenario 9 a draft rejected three times ends at `escalated` (neutral) by the flow's decision. No retry policy is involved.

### 2. Retry: one declared shape, one meaning

`H.retry({ times, firstDelayMs = 60000, factor = 2, maxDelayMs = 3600000 })` is a kernel-implemented deterministic policy. Its parameters are declared.

- **`times` counts retries, never tries.** `times: 3` means one try and up to three retries, so four tries at most. `times: 0` means no retry.
- **Delay.** The delay before retry *n* (starting at 1) is `min(firstDelayMs × factor^(n−1), maxDelayMs)`.

There are two attachment points. Each counts the thing it is attached to:

| Attached with | Counts | When exhausted |
|---|---|---|
| `lane.retry(retry, exhausted)` | Failed attempts of the unit | The unit moves to `exhausted`, a state of the lane's kind, checked at startup. |
| `command.retry(retry)` | Failures of that one invocation | The flow receives the failed `Result`. |

**Without `lane.retry`**, retry is unbounded backoff, so there is no exhaustion and no end state is needed.

`H.policy.retry`, `RetryView` and `RetryDecision` are deleted. The boundary ambiguity the adversary found (`>3`, `<3`, `>=3` across scenarios 5, 11 and 12) cannot be written any more.

### 3. Waits, success rate, outside moves, supply

These are unchanged from the parent:

- `deferred` updates are held while the attempt is at `active` and applied at `waiting`;
- success rate is `success / (success + failure)`, with neutral excluded and samples shown;
- supply keys deduplicate.

### 4. Entities, not strings

**Filters.** `EntryFilter` takes descriptors throughout:

- **Lane, halt, trigger, deadline, seat, resource:** given as descriptors.
- **`state`:** a `State` entity.
- **`status`:** the typed union `EntryStatus` of every entry's statuses.

**Decision matching.** A decision match is no longer an untyped record. `halt.resolved(match?: Partial<D>, by?)` builds the filter, and the match it carries is typed by the halt's decision schema. Facets are unchanged.

**The control API is descriptor-typed.**

- `work.create(lane: LaneRef, …)`, `work.move(key, state: StateRef, reason)`, `memory.list(journal: JournalRef)`, `deadlines.move(deadline: DeadlineRef, …)`, `accounts.setShare(pool: PoolRef, account: Account, …)`, `telemetry.report(report: ReportRef)` and `custom.invoke(operation: Operation, …)` all take descriptors.
- `halts.resolve(id, decision)` takes a raised-halt entry id. The kernel checks that the client holds a grant naming *that entry's* halt.

**Transports.** A transport adapter (HTTP, an MCP supervisor) receives names on its wire. It resolves them through `ControlApi.entities`, the harness's registered descriptors, and refuses unknown names.

- Payloads (`data`, `patch`, `decision`) are validated by the kernel against the kind's or the halt's schema.
- Strings exist only on the wire, as they must.
- `Operation.methods` is the closed union `ControlMethod`.

### 5. Halts (principle 17)

**Grants.**

- `H.ops.resolveHalts` is **deleted**. It was a blanket capability, and it duplicated `H.ops.resolve(...)` under a second word.
- Every grant names its halts: `H.ops.resolve(h1, h2)`.

**`H.parked`.** The kernel's own parked state is the kernel halt `H.parked`, of type `Halt<ParkDecision, ParkAbout>`. It is granted by identity like any other: `H.ops.resolve(H.parked)`.

- **About:** `ParkAbout.reason` is one of:
  - `definition-changed`;
  - `interrupted` (recovery `'park'`);
  - `probe-negative`.
- **Decision:**

| Decision | Effect |
|---|---|
| `rerun` | Reruns the interrupted invocation. |
| `continue` | Records the interrupted invocation as finished, with an optional `output` validated against its schema. |
| `restart` | Cancels the attempt, outcome `cancelled` (never `failed`), and starts a new attempt from the top. |
| `abandon` | Cancels the attempt and moves the unit to the given state of its kind. |

**Resolvers** are human, policy or clock, as before.

**Credits.** `halt.credits((decision, about) => invocationIds)` records one `credit` entry per credited invocation. Each entry carries the seat, role and model columns of that invocation, read from the ledger. `Result` now carries `invocation`, so the flow can place invocation ids in `about`.

This is the repair for scenario 6:

- **The halt knows no seat.** The editor's decision lists which critiques were acted on, by the invocation ids presented in `about`.
- **The metric keys on the seat.** Uptake per seat is `rateBy({ among: invocations of the reviewer role, count: credits of editorReview, by: 'seat' })`. Per model, it is `by: { modelOf: seat }`.
- **Renames and new seats are safe.** Renaming a seat or adding a third reviewer changes neither the halt nor the series.

### 5a. Cost ceiling

Unchanged: `lane.maxUsdPerUnit(limit, over?)` either cancels the attempt, or raises an author-named ceiling halt.

### 6. Deadlines (the scenario 9 repair)

`H.deadline(name, kind, due, whileIn)` is an entity. It is referenced by `H.on.deadline(deadline)` and by the grant `H.ops.reschedule(deadline)`.

**Arming.**

- When a unit enters a state in `whileIn` from outside the set, or is created in one, the kernel evaluates `due(data)` once.
- It records `deadline armed { dueAt }`.
- The ledger entry is the timer. Unit data is read only at arming.

**Withdrawal.** Leaving the `whileIn` set records `withdrawn`.

**Rescheduling.**

- A granted client calls `deadlines.move(deadline, unit, dueAt, reason)`.
- The kernel records `moved { dueAt, by, reason }`.
- Later data updates do not re-arm. Only a move or a re-entry does.

**Firing.**

- The kernel fires only against the latest `armed` or `moved` entry for `(deadline, unit)`. The firing is recorded as `fired` with the `dueAt` that fired.
- The old deadline cannot fire, because it is no longer the latest entry. This holds across restarts, since timers are re-derived from the ledger.

**Scenario 9.** The reviewer extends an SLA through the supervisor, which holds `H.ops.reschedule(sla)`. The breach timer moves with it.

**Other scenarios** use the same entity. In scenario 5 the 09:00 cancel arms at unit creation from `night`. In scenario 8, negotiation expiry is a deadline.

Halt timeouts stay on the halt and run from the recorded raise (principle 17). They are not deadlines.

### 7. Scheduler, capacity, locks, order

**The scheduler view** is `{ pending, active, waiting, paused }`. `paused` lists lanes paused by a trigger, from `LaneEntry`.

**Capacity.** WIP and runner slots are held only at position `active`.

**Locks moved from the lane to the command.** `command.locks(input => Lock[])` leases for that invocation.

| Situation | What happens to the lease |
|---|---|
| The invocation runs | Held. |
| Backoff between retries | Released, then reacquired. |
| An interrupted invocation whose recovery is `park` | Held until `H.parked` is resolved. A crashed migration keeps its database locked, and the board shows the lease beside the park. |

Lock wait is recorded on `LeaseEntry`. Consequences:

- Scenario 12's backfill takes its shared lock per batch.
- Its migration takes an exclusive lock for the apply invocation only.
- An EvalRun holds nothing while its GPU job runs.
- The adversary's step-scoped lock case (`apply`, `canary`, `promote`) is expressible as it stands.

**Order.** `lane.order(by, onEarlierFailure)` is unchanged, with the exit stated:

- `work.move` out of `onEarlierFailure` into a pending state re-enters the order check. It cannot bypass ordering.
- The only ways out of order are:
  - an earlier unit succeeding;
  - a move to a terminal state, which is recorded with its reason.

### 8. Jobs: one submit-and-collect executable (known weakness 2)

`ctx.batch` is **deleted**. `H.job(name)` has two constructions:

| Construction | Type |
|---|---|
| `.output(z).submit(cmd).collect(poll, every)` | An external job. |
| `.batch(seat)` | `Job<I[], Result<O>[]>`: a model batch through the seat's chosen model's `submit` and `collect`. |

Both are one invocation of mode `job`.

- A job holds no WIP and no runner slot while in flight: the attempt is at `waiting`.
- On restart, a job is collected from its recorded handle, never resubmitted.
- A batch's invocation entry sets `batchDiscounted`, so telemetry prices it at the discount.

### 9. Durability, quota, accounts

Durability is unchanged:

- replay from the ledger;
- `.recovery` on commands;
- the seat's recovery is the driver's `recover`;
- a fingerprint change raises `H.parked` (`definition-changed`);
- `claimWriter` gives single-writer exclusion.

Quota is unchanged:

- the account names its `QuotaPartition`;
- the partition is append-only;
- the window is folded at read time.

### 10. Reports: "a policy elsewhere" (scenario 9 repair)

`H.report(name, (metrics, now) => Record<string, Measurement>)` names a telemetry projection, registered with `harness.reports(...)`.

- `markdown.telemetry` renders every report.
- Clients read reports with `telemetry.report(ref)`, granted by `readTelemetry`.
- A `Measurement` is a `Rate` or `Mean` (with samples), or a count.

**What it replaces.** `ctx.decide` is **deleted**. Pasting metric summaries into halt prompts (scenarios 9, 11 and 12) was the symptom.

**How the battery's questions are answered.** The questions are ordinary `Metrics` queries, which any policy can make:

| Question | Query |
|---|---|
| Audits opened per category this month | `count({ of: { entry: 'firing', trigger: approvalWatch, status: 'tripped', group } })` |
| Total paused time | `sum({ of: 'durationMs', among: { entry: 'lane', lane, status: 'resumed' } })` |
| Halt decision times | Medians of `decisionMs` by halt and resolver |
| Retries per lane | `count` of `attempt retrying` per lane |
| GPU job hours | `sum` of job invocation duration |
| Lock wait | `mean` of `lockWaitMs` by resource |

The battery puts them in reports. No flow reads metrics.

### 11. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names, including halts, deadlines, reports, resources, facets and seats;
- a facet that repeats a column;
- flow states outside the lane's kind;
- a `wait` or `order` target at the wrong position;
- a `retry` exhausted state outside the kind;
- a deadline whose `whileIn` contains a terminal state;
- a deadline grant naming an unregistered deadline;
- a trigger or report referencing an unregistered lane, deadline or trigger;
- a seat that no pool serves;
- a batch job whose seat may choose a model without `submit` and `collect`;
- a command without argv or runners;
- a halt with a reading resolver but no `.about`;
- a halt with `.credits` but no `.about`;
- a ceiling halt, or `H.parked` while any command declares `park` or a probe recovery, that no client may resolve;
- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

| Change | Reason |
|---|---|
| `H.deadline` entity. `H.on.deadline(deadline)`. `deadlines.move`. `H.ops.reschedule(...)`. `DeadlineEntry`. | Scenario 9: an SLA extension that re-arms the timer, where the old deadline provably never fires. The timer is now ledger state, not a re-read of unit data. |
| `H.report`, `harness.reports`, `telemetry.report`. `ctx.decide` deleted. | Scenario 9 critique, and repeats in 11 and 12: required metrics were pasted into prompts because there was no projection entity. |
| Rule: decisions are not failures. | Scenario 9: human rejection was charged to the drafter and laundered to neutral by retry. |
| Approval rate by model restored in 9 via a drafter model policy keyed on `{ modelOf: drafter }`. | Scenario 2's requirement, dropped in 9. |
| `H.ops.resolveHalts` deleted. `H.parked` kernel halt. Control API typed by descriptors. `ControlApi.entities`. `ControlMethod` union. `EntryStatus`. `State` in filters. `DecisionMatch` via `halt.resolved`. | Critique 1: capability strings (principle 17), two words for one grant (principle 22), and strings at the client boundary (principle 8). |
| `H.retry({ times, … })` replaces retry policy functions. `times` counts retries. | Critique 2: one number, one meaning, no boundary convention left to authors. |
| `ctx.batch` deleted. `H.job(n).batch(seat)`. `InvocationMode` loses `'batch'`. | Critique 2 and known weakness 2: one submit-and-collect executable. |
| `halt.credits(...)`. `CreditEntry`. `Result.invocation`. | Critique 3: scenario 6's halt hard-coded `actedOnA` and `actedOnB`. Credit now attaches to invocations, and the metric keys on seat or model. |
| `lane.locks` moved to `command.locks`. | Critique 3 and known weakness 6: the lane sheds a concern. Locks are step-scoped, which serves scenario 12 and the adversary's scenario 13. |
| `order` exit stated: a move re-enters the check. | Critique 3: `work.move` could bypass ordering. |

## Left open

- **Halt address** (known weakness 3). Two raises of one halt in a flow differ by `seq`. No battery scenario needs metrics per raise.
- **Counted resources.** Not in the battery.
- **One supervisor session over two harnesses** (known weakness 8).
- **The lane's remaining concerns.** The lane still carries seven: kind, handler, suppliers, store, wip, ceiling, retry and order. Retry is placed there by principle 12. Order and ceiling are per-lane operational decisions about one kind. No noun was found for splitting them that would not be a single-use entity (principle 21).

## Principles broken

None.

The retry spec is a deterministic policy whose parameters are declared and whose function the kernel authors. It reads recorded failure counts at decision time and never changes itself, so principle 4 holds.
