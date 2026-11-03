# harness-dsl: minimal, split (child of g02-minimal-al-0-2-2)

The operator for this child is **split**: find the entity that does two jobs and split it.

The parent had two such entities. This child splits both and reports the surface each split adds. It also repairs the adversary's three sharpest critiques and the scenario-4 defects.

## The splits

### Split 1: the flow named the kind's lifecycle

**Two jobs.** A parent flow did two things:

1. It described the work.
2. It named the kind's states. `ctx.move('building')` and `return 'done'` were states of the kind.

So a flow serving two kinds typed its states as `S1 & S2`. Bug and Feature had to share every state entity. Scenario 7 had to turn `abandoned` into a failure for both kinds (critique c, known weakness 1).

**Now.** A flow declares its own vocabulary:

- **phases**: where it is while it works, via `.phases(...)`. `ctx.move` and `ctx.wait` take a phase.
- **exits**: how it ends, via `.exits(...)`. The body returns an exit or `ctx.fail`.

The lane's handler maps that vocabulary to the kind's states. Its type is `StateMap<Ph, Ex, S> = Record<Ph | Ex, State<S>>`:

```ts
H.lane('features', Feature).handler(ticketWork,
  { building: featureBuilding, done: shipped, exhausted: needsDesign, abandoned: dropped },
  { rounds: 5 })
```

**What the types and startup check enforce.**

- Values are `State` descriptors, so a state that is not in the kind's state union is a type error.
- Every phase and exit must be mapped.
- `start()` checks that each phase maps to a non-terminal state.
- `start()` checks that each `wait` phase maps to a waiting state.
- `start()` checks that each exit maps to a state of the lane's kind.

**Result.** A flow is now blind to the kinds' state entities. Bug and Feature can have different states, verdicts and tracker statuses while sharing one flow. `.for(k1, k2?)` remains, and supplies only the data type (known weakness 11).

**Surface added:**

- `FlowShape.phases` and `FlowShape.exits`;
- the `states` argument of `handler`;
- `StateMap`;
- the `Ph`/`Ex` type parameters.

**Surface removed:** the `S1 & S2` intersection and `Flow.states`.

### Split 2: the model was also its transport

**Two jobs.** A parent `Model` was both:

1. a model's identity (what metrics group by, and what it costs);
2. the client that calls it (`call`, `recover`, `submit`, `collect`).

So one model needed two instances, `claude.model('claude-opus-4-1')` and `anthropic.model('claude-opus-4-1')`. Metrics merged them by name while their prices and recovery differed. That is two words for one thing (principle 22).

**Now.**

- `Model` is identity plus price only. `anthropic.model(id)` is its one constructor.
- Transport is a `Driver` carried by the `Account`. A Claude Code subscription's driver runs an agent session. An API account's driver calls the API and is the one that can `submit`/`collect` batches.
- An account serves the models of its `provider`.
- `Driver.intents` lets the kernel route an agent whose role needs `edit` only to accounts whose driver can edit.
- `Result.model` is now a `Model` descriptor, not a string.

**Surface added:** `Driver` (kernel) and `Account.driver`.

**Surface removed:** `claude-code.model`, and `call`, `recover`, `submit` and `collect` on `Model`.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(state?)` | A data shape, states, and an optional failure move. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, schema)`; kernel halts in `H.halts` | A named outside decision. |
| Instance | model, account (with its driver), runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources with their backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, states, params?).suppliers().store().wip().maxUsdPerUnit().retry()` | A work queue: kind × suppliers × store × handler. The handler maps flow vocabulary to kind states. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source: memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).phases(...).exits(...).does(ctx => exit)` | A handler body with its own vocabulary. |
| Composite | **command** | `H.command(n).input().output().argv().on(...).preflight(c).recovery(r)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of a lane's flow for one unit.
  - States: `running`, `blocked`, `waiting` and `ended`.
  - Outcome when ended: `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable in an attempt. Each retry, each preflight and each batch item is its own invocation.

## Rules

### 1. Skeleton and failure (principle 12; repairs critique a)

How an attempt ends decides its outcome and the unit's next state:

| How the attempt ends | Attempt outcome | Unit moves to |
|---|---|---|
| Returns an exit | `succeeded` | The state the lane maps that exit to. |
| `ctx.fail` or a throw | `failed` | See the failure policy below. |
| Interrupted from outside | `cancelled` | Decided by the rule that interrupted it. |

**Failure policy.** After a failed attempt the kernel asks the lane's retry policy, `Lane.retry(policy)`. The policy reads `{ failures, error, now, metrics }`.

- **`{ retryInMs }`**: the unit stays pending. It is schedulable after that delay.
- **`'stop'` and the kind declares `.failsTo(state)`**: the unit moves to that state. This is the only way a failure moves a unit.
- **`'stop'` and no `failsTo`**: the unit is **held**.
  - It stays at its pending state and is excluded from the scheduler's view, exactly as a unit in backoff is, but with no wake time.
  - A `unit` entry records `held`, so the board shows it.
  - It leaves the hold through `work.release` (granted by `H.ops.writeWork`) or through a move.

**Default policy.** Three retries at 1, 4 and 16 minutes, then `'stop'`. Nothing retries forever.

**What this enables.**

- The fleet-patching case: retry at 10 and 30 minutes, then `quarantined`. It is a two-line retry policy plus `failsTo('quarantined')`.
- A fleet-wide rate limit: the policy reads `metrics` and returns a later `retryInMs`.
- Per-invocation retry (`RunOptions.retry`, scenario 5) uses the same policy type inside an attempt.

### 2. Durable waits

`ctx.wait(phase, { at })` and `ctx.wait(phase, { children })` suspend the attempt.

- The unit moves to the mapped waiting state.
- A waiting attempt holds no slot and counts toward no WIP limit.
- On wake, the attempt resumes by replay.
- A move from outside cancels a waiting attempt, as it cancels any live attempt.
- `durationMs` excludes time spent blocked and waiting.

### 3. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions.
- Neutral states are excluded, and stay countable through `rate`.
- Every rate carries `hits` and `samples`. `value` is `null` at 0 samples.

### 4. A move with a live attempt cancels the attempt first.

### 5. Supply and keys

- A `create` on an open key is ignored.
- `update`, a trigger's `move(lane, key, state)` and `work.update` address the open unit with that key.
- The ledger keeps a unit snapshot, so storeless kinds still have data and telemetry.

### 6. References, not strings (repairs critique b)

**The rule.** No unchecked string refers to an entity. Literal unions that are checked against a kind's state union (`act.move('escalated')`, `on.enters(Kind, 'x')`, `Supply.state`, linear `statuses`) count as references: a typo is a type error.

**Descriptors where strings used to be:**

| Where | Now takes |
|---|---|
| `EntryFilter.state` | `State` descriptors |
| `EntryFilter.status` | `EntryStatus`, the union of every ledger status |
| `EntryFilter.kind`, `lane`, `trigger`, `executable`, `halt` | Descriptors |
| Memory `when.kinds` and `when.roles` (`ScopeRef`) | Kind and role descriptors. The kernel stores their names in the item envelope (`Scope`). |
| The handler's state map | `State` descriptors |

**Kernel halts are entities.** `H.halts.costCeiling` and `H.halts.definitionChanged` are entities like any other halt. `.resolved(match)` filters their resolutions.

**Grouping no longer relies on magic tags.** `rateBy` takes `by`:

| `by` | Groups by | Returns |
|---|---|---|
| `{ modelOf: agent }` | The model that served that agent's last invocation in the same attempt | `Grouped<Model>` |
| `'group'` | The group key of a metric firing | `Grouped<string>` |
| `{ tag }` | The author's own label, set by `ctx.tag` (for example, category) | `Grouped<string>` |

- `Grouped.of(key)` returns a zero-sample `Rate` for an absent key, so no scenario needs a `noSamples` helper.
- `ctx.tag({ model: drafted.model ?? 'unknown' })` disappears.
- `{ tag }` is the only string left. A category is domain data, not an entity.

**Schedulers** compare kinds with `unit.is(Kind)`.

### 7. Triggers

**Unit sources.**

- `on.enters(kind, state)`.
- `on.deadline(kind, due, whileIn)`. `due` is re-read on every data update, so an extended deadline re-arms the timer and the old deadline never fires.
- `on.streak(kind, state, n, group)`:
  - It counts consecutive **terminal** transitions of units of that kind within the group.
  - A terminal transition into any other state resets the count. A `heartbeat-ok` between two failures breaks the streak.
  - It fires once when the count reaches `n`, then starts again from zero.

**Unit events.** Every unit event carries `attempt: { outcome, durationMs } | null`.

- The value is `null` only when the transition was caused by something other than an attempt (a supply, trigger or operation).
- A trigger that cares must branch on `null` explicitly. A missing duration can no longer be silently read as 0.

**Metric sources.**

- `on.metric(read, { trip, reset, minSamples })` reads either one `Rate` or a `Grouped<string>`.
- Each group, or the whole source, is a two-state latch, which gives the hysteresis.
- Firings are `firing` entries carrying the metric reads that caused them.
- Pause and resume are `lane` entries. A resume entry carries the paused `durationMs`.

### 8. Scheduler, placement, preemption (repairs scenario 4)

**Scheduler.** It returns an ordered `start` list and an optional `preempt` list. Blocked attempts free their runner slots but keep their WIP.

**Preemption.**

- A preempted attempt ends `cancelled`.
- Its invocations are cancelled through `Cancellation`.
- The unit returns to the state it held when the attempt started (`AttemptEntry.startState`).
- `recovery` applies only to crash-interrupted invocations. Preemption never parks a unit.

**Placement.**

- `command.on(...runners)` places an invocation on the first listed runner with a free slot.
- `command.on({ a: hostA, b: hostB }, (input) => key)` pins it by input. The pick function is typed to the record's keys. Backups of `orders` run on the host that holds `orders`. Renewals go to their own runner.
- Host data stays out of the kind: the database name is domain data, and the mapping from database to host lives in the command.

**Preflight.**

- `command.preflight(check)` runs a check on the chosen runner before the command, as its own invocation.
- A failing preflight fails the command's invocation with the error `preflight`.
- The preflight belongs to the backup, not to the host. The raw shell strings in the ssh options are gone.

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it blocks the attempt on `H.halts.costCeiling`. The decision is `{ proceed, raiseUsd? }`.
  - `proceed: false` ends the attempt `cancelled` and holds the unit.
- Daily budgets are scheduler reads of `metrics.sum`.

### 10. Accounts and quota (principle 15)

- Quota is a ledger partition of append-only usage and cooldown events, each tagged with its harness and folded at read time.
- `sqlite.ledger(path, { sharedQuota })` puts that partition in a shared file. No lock is ever taken over another harness's account state.
- Shares belong to pools, and so to one harness.
- The driver belongs to the account, so two harnesses that declare the same subscription share one transport identity, not just one name.

### 11. Memory

- The kernel owns the envelope.
- A candidate is never recalled until it is accepted.
- Recall is one deterministic kernel policy over what the store's `search` returns. It ranks by similarity (when the store reports it), then specificity, then track record.
- An agent reads the union of the libraries it `recalls` and writes to the one library it `records`.

### 12. Durability (scenario 10)

The author writes declarations only.

**Replay.** Every context call is a sequenced ledger entry. After a restart the flow re-executes, and recorded results are returned without invoking anything again.

**An invocation interrupted by the crash** is recovered per executable:

- **Commands** follow `.recovery`: `'rerun'`, `'park'` (the default), or a check command.
- **Agents** ask `Driver.recover` on the account that served them.

**Batches.** A batch records its submitted handle before waiting, and is collected after a restart, not resubmitted.

**State that moved while the harness was down.**

- Operations requested while the harness was down are applied in order on start.
- Waits store `wakeAt` and child keys, and are re-evaluated against recorded positions.

**The attempt record.** A resumed attempt keeps its id. The crash is an `interrupted` entry, and interrupted invocations are excluded from model and agent rates.

**A changed definition.** A changed flow fingerprint, or a changed state map, blocks the attempt on `H.halts.definitionChanged`.

- `restart` cancels this attempt and starts a new one from the top.
- `abandon` cancels it and holds the unit.

**Single writer.** `start()` holds a renewed ledger lease. A second process refuses to start while the lease is live, or takes over after expiry and records `took-over`.

### 13. Control API

- It is made of operations. Clients are granted operations, not capability strings.
- `claude-code.supervisor` and `http.control` are two clients.
- `work.release` is part of `writeWork`.

### 14. Startup validation

`start()` fails in each of these cases:

- duplicate names;
- an unmapped phase or exit;
- an exit mapped outside the lane's kind;
- a phase mapped to a terminal state;
- a `wait` phase that does not map to a waiting state;
- a `failsTo` state that is not terminal;
- an unregistered lane referenced by a trigger;
- an agent that no pool can serve with its role's intents;
- a batch with no batch-capable account;
- a command without argv or runners;
- a missing ledger.

A harness with no pools, agents or models is valid.

## What changed and why

| Change | Reason |
|---|---|
| Flow phases and exits, plus the lane state map | Split 1. Repairs critique c and known weakness 1. |
| `Driver` on `Account`; `Model` is identity and price only | Split 2. Removes the two-vendors-one-model duplication. |
| `Lane.retry`, a bounded default retry, and held units | Repairs critique a. Expresses the fleet-patching case. |
| `RetryView.error`, `now` and `metrics` | The retry policy needs the error, and must read metrics for fleet-wide rate limits. |
| `EntryFilter.state` takes `State`; `status` is `EntryStatus`; `ScopeRef` takes descriptors | Repairs critique b. |
| `H.halts.costCeiling` and `H.halts.definitionChanged` | Repairs critique b: kernel halts become entities. |
| `rateBy` `by: { modelOf } \| 'group' \| { tag }`, and `Grouped<K>` | Repairs critique b: removes magic tags and the `?? 'unknown'` fallbacks. |
| `Result.model` is a `Model` descriptor | Follows from split 2: the model is one entity. |
| `command.on(record, pick)` | Scenario 4: a unit's work runs on the runner it belongs to. |
| `command.preflight` | Scenario 4: the preflight belongs to the command, not the host. |
| `UnitEvent.attempt` is a summary or `null`; streak semantics defined; preemption returns to `startState` | Scenario 4 defects. |

**Removed:**

- `ssh.host` `preflight`;
- `claude-code.model`;
- `Model.call`, `recover`, `submit` and `collect`;
- `Flow.states`;
- the `S1 & S2` state typing.

**Net surface:** roughly +9 members and −8. The splits added about six and removed five. The repairs account for the rest.

## Principles broken

None.

- **Principle 12.** A failure moves a unit only through a declared `failsTo`, and only when the lane's retry policy stops. Otherwise the unit stays pending: retried, or held.
  - A held unit is a pending unit with no wake time, the same category as a unit in backoff. It is not a fifth position.
- **Principle 10.** Host affinity lives on the command, as a mapping from input to runner. Neither the kind nor the runner carries it.
- **Principle 15.** Quota events stay in a ledger partition.
- **Principle 22.** One model is now one entity.
