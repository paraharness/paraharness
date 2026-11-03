# harness-dsl: minimal, split (child of g02-minimal-0-2-2--2-2-1-0)

The operator is **split**. The entity doing two jobs is **`Model`**. In the parent, a `Model` instance did two things:

1. **Identity.** It was the thing a seat picks, the `model` column metrics key on, and the price telemetry applies.
2. **Serving.** It was the transport that calls, recovers, submits and collects. It was bound to an account through an unnamed `provider` string the kernel matched against `Account.provider`.

Because serving lived on the model, the parent had these defects:

- No entity could say which account serves which model. This is the adversary's critique 1, and it is the seed's known weakness 5, "pool serves models".
- Batch had to be faked as a second model (`claude-sonnet-4-5-batch`). That split one model's track record into two series.
- `AccountPolicy` could not see what it was serving, so scenario 13 could not be expressed.

**The split.**

| Entity | What it is now |
|---|---|
| **`Model`** | Pure identity plus price: `{ entity: 'model', name, price }`. Price includes `batchDiscount`. It has no methods and no provider. |
| **`Account`** | Gains the serving job. `serves: Model[]` and `batches: boolean` say what it offers. `call`, `recover`, `submit?` and `collect?` take the model as an argument. An account is an instance, so carrying its backend and offering fits principle 8. `provider` is deleted, and so is the string match. |

**What follows.**

- **A pool serves what its members' accounts serve.** Model availability becomes a derived property of the pool. This answers known weakness 5 without a new pivot noun.
- **A member may be restricted to kinds:** `{ account, share, kinds? }`. This is a relationship on the pool, which is a pivot. It is not a relationship on the kind, so principle 10 holds.
- **Batch is a call mode of a real model.** `ctx.batch(seat, inputs)` runs the seat's chosen model through a member account with `batches: true`. Telemetry prices it with `model.price.batchDiscount`. The invocation row has `mode: 'batch'` and the same `model` column. One model has one series.
- **`ctx.batch` returns a tuple-mapped result.** `const [summary] = await ctx.batch(s, [x])` is typed `Result<O>`, with no `undefined` check. Scenario 10's hand unpacking disappears.

**Surface the split adds:** `Account.serves`, `Account.batches`, `PoolMember.kinds`, and `AccountChoice.{kind, seat, model, mode, metrics}`.

**Surface the split removes:**

- `Model.provider`, `Model.call`, `Model.recover`, `Model.submit` and `Model.collect`, which move to `Account` with a model argument;
- `Account.provider`;
- `claude-code.model`. A model identity is declared once, in `harness-dsl/anthropic`, and served by both a subscription account and an API account.

The net is four fields added and seven members removed.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A shareable lifecycle position. A terminal state carries its verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about().timeout().policy()` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing. |
| Kind | facet | `H.facet(n, values)` | A declared metric dimension and memory-scope axis. |
| Instance | model | adapter (`anthropic.model`) | A model identity with its price. It is a metric column. |
| Instance | account | adapter (`claudeCode.subscription`, `anthropic.account`) | A credential, a quota partition, the models it serves, whether it batches, and the transport. |
| Instance | runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters | Unchanged from the parent. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)` then `.creditedBy(halt, when)` | Role × model, chosen at attempt time. |
| Pivot | lane | `H.lane(n, kind).handler(flow[, params]).retries(n, {backoff?, exhausted})` | A work queue. Unchanged from the parent. |
| Pivot | journal | `H.journal(n, memory, store, recall?)` | Memory kind × store × recall. |
| Pivot | pool | `H.pool(n, members, policy?)` | Accounts × policy. It serves the union of its members' `serves`, optionally restricted per member to kinds. |
| Pivot | trigger | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation, harness | | Unchanged from the parent, except that `Command.retries` is renamed `Command.reinvoke` (see below). |

## Execution vocabulary (one word each)

| Word | Meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. |
| **Attempt state** | `running`, `blocked` (on a halt) or `suspended` (on a timer, children, a job or batch, or a lock), then `ended`. |
| **Outcome** | `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable. |
| **Retry** | A new **attempt** after a failed attempt. It is declared only on the lane: `Lane.retries`. |
| **Reinvoke** | A new **invocation** of the same command inside the same attempt after it failed. It is declared only on the command: `Command.reinvoke(times, backoff)`. |

The parent used "retries" for both, which broke principle 22. That collision is repaired by the rename. The ledger status `retrying` belongs to attempts; `reinvoking` belongs to invocations.

## Rules

### 1. Skeleton (principle 12)

**Positions.**

| Attempt | Unit position |
|---|---|
| `running` | `active` |
| `blocked` or `suspended` | `waiting` |
| No live attempt | The position its state declares |

**The board shows both state and position**, for example `new · waiting (blocked on replyApproval)`.

These answer two different questions, and principle 12 rules that they are different:

- **State** is where the unit stands in its lifecycle. It is the kind's vocabulary and does not change while an attempt runs.
- **Position** is what the scheduler sees.

`H.on.deadline(kind, due, whileIn)` matches on state. That is the right question for an SLA ("still unanswered"), whatever the attempt is doing. This answers critique 3's "two answers to where is it". The answers are not contradictory; they are two columns, and both are shown.

**Lane retry bound.** It is mandatory at the type level, as in the parent. The `exhausted` state must satisfy all of the following, and startup checks them (critique 3: the dead end):

- it is a state of the lane's kind;
- it is **not** at position `pending`, which would be an unbounded loop in disguise;
- if it is at position `waiting`, the lane has at least one supplier able to update units. The operator counts, because `writeWork.move` can wake it.

A waiting exhaust state on a lane with no supplier is rejected as a dead end. Scenario 8's `review-stalled` is accepted only because the tenancy lane has `H.operator` and the review calendar.

**Cancellation does not land in a track record.** This is unchanged.

### 2. A move on a unit with a live attempt (critique 3, defined)

Any move of a unit whose attempt is live, whether by `act.move` from a trigger, `ControlApi.work.move` from an operation, or a supply update that carries `state`, is applied in **one ledger transaction**, as follows:

1. The live attempt ends `cancelled`, with `cancelledBy` set to the mover (`trigger`, `operation` or `supply`). Its invocations end `cancelled`, and its halts are withdrawn, so they are no longer resolvable.
2. Attempt-scoped leases are released.
3. The transition is recorded with `cancelledAttempt: <id>`.

A non-idempotent step that was in flight is not "rerun". Its invocation is recorded `cancelled`, its command's `.recovery` is consulted exactly as on a crash, and a `park` recovery parks the unit in its new state with the reason.

For `Supply.update` without `state`, rule 3 applies: defer, or cancel per `cancels`.

How the battery uses this:

| Scenario | Mover | Effect |
|---|---|---|
| 2 | SLA breach, `whileIn ['new']` while blocked on approval | Cancels the attempt and moves to `escalated`. This is intended: a breached conversation stops waiting for approval. |
| 5 | `approvalWindowCloses` | Cancels the blocked approval attempt and moves to `expired`. This is what the scenario asks for. |
| 9 | The Audit reset move | Cancels the attempt blocked on `auditFindings` and moves to `audit-cancelled`. |
| 8 | `negotiationExpiry` | Cancels any live round. |

In none of these is the cancellation counted against a seat, model, runner or account.

### 3. Supply into a live unit

This is unchanged from the parent. An update arriving during a live attempt is:

- applied, if the unit has no live attempt;
- applied with cancellation, if the attempt's position is listed in `cancels`;
- otherwise deferred and applied when the attempt ends.

### 4. Serving a model call (the split, critique 1)

For an invocation of seat `s` in an attempt of kind `k`:

1. **Candidates.** The kernel computes the servable set: the models served by some member of some registered pool whose `kinds` is absent or includes `k`. For a batch, only members with `batches: true` count.
2. **Model choice.** `ModelChoice.candidates` is the seat's candidates intersected with the servable set, and the model policy picks from it. A policy that returns a model outside the set is a recorded refusal, and the attempt fails with reason `unservable model`, at kernel cause, not seat cause.
3. **Pool.** The **one** pool that serves `(model, k)` is used. Two registered pools serving the same model for the same kind is a startup error, so which pool serves a call is never guesswork.
4. **Account choice.** The pool's `AccountPolicy` receives `AccountChoice { kind, seat, model, mode, accounts, metrics }`. `accounts` lists only members that serve the model, permit the kind and, for a batch, batch. Without a policy, the kernel takes the first eligible member under its share.
5. **The invocation row** records `model`, `account` and `mode`.

The per-model, per-account and per-kind cost columns make "cost per account per kind with sample counts" a plain `sum` or `mean` query (adversary scenario 13).

**Scenario 13 under this rule.**

- The subscription member is declared `{ account: max, share, kinds: [publicFaq] }`, so `PrivilegedMemo` never reaches it, whatever its eligibility.
- `opus` is served only by the API account. It is servable for `PrivilegedMemo` and for `PublicFaq` alike, because both kinds may reach the API member.

**What is decided at startup, and what at attempt time.** Startup checks the following:

- every seat model, and every model-policy candidate, is served by some pool for some kind on a registered lane;
- every seat used in `ctx.batch` has a batch-capable serving member;
- no two pools overlap on `(model, kind)`;
- every `PoolMember.kinds` entry is a kind on a registered lane.

"Opus chosen for a kind whose permitted accounts do not serve it" is checked statically only where it can be, as above. A flow is a function, so the kernel does not know statically which seats a lane's flow uses. The per-kind residue is therefore enforced at choice time, by intersecting the candidates, and never by silently serving through a forbidden account.

### 5. Seat credit from a halt decision (critique 2)

`seat.creditedBy(halt, when)` declares that a resolution of `halt` credits this seat when `when(decision)` is true. The relationship lives on the seat, which is the pivot. It does not live on the halt, which is a kind (principle 10), and the halt's schema does not know seats.

When the halt resolves, its ledger entry records two lists, each as typed `{ seat, model }` pairs, using the model each seat ran with in that attempt:

- `eligible`: every crediting seat that ran in the attempt;
- `credited`: the seats whose predicate held.

`EntryFilter.credited` is a seat column. `rateBy({ by: { modelOf: seat } })` over halt entries keys on the recorded model of that seat.

Scenario 6 therefore reads like this:

```
reviewerA.creditedBy(editorial, d => d.actedOn.includes('first'))
among: { ...editorial.resolved(), credited: undefined }  // eligible rows for the seat
count: { ...editorial.resolved(), credited: choice.seat }
```

The consequences:

- **Renaming a seat cannot orphan the series.** The series keys on the seat entity's column, and the decision's own field values are local to the halt.
- **A seat credited by a halt it never shares an attempt with** shows zero samples, not an error.

**Two seats of one role whose model candidate sets overlap are a startup error.** Two reviewers in one A/B must not converge on one model. Scenario 6 gives each reviewer its own distinct challenger.

### 6. Recovery probes

A recovery probe is the executable passed to `.recovery(probe)`. It is run as `rerun`, whatever is declared on it, because a probe is a read. Declaring `.recovery` on a command used only as a probe is a startup error.

A crash during the probe re-runs the probe. If the probe itself fails, the attempt parks on `H.halts.interrupted` with the probe's error. This answers the adversary's scenario-10 point 4.

### 7. Unchanged from the parent

- Facets are derived from data with `lane.facet`, and every entry is stamped.
- Breakdowns are keyed by entity.
- Preflight is a command.
- Memory and recall work as before, with `H.policy.recall` over `RankedItem`, which carries similarity and success rate.
- An `enters` self-move is atomic. A create reuses keys by position. Hysteresis is `trip`, `reset` and `minSamples`.
- The scheduler holds WIP and slots only at `active`.
- Locks: invocation-scoped or attempt-scoped.
- `lane.sequence` with a parked exit.
- Jobs: submitted once, then collected.
- `maxUsdPerUnit` is cumulative.
- Quota partitions.
- Replay by `seq`.
- `definitionChanged` parking.
- `claimWriter`.
- Grants name halts.

### 8. Startup validation

`start()` fails, naming the offender, on each of the following.

**Names and references**

- a duplicate name, or a facet named like a column;
- a trigger, spawn or create on an unregistered lane.

**States and lanes**

- a flow state, `exhausted` state or `sequence` parked state that is not in the kind;
- a parked state or `suspend` state that is not a waiting state;
- an `exhausted` state that is pending, or that is waiting on a lane with no supplier.

**Serving**

- a seat model or policy candidate that no pool serves;
- two pools serving one `(model, kind)`;
- a `PoolMember.kinds` entry that is on no lane;
- a batch seat with no batch-capable serving member.

**Seats**

- two seats of one role with overlapping candidate sets;
- `creditedBy` on a halt that is never registered on any client grant or resolver.

**Memory, executables and halts**

- a recall policy on a journal no seat recalls;
- a command with neither runners nor a role as a preflight or probe;
- `.recovery` declared on a probe;
- a halt whose `.timeout` or `.policy` reads facts but has no `.about`.

**Harness**

- a missing ledger.

A harness with no pools, seats, models or accounts is valid (scenario 4).

## What changed and why

| Problem | Change |
|---|---|
| Operator: `Model` did two jobs (identity and transport) | Split. `Model` is identity plus price. `Account` serves models and holds the transport. `Account.provider` and `Model.provider` are deleted. |
| Critique 1: no pool × model pivot; a string `provider` match | Pools serve what their accounts serve. One pool per `(model, kind)` is checked at startup. `AccountChoice` sees `kind`, `seat`, `model` and `mode`. Members may be restricted to kinds. Adversary scenario 13 becomes expressible. |
| Critique 1: a fake batch model | Batch is a call mode of the real model on a batch-capable account. One series per model, priced with the model's `batchDiscount`. |
| Critique 1: hand-unpacked batch | `ctx.batch` returns a tuple-mapped `BatchResults`. |
| Critique 1: the probe had no recovery | Probes always rerun, and a failed probe parks on `interrupted`. |
| Critique 2: seat identity inside decision fields | `Seat.creditedBy(halt, when)`, plus the `HaltEntry.eligible` and `HaltEntry.credited` seat-and-model columns and `EntryFilter.credited`. Overlapping candidate sets for one role are a startup error. |
| Critique 3: a move mid-attempt was undefined | Rule 2: one transaction that cancels the live attempt with `cancelledBy` and records `cancelledAttempt` on the transition. |
| Critique 3: state against position | Both are shown. `deadline` matches state on purpose (rule 1). |
| Critique 3: a dead-end exhaust state | `exhausted` may not be pending, and may be waiting only on a lane with a supplier. |
| Bonus: "retries" meant two things | `Command.retries` is renamed `Command.reinvoke`. Retry now means only a new attempt. |
| Telemetry: cost per account | `EntryFilter.account` and the `account` column. |

**Surface delta.**

- Added: `Account.serves`, `Account.batches`, `PoolMember.kinds`, `AccountChoice.{kind, seat, model, mode, metrics}`, `Seat.creditedBy`, `HaltEntry.{eligible, credited}`, `EntryFilter.{credited, account}`, `TransitionEntry.cancelledAttempt` and `BatchResults`.
- Removed: `Model.{provider, call, recover, submit, collect}`, `Account.provider` and `claude-code.model`.
- Renamed: `Command.retries` becomes `Command.reinvoke`.

### Weaknesses left open

- **Known weakness 3, a halt's address in a flow:** still told apart only by `seq`.
- **Batch and job remain two forms.** The batch discount is a model price, and a batch runs through an account's quota; a job does neither.
- **The per-kind serving check is partly dynamic** (rule 4), because flows do not declare their seats.

## Principles broken

None.

- **Principle 8** names the pool "accounts × policy". Its serving set is derived from its accounts, which are instances carrying their backend and offering, so the pivot is not changed.
- **Principle 10** is respected: seat credit lives on the seat, and kind restriction lives on the pool member, never on a kind.
- **Principle 22's** "retries" collision, inherited from the parent, is repaired.
