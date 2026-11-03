# harness-dsl: balanced-entry execution (child of g00-durable-1)

## Lens

Every state change in the harness is an **entry** on the ledger.
- An entry has a **cause** that attributes it to a prior entry or to an actor: supplier, clock, operator, trigger, flow, policy, scheduler, budget, restart or executable.
- An entry also has **legs**. Each leg moves an amount between two buckets of one register, so the legs of every register sum to zero.
- The ledger rejects an unbalanced entry.

The board, the pending queue, capacity, spend, open timers, open effects and lane pauses are all **balances**. None of them is a separate table that could drift from the history.

The accounting word "account" is **not** adopted, because the owner already uses it for a model subscription. Buckets live in **registers**:

| Register | Buckets | Moved by |
|---|---|---|
| position | `lane/state` | creation (`outside → initial`), every transition |
| attempt | `unit/status` | open, block, wait, resume, end |
| capacity | `runner/free`, `runner/held:attempt` | slot acquire and release |
| spend | `unit:id`, `day:date`, `account:name` | settled invocation cost |
| quota | `account:name/harness` | utilization delta reported by the account's quota backend |
| effect | `inflight:invocation`, `step:key` | invocation opened, invocation settled |
| timer | `clock`, `armed:unit/timer` | arm, disarm, fire |
| latch | `threshold/group:clear`, `threshold/group:breached` | threshold crossing |
| admission | `lane:open`, `lane:paused` | trigger pause and resume |
| lease | `file:path` | file-lease guard |
| writer | `holder` | single-writer claim |

Restart and the crash-sensitive questions reduce to one: **which balances are open?** An open `effect` balance is an invocation that started and never settled. An `armed` timer balance is a pending deadline. Each one is resolved by an explicit entry with cause `restart`. Nothing is replayed from memory.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, identified by `(kind, key)`. It lives in the ledger and may also have fields in a store. A unit outlives its attempts.
- **Attempt**: one pass of a lane's flow over a unit.
  - It ends with an **outcome**: succeeded (the flow reached `ends`/`exit`), failed (a step failed after retries) or cancelled (by a reaction, operator or budget).
  - Before it ends, it may be **running**, **blocked** (waiting on a human) or **waiting** (timer, children, batch, or preempted for capacity).
  - Blocked has one meaning with five reasons: `decision`, `stepFailure`, `budget`, `interrupted`, `definitionChanged`. A crash-parked attempt is simply a blocked attempt. Its block is resolved through `resolveBlocks` with the choices `restart` and `abandon`.
- **Step**: one named node of a flow. Its recorded output is replayed on resume and never re-executed.
- **Invocation**: one execution of an executable inside a step. A retry is a new invocation, and a batch makes one invocation per item.
  - An invocation is the only thing with an external effect.
  - Every invocation is a pair of entries: `effect.opened`, then `effect.settled`.
- **Run** is not a word in this design.

## Entities

### Kinds (vocabulary, no backend)

**`H.state(name, position)`** or **`H.state(name, 'terminal', verdict)`**
- Positions: `pending`, `active`, `waiting`, `terminal`.
- A terminal state must name a verdict: `success`, `failure` or `neutral`. The overloads make a missing verdict a compile error.
- States are shareable entities.

**`H.work(name)`**
- `.attributes()`: ledger-held scalars.
- `.fields()`: store-held data.
- `.states()`: the first state listed is initial.
- `.events()`: typed messages addressed to an existing unit by key.
- `.timers()`: a recurrence, a delay, or an attribute holding epoch ms.
- `.key(make, { unique })`:
  - `forever` (the default): a create with a known key is a recorded no-op.
  - `whileOpen`: the key is held only by a non-terminal unit. Once that unit is terminal, the same key creates a fresh unit. This is the per-group dedupe in scenario 9.

**Other kinds**
- `H.role(name)`: intents, instructions, input and output. Intents are mapped to tools by the driver.
- `H.memory.experience | taste(name)`: memory kinds. `.curated()` makes non-owner writes enter as candidates.
- `H.command(name, argv)`, with `.parses(shape)`.
- `H.flow(name)`: blind to kinds and states. It emits labels.

### Instances (carry a backend; from subpaths)

Account, model (with its driver), quota, runner, ledger, store, memory store, supplier, client, projection, external executable.

### Pivots (each names its product)

| Pivot | Composed of | Produces |
|---|---|---|
| **lane** | kind × suppliers × store × flow × runner (+ reactions, budget, WIP, preflight) | the place a kind's units are produced, kept and handled |
| **agent** | role × model or choice policy × pool × journals | an executable that thinks |
| **pool** | accounts × shares × preference × fallback | the accounts an agent may draw on |
| **journal** | memory kind × memory store × recall policy | where items are written and how they are recalled |
| **threshold** | metric × scope × group × window × two bands | latched crossings of a metric |
| **trigger** | source × consequences | a recorded firing |
| **access** | operations | what a client may do |
| **harness** | ledger × lanes × triggers × schedule × clients × projections | a running scheduler |

**Reaction** is a lane setting (`lane.reaction(event, toState, { from, sets })`), not a free-standing descriptor. It names what it produces: the unit's move on an event.

## Rules

### Skeleton (principle 12, as amended)

- **Attempt outcomes:** succeeded, failed, cancelled.
  - Model, agent, runner and account track records use `metrics.attempts()` = succeeded / (succeeded + failed), with `n`.
  - An `interrupted` invocation (a crash) is excluded from every rate.
  - A resumed attempt keeps one id. Its `interruptions` counter increments.
- **Unit positions:** pending (queued), active, waiting (parked, holds nothing, not schedulable), terminal.
- **Unit success:** `metrics.success()` = success / (success + failure) over units reaching a terminal state in the window, with `n`.
  - `outcomes()` reports `byVerdict`, `byState` and `share(state)`. "How often are experiments inconclusive" is `outcomes(...).share(Inconclusive)`.
  - Loaded-with-warnings is a separate `success` state: success to the scheduler, distinct in `byState`.
- **Labels to states:** flows emit labels and lanes map them to states. The implicit label `failed` must be mapped, and the kind decides where a failed attempt moves the unit. It may move to a non-terminal state.
- **Ownership:** a unit in a `waiting` state with no open attempt owns no capacity and no WIP. Examples are a Tenancy between reviews and a Negotiation awaiting the vendor.

### Queueing is a balance

- A unit is queued if and only if its position balance moved into a `pending` state.
- A move into pending posts a queue `put` in the same atomic `post`. A move out of pending posts a queue `remove`.

### Events and reactions

- Suppliers emit `{ create }` or `{ key, event, payload }`. Timers fire as an event of their own name, with payload `{ firedAt, dueAt }`.
- A received event posts **one entry** containing `event.received` and, if a reaction applies (the current state is in `from`, or `from` is omitted), the reaction's legs:
  1. cancel the open attempt (outcome cancelled);
  2. apply `sets`: typed `payload → Partial<attributes>`, recorded as `unit.attributes`;
  3. move the unit.
- **Payloads.** The new customer message reaches the redraft through `sets`. It becomes an attribute the flow reads. There is no untyped `c.signals`.
- **Ordering.** Triggers on an event receive the unit as it was *before* the reaction, plus `reaction: { from, to }`. A trigger therefore never races its own lane's reaction.
- **Unhandled events.** An event with no applicable reaction is recorded and ignored. An event to a terminal unit is recorded with `reaction: null`.

### Timers are balances

- Arming posts `clock → armed:unit/timer` with its `dueAt`.
- An attribute timer re-arms whenever its attribute changes, whether through a reaction's `sets`, `updateWork` or a flow's `.sets`. Re-arming posts a disarm of the old `dueAt` and an arm of the new one in one entry.
- The old deadline's balance is zero, so it cannot fire (SLA extension in scenario 9).
- Timers survive restart because they are balances.

### Triggers

- **Sources:**
  - `transition` (filter by `to`, `verdict`, `position`);
  - `streak` (N consecutive terminal verdicts per attribute);
  - `step` (recorded output, with `resolvedBy`);
  - `event` (including timers);
  - `crossing(threshold, 'breach' | 'recovery')`.
- **Consequences:** `creates`, `sends`, `records`, `invokes`, `pauses`, `resumes`.
- **Firing record.** Every firing is a `trigger.fired` entry whose cause is the source entry. Consequences refused by key uniqueness are listed under `suppressed`.
- **Thresholds** are re-evaluated after every entry their metric counts. Each `(threshold, group)` holds a latch balance.
  - Moving `clear → breached` requires `n ≥ minN` and the `breach` band.
  - Moving `breached → clear` requires the `recovery` band.
  - A crossing is one `threshold.crossed` entry carrying the `MetricRead`. Hysteresis is the latch: there is one firing per crossing and none per sample.
- **Pause and resume.** `pauses(lane)` and `resumes(lane)` post `lane.admission` entries carrying the reading that caused them. They are on the board, and `metrics.paused(lane, window)` returns total paused ms.
  - Paused means the scheduler admits no new or resume entries in the lane.
  - Running attempts continue.

### Metrics defined by the owner

- `H.metric(name).step | transition | invocations(...).hit(test)` defines a rate over recorded entries.
- `test` returns `true` (a hit), `false` (a sample that missed) or `null` (not a sample).
- Returning `null` makes `n` honest for conditional metrics. Scenario 6's "how often did the editor act on the critique written by model M" counts only attempts where M held a reviewer seat.

### Halts and the self-feeding gate

- A halt resolved by a human posts `halt.resolved` and `step.recorded` with `resolvedBy: 'human'`.
- `skip.when` records `status: 'skipped'` with `resolvedBy: 'policy'`.
- Owner step metrics count only entries resolved by an executable or a human, never by a policy. An auto-approval can therefore never feed the rule that granted it. This repairs principles 4 and 18 in the parent.

### Suspension and capacity

- Halts, waits, spawns, batch collection and preemption suspend the attempt. A suspended attempt:
  - releases its runner slot and account (capacity legs reverse);
  - keeps lane WIP;
  - resumes through a queue entry with `reason: 'resume'`.
- Spawned children are ordinary units. The parent's wait is satisfied by their position balances, which are read from the ledger.

### Budget

- Each settled invocation posts spend legs: `account → unit` and `day`.
- `lane.budget` blocks the attempt with reason `budget`, or fails it, when the unit's balance would pass `maxUsdPerUnit`. Drivers receive `remainingUsd`.
- Daily budgets are read in the schedule policy via `metrics.spentUsd`.

### Accounts and quota (scenario 7)

- Account state (window, utilization, cooldown) belongs to the **account instance's quota backend**. It is not kernel state. `harness-dsl/sqlite.quota(path)` is one backend, and two harnesses naming the same backend share it.
- Each harness's ledger holds only its own `quota` legs: the utilization deltas it consumed. Its share cap is therefore computed from its own ledger.
- Eligibility is read from the quota backend at every decision.
- The ledger is still the kernel's only state. Quota is a backend like a store, carried by an instance (principle 8). This removes the parent's `Ledger.quota`.

### Restart (scenario 10): what the author writes

The author writes `effect` (and optionally `confirm`) on a step. Nothing else.

| Effect | On an open `inflight` balance at restart |
|---|---|
| `repeatable` | rerun: a new invocation in the same attempt |
| `unrepeatable` | the default for commands and externals. If `confirm` is given, it is run with the same input: when `data.happened` is true, the original is settled as succeeded; otherwise the attempt is blocked with reason `interrupted`. Without `confirm`, it is blocked. |
| `external` | the default for agents. The kernel calls the driver's or external's `reconcile(invocationId)`: finished settles, failed fails, running keeps waiting, unknown blocks. |

- **Batches.** `batch.submitted` holds the batch id, and restart calls `collectBatch` instead of resubmitting.
- **Halts and children.** Halts resolved while the harness was down are already ledger entries. If the resolution was written by a client to a shared ledger, it is found when the attempt resumes. Children are read from their own positions and are never restarted by the parent.
- **No double counting.** Completed steps are replayed from `step.recorded` at zero cost. Every resolution is a `restart.resolved` entry with cause `restart`. Interruption is never an invocation failure.
- **Changed definitions.** Each attempt records its flow's `definition` digest, a hash of the step keys and their order. On resume, a digest that differs before the attempt's current step blocks the attempt with reason `definitionChanged`. Its choices are `restart` (a new attempt from the top; this one is cancelled) and `abandon`.
- **Single writer.** `start()` calls `Ledger.claim(holder, ttlMs)`.
  - A live claim refuses start.
  - An expired claim is taken over with a new epoch (a `writer.claimed` entry naming the previous holder).
  - Every `post` carries the claim, and posts under a stale epoch are rejected, so two writers never both commit.

### Memory

- **Envelope.** The kernel owns the envelope: id, created, kind, status, `when`, rule, because, source, mergedFrom.
- **Reads and writes.** Agents `.recalls()` journals, unioned on read, and `.records()` into exactly one. A write needs one destination; the asymmetry is deliberate.
- **Recall.** Recall is a deterministic policy over candidates pre-scored by specificity, track record and similarity (when the store gives it). A vector store is a `MemoryStore` returning similarity.
- **Capture.** Triggers capture memory. In a curated kind, the items are candidates, and `curateMemory` accepts, merges or drops them.

### Scheduler

- The schedule policy orders admissible candidates and may name preemptions.
- The kernel then admits subject to lane admission, WIP, runner capacity, preflight and account eligibility.
- Every metric read inside a policy is posted with `policy.decided`.

### Control API

- Clients are granted operations. Transport is the client adapter: MCP through a coding-agent session, or plain HTTP.
- Operations are posted as `operation.recorded`, with the actor as cause.
- `sendEvents` delivers kind events.
- `updateWork` sets attributes, so it re-arms attribute timers.

### Startup validation

`start()` fails on any of:
- duplicate names;
- an unmapped label, or a label mapped outside the kind;
- a terminal state without a verdict (also a compile error);
- a reaction state outside the kind;
- a `.sets` key that is a field;
- a trigger or threshold naming an unregistered lane;
- a batch step on a non-batch model;
- an `external` effect on an executable without `reconcile`;
- an agent without model or pool;
- a live writer claim.

## What changed and why

- **Principle 12 is repaired.** The parent's sixth outcome, `concluded`, is gone.
  - Attempts have three outcomes. Units have four positions. Terminal states carry success, failure or neutral with no default.
  - Parked research, inconclusive experiments, churn and walk-aways are `neutral`. Escalation and a returned draft can be `failure` where they mean it. The adversary's "junk drawer" disappears because every state chooses its verdict deliberately.
- **The double-entry execution model.** All kernel state is balances over registers, and every entry is caused and balanced. Restart, pause duration, open timers, open effects and capacity are now queries over balances (`Ledger.balances`).
- **Signals are split.** Their four meanings in the parent are now distinct words:
  - kind `.events()`;
  - lane `.reaction()`, a lane setting that replaces the verb-named `H.move`;
  - trigger `.sends()`;
  - timers firing as events.

  Event payloads reach flows only through a reaction's typed `sets` into attributes, so `c.signals` and its `safeParse` escape are removed.
- **Event triggers see the pre-reaction unit and the reaction applied,** which removes the escalation race.
- **Gate honesty.** Policy-resolved halts are excluded from step metrics.
- **New trigger sources.** Thresholds (metric source, hysteresis latch, per-attribute group), `pauses` and `resumes` lane consequences, and `metrics.created` and `metrics.paused` for scenario 9.
- **Key uniqueness.** `whileOpen` dedupes Audits by category while letting a later crossing open a new one.
- **Moving deadlines.** Attribute timers re-arm on attribute change.
- **Restart semantics.** Step `effect` and `confirm`, `Driver.reconcile`, optional `External.reconcile`, batch handles in the ledger, flow definition digests, and writer claims with epoch-fenced `post`. These cover scenario 10.
- **Quota moved.** It is off the ledger and onto the account's quota backend.
- **Windows.** Metric windows are a `Duration` (`{ hours: 1 }`, `{ days: 7 }`) instead of `windowDays`.
- **Removed.** `H.resource` (unused by the battery) and `H.move`.
- **Slack adapter.** It gains `post`, which takes a dedupe key, for scenario 10's announce-with-confirmation.
- **Metric `hit` may return `null` (scenarios 6–10 pass).**
  - **The problem.** Scenario 6 needs a per-model rate of "editor acted on this model's critique". The sample is an attempt in which that model held a seat. With a boolean-only `hit`, every editor decision counted toward every model's `n`, which is dishonest under principle 18.
  - **The fix.** `null` now means "not a sample". The kernel's `MetricSpec.test` already returned `boolean | null`; `h.d.ts` now exposes it.
- **Slack adapter gains `find`.**
  - **The problem.** Scenario 10's `confirm` executable must take the announce step's input and return `{ data: { happened } }`. A command cannot: its input is `CommandInput`.
  - **The fix.** `slack.find` looks up a message by dedupe key. With it, the announce step continues instead of parking when the post did happen.
- **Known wart, recorded rather than fixed.** A policy that closes over a metric defined from the flow it steers is circular for TypeScript's inference:
  - a gate inside the flow it measures (scenario 9);
  - a model choice for a step whose output defines the metric (scenario 6).

  Scenarios annotate such policies with `GatePolicy` or `ChoicePolicy<Model>` from `harness-dsl/kernel`. That is a type annotation, not an escape hatch. A later variant could remove it by having metrics name a flow and step key by string.

## Principles broken

none
