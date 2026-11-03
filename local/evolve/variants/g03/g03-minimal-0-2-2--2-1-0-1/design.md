# harness-dsl: minimal, power-off fixed (child of g02-minimal-0-2-2--2-2-1-0)

The operator is **scenario-fix**. The worst-handled scenario, per the critique, is **10, the power goes off**. It had four defects:

- a fake batch model;
- no declaration of which pool serves which model;
- a hand-unpacked one-item batch;
- a recovery probe with no recovery of its own.

All four come from one missing pivot (pool × model) and one misplaced capability (batch as a model). This child repairs those first. Then it answers the adversary's other two sharpest critiques (seat identity smuggled through decision fields, and moves mid-attempt) and the principle 22 bonus (`retries` used for two scopes).

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A shareable lifecycle position. A terminal state carries its verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about().timeout().policy().credits()` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing, referenced by locks, memory scope and the `resource` column. |
| Kind | facet | `H.facet(n, values)` | A declared metric dimension and memory-scope axis. |
| Instance | model | adapter (`anthropic.model(id)`) | A model's identity and price. It has no driver. |
| Instance | account | adapter (`claudeCode.subscription`, `anthropic.account`) | A credential plus the driver that serves calls: `call`, `recover`, and optionally `submit`/`collect`. |
| Instance | runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters | Unchanged. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)[.recovery()][.batched()]` | Role × model, chosen at attempt time. It is the metric column for a role. |
| Pivot | lane | `H.lane(n, kind).handler(flow[, params]).attempts(max, {backoff?, exhausted})` then `.suppliers() .store() .wip() .maxUsdPerUnit() .locks() .sequence() .facet()` | A work queue: kind × suppliers × store × handler. |
| Pivot | journal | `H.journal(n, memory, store, recall?)` | Memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, [{ account, share, serves: [models] }], policy?)` | **Accounts × models × policy**: which account serves a given call of a given model. |
| Pivot | trigger | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation, harness | | Unchanged. |

### Kernel halts

The kernel exports three halts in `H.halts`. Each now has the decision that fits it:

| Halt | Decision |
|---|---|
| `interrupted` | `{ action: 'continue' \| 'rerun' \| 'abandon' }`. `continue` records the interrupted step as finished. |
| `definitionChanged` | `{ action: 'restart' \| 'abandon' }`. Scenario 10 allows only these two. |
| `costCeiling` | `{ action: 'continue' \| 'abandon', raiseUsd? }` |

## Execution vocabulary (one word each)

| Word | Meaning |
|---|---|
| Run | One process lifetime. |
| Attempt | One execution of a lane's flow for one unit. A lane bounds attempts with `.attempts(max, …)`. |
| Attempt state | `running`, `blocked` (on a halt), `suspended` (timer, children, job, batch or lock), or `ended`. |
| Outcome | `succeeded`, `failed` or `cancelled`. |
| Invocation | One call of one executable. Its mode is `model`, `batch`, `command` or `job`. |
| Retry | Invoking the same executable again inside one attempt after it failed (`Command.retries`). |

**Principle 22 bonus.** "Retry" now has one scope: the invocation. A lane no longer "retries". It declares how many **attempts** a unit gets: `.attempts(max, { backoff?, exhausted })`, where `max` counts the first attempt. Scenario 11's "retries three times" is `attempts(4)`. The metric "retries per lane" counts `attempt` entries with status `retrying`, meaning an attempt started after a failed one.

## Rules

### 1. Pools serve models (critique 1, scenario 10 defect 2)

Each pool member declares `serves: Model[]`. This is the pool × model pivot, named and in the pool. The kernel matches nothing by provider string. `provider` is deleted from both Model and Account.

**How the account for a model invocation is chosen:**

1. Candidates are every member, of every registered pool, that serves the invocation's model.
2. If the seat is batched, candidates are further narrowed to accounts that implement `submit` and `collect`.
3. The pool's `AccountPolicy` receives `AccountChoice { kind, seat, model, mode, accounts }` and picks one.
4. If several pools have candidates, they are asked in registration order, and the first non-null answer wins.

The policy sees the kind, the seat and the model. So "PrivilegedMemo never on the subscription" (the adversary's scenario 13) is one line in a policy.

**What the model does now.** The model no longer drives calls. `Account.call(model, request)` does. A Claude subscription and an API account both serve the one `sonnet` entity, so its track record is one series. The serving account is the `account` column on the invocation.

**Startup errors added by this rule:**

- a seat model, or a model-policy candidate, that no member serves;
- a batched seat whose model no batch-capable account serves.

**Still open.** The startup check "opus chosen for a kind whose permitted accounts do not serve it" is not computable. Kind permission lives in an opaque policy, and flows are opaque about which seats they run. At runtime it surfaces as an attempt failure with reason `no account serves`. It is not counted against the model, because no invocation happened.

### 2. Batch is a mode of a seat (scenario 10 defects 1 and 3; known weakness 2)

`seat.batched()` returns a `BatchedSeat`, whose every invocation is submitted to the serving account's batch API and collected later.

| Call | Behaviour |
|---|---|
| `ctx.run(batchedSeat, input)` | One request in one submission. It returns `Result<O>`, so there is no unpacking. |
| `ctx.batch(batchedSeat, inputs)` | One submission of many requests (scenario 3's fan-out). It accepts only a `BatchedSeat`. |

The model is the real model. The invocation's `mode` is `batch`, and cost is priced with `price.batchDiscount`. A batch in flight is an attempt `suspended` and holds no WIP or runner slot.

**Why batch is not merged into job.** A job is a pair of commands written by the author. A batch is the account driver's `submit`/`collect`, with memory, guards and pricing owned by the kernel. They share the restart rule (collect, never resubmit) and the capacity rule, which are stated once in rule 6 for both.

### 3. Recovery is declared on every effect, and probes are safe (scenario 10 defect 4)

| Executable | Declared with | Options | Default |
|---|---|---|---|
| Command | `.recovery(...)` | `'rerun'`, `'park'`, or a probe executable returning `boolean` | `'park'`: what is not declared safe is never repeated. |
| Seat | `.recovery(...)` | `'ask'` (ask the account driver's `recover`), `'rerun'`, `'park'` | `'ask'`. Scenario 10 writes it explicitly for `review`. |
| Job | — | — | Submit follows the submit command's recovery. Once a handle is recorded, it is always collected. |

**A probe, preflight or stop-check command must declare `.recovery('rerun')`.** Otherwise `start()` fails. A crash during the probe therefore reruns the probe, and the probe never recurses: it is the bottom of recovery.

If the probe returns `true`, the step is recorded as finished (`recoveredBy: 'probe'`). If it returns `false`, the step is rerun.

### 4. Restart, as scenario 10 states it

The mechanism is replay by invocation `seq` from the ledger.

**What is recorded.** Every step the flow takes through `ctx` is recorded with a `seq` and its result, and on replay the recorded result is returned without re-executing. The recorded steps are `run`, `batch`, `halt`, `decide`, `spawn`, `update`, `move`, `remember` and `suspend`.

**What the harness author writes:** a `recovery` on each non-idempotent command, and nothing else.

| Situation after restart | What the kernel does |
|---|---|
| A step that completed before the crash | Replayed from its recorded result. Costs 0. |
| The step running at the crash | Handled by its declared recovery (rule 3). `park` raises `H.halts.interrupted` with `ParkedFacts`. |
| A halt resolved while the harness was down | Resolved through `Ledger.request(OperationEntry)`, which any process may append without the writer lock, like quota events. On start, the writer applies pending requests in order before scheduling. The flow continues from the halt. |
| A batch or job with a recorded handle | Collected, never resubmitted. |
| A suspension on children | Re-read from the children's recorded transitions. Finished children are seen. Running children are untouched, because they are other units' attempts. |
| Any resumed attempt | Keeps its id and gets an attempt entry `resumed`. The interrupted invocation is marked `interrupted` and excluded from model, seat, runner and account rates. A crash is never an outcome. |
| A changed definition | Detected by comparing the flow fingerprint, and the step names and order up to the recorded `seq`, with the replay. On a mismatch the attempt parks on `H.halts.definitionChanged`: restart from the top (same unit, new attempt, no attempt bound consumed) or abandon (`cancelled`, `abandoned: true`). |

**Single writer.** `claimWriter(harness, run, ttl)` takes the writer claim, and `renewWriter` heartbeats it.

- A second process gets `refused` while the claim is fresh.
- It gets `took-over` only after the TTL lapses, which means the first process is dead.
- A writer that fails to renew stops scheduling at once.

### 5. Credits: seat identity in human decisions (critique 2)

`halt.credits(decision => seats)` declares which seats a decision credits. The credited seats are recorded on the `HaltEntry` as its `seat` column, a typed column, not a decision field.

- `EntryFilter.seat` matches halt entries that credit that seat.
- `rateBy({ by: { modelOf: seat } })` attributes a halt entry to the model that seat ran in the same attempt.

Scenario 6 therefore keys its A/B on the seats:

- "the editor acted on reviewer A" is `{ ...editorial.resolved(), seat: reviewerA }`;
- a rename of the seat moves the whole series with it, because every column follows entity names.

The parent's two reviewer policies could converge on one shared spare model. Scenario 6 now gives each reviewer its own disjoint candidate list, so the two seats can never run the same model. The kernel does not forbid overlap in general, because one role on one model in two seats is legitimate elsewhere.

### 6. Moves on live units, state versus position (critique 3)

**A move cancels a live attempt.** A move of a unit with a live attempt cancels that attempt first, in one ledger transaction. This applies to a move by trigger, operation or supply.

- The attempt ends `cancelled` with `cancelledBy`, its open halt or suspension is closed, and its locks are released.
- The unit then takes the new state.
- Cancelled attempts stay out of every track record.

This defines scenario 2's SLA breach during approval, scenario 5's 09:00 cut-off, scenario 9's audit cancellation and scenario 8's negotiation expiry.

**State and position are two answers to two questions, on purpose (principle 12).**

- The *state* is the kind's lifecycle name. `new` stays `new` while it is being worked.
- The *position* is what the scheduler does with the unit. It is the state's declared position when no attempt is live, and otherwise is derived from the attempt (`running` gives `active`; `blocked` or `suspended` give `waiting`).
- `whileIn` and `enters` match states, and WIP matches positions.
- The board shows both, for example `new · waiting (blocked on replyApproval)`. Neither answer is a lie, and neither is a second answer to the same question.

**Exhaustion cannot dead-end.**

| `exhausted` state | Startup |
|---|---|
| Terminal | Accepted. |
| Waiting | Accepted only if some client is granted `writeWork`, so the operator can wake it. The board lists the unit as parked by exhaustion, with the last failure. |
| Pending | Rejected, because it would loop. |

### 7. Unchanged from the parent

- Supply into a live unit with `cancels`; otherwise the update is deferred.
- Facets derived from data via `lane.facet`, with every entry stamped.
- `Breakdown<K>`, keyed by entity.
- A preflight is a command.
- Journals and recall policies.
- Trigger atomic self-moves, key reuse by position, and hysteresis.
- WIP and slots held only at `active`.
- Lock scopes, and parked holders keeping their locks.
- `sequence`, jobs, the cumulative `maxUsdPerUnit`, and quota partitions.
- Grants that name halts, with the first resolution winning.

### 8. Startup validation

`start()` fails, naming the offender, on each of these.

**Names and references**

- duplicate names;
- a facet named like a column;
- a lane referenced by a trigger, spawn or create but not registered.

**States**

- a flow, exhausted or sequence state outside the lane's kind;
- a parked or `suspend` state that is not waiting;
- a pending `exhausted` state;
- a waiting `exhausted` state with no `writeWork` client.

**Seats and models**

- a seat model or model-policy candidate no pool member serves;
- a batched seat with no batch-capable serving account;
- a recall policy on a journal no seat recalls.

**Executables and halts**

- a probe, preflight or stop check without `.recovery('rerun')`;
- a command with neither runners nor a host preflight role;
- a halt whose `.timeout` or `.policy` reads facts but has no `.about`.

**Harness**

- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

| Problem | Change |
|---|---|
| Scenario 10: the batch was a fake model id | Batch became a seat mode (`.batched()`), the model became a pure identity and the account became the driver. One `sonnet`, one series. |
| Scenario 10: which pool serves what was undetermined; critique 1 (missing pool × model pivot, string matching on provider) | `PoolMember.serves`, an `AccountChoice` carrying kind, seat, model and mode, and `provider` deleted. The "no pool serves" check is now computable. |
| Scenario 10: one-item batch unpacked by hand | `ctx.run(batchedSeat, input)` returns `Result<O>`. `ctx.batch` is only for fan-out. |
| Scenario 10: the recovery probe had no recovery | Probes, preflights and stop checks must declare `rerun`. A command's default recovery is `park`. A seat's recovery is declarable (`'ask'` by default). |
| Scenario 10: a halt resolved while the harness was down needed a path | `Ledger.request`, a writer-free append applied on start. |
| Scenario 10: `definitionChanged` offered `continue` | The kernel halts got per-halt decision types. |
| Scenario 10: a dead writer had to be taken over | `renewWriter` heartbeat alongside `claimWriter`. |
| Critique 2: seat identity in decision fields; reviewers converging on one model | `Halt.credits` puts the seat column on halt entries. Scenario 6 gets disjoint candidate lists. |
| Critique 3: moves mid-attempt undefined; state and position disagree; dead-end exhaustion | A move cancels the live attempt atomically. State and position are argued as distinct by principle 12 and both shown on the board. Exhaustion is limited to terminal states, or waiting states the operator can wake. |
| Bonus, principle 22: `retries` with two scopes | The lane uses `.attempts(max, …)`. "Retry" means an invocation retry only. |

**Surface.**

- Added: `PoolMember.serves`, `Seat.batched`, `BatchedSeat`, `Seat.recovery`, `Halt.credits`, `Ledger.request`, `Ledger.renewWriter`, three decision types, and `AccountChoice.{kind, seat, model, mode}`.
- Removed: `claudeCode.model`, `Model.call/recover/submit/collect` (moved to Account), `Model.provider`, `Account.provider`, and `LaneHandled.retries` (renamed `attempts`).
- `ControlApi.halts.resolve` now takes `seq`, so two gates of one halt in one flow are addressable (part of known weakness 3).

## Principles broken

None.

- **Principle 8** reads that an instance carries its backend. The account now carries the model driver, and the model carries identity and price. Both are still instances, and the pool is the pivot between them.
- **Principle 15** holds: `Ledger.request` is an append-only partition folded by the writer, exactly like quota events, not a second store or a lock.
