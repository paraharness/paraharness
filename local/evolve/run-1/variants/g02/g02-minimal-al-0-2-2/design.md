# harness-dsl: minimal, cut again (child of g01-minimal-imal-0-2)

The operator for this child is surface-cut. It applies three changes:

- It removes methods, fields and options that the battery never reads, or that have one caller and can be a default.
- It repairs the adversary's three sharpest critiques. Two of the repairs also delete surface.
- It fixes the principle-12 gap the parent left open: the parent had no failure move on kinds, and no rule for retry by default.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(state?)` | A data shape, a set of states and an optional failure move. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decisionSchema)` | A named outside decision: what is asked, and the shape of the answer. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each with its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?).suppliers(...).store(s).wip(n).maxUsdPerUnit(x)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source: memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(ctx => state)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(...runners).recovery(r)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

These are values, not entities:

- `H.clock(...)` and `H.operator`, which are kernel suppliers.
- `H.env(name)`.
- `TimeSpec`, `Bound`, `MetricBounds`.
- `SupplyOf<K>`.
- `Children<T,S>`, the handle returned by `ctx.spawn`.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of a lane's flow for one unit.
  - Its states are `running`, `blocked` (on a halt), `waiting` (in `ctx.wait`) and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable inside an attempt. Each retry and each batch item is its own invocation.
- **Step** is not a word in this design.

## Rules

### 1. Skeleton (principle 12)

**Positions.** A unit has one of four positions: pending, active, waiting, terminal. Each state declares its position. Each terminal state declares `success`, `failure` or `neutral`, and the overload without a verdict does not type-check for terminal states.

**How a flow ends.**

| How the flow ends | Attempt outcome | What happens to the unit |
|---|---|---|
| Returns a state | `succeeded` | Moves to that state. |
| Returns `ctx.fail(reason)` or throws | `failed` | See the failure rule below. |
| Interrupted by an outside move, a preemption or a cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

**The failure rule.**

- **No failure move declared.** The unit stays at pending under the lane's retry policy. In this kernel that policy is fixed: exponential backoff from 1 minute, capped at 1 hour, with no limit on retries. No scenario in the battery needs a different lane retry policy, so `Lane.retry` does not exist (principle 21). The default is a policy, and a lane method can be added when a scenario needs one.
- **A failure move declared.** A kind may declare `.failsTo(state)`. Only then does a failed attempt move the unit, and it moves it to that state. This is the principle's sanctioned exception, and it replaces the parent's hand-written `if (ctx.unit.failures >= 3)`.

**Returning a waiting state.** The flow parks the unit with no wake time. A supply, trigger or operation must move it.

### 2. Durable waits: one attempt, no phase dispatch (repairs critique c)

`ctx.wait(waitingState, { at })` and `ctx.wait(waitingState, { children })` suspend the attempt inside the flow:

- The unit moves to the waiting state.
- The attempt holds no runner slot and no WIP.
- On wake, the same attempt resumes by replay.

`wait({ children })` returns the children's typed `UnitView`s. `ctx.spawn` returns the `Children` handle to pass to it.

How each scenario uses it:

| Scenario | Flow shape |
|---|---|
| Release | spawn → wait → read children → return a state. |
| Epic | Same as Release. |
| Experiment | An hourly `wait({ at })` loop for two weeks. |
| Tenancy | Review → halt → `wait({ at: nextMonth })` → return `review-due`, so the next attempt is the next review. |

None of these flows branches on `ctx.unit.state`. `ctx.until`, `Until`, `ctx.children()` and `UnitView.failures` are deleted.

A move from outside cancels a waiting attempt, as it cancels any live attempt (rule 4). A suspended tenancy therefore ends its review attempt `cancelled` and never wakes into review.

An attempt's `durationMs` excludes time spent blocked and waiting.

### 3. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions.
- Neutral states are excluded from it, and stay countable by name through `rate` and `rateBy`.
- Every rate carries `hits` and `samples`. `value` is `null` when `samples` is 0.

### 4. Moving a unit with a live attempt cancels the attempt first

This applies whether the attempt is running, blocked or waiting.

### 5. Supply and keys

- A `create` whose key belongs to an open unit is ignored.
- An `update`, a trigger's `move(lane, key, state)` and `work.update` address the open unit with that key.
- The ledger keeps a snapshot of every unit, so storeless kinds have data and telemetry.

### 6. Entities in filters, not strings (repairs critique a)

**Filters take descriptors.** `EntryFilter.kind`, `lane`, `trigger`, `executable` and `halt` take descriptors (`Named`), not strings. `successRate` takes `kind` and `model` descriptors. A filter therefore names something that exists. A trigger may be referenced inside a closure declared before it (for example a policy body), which ends the parent's `const auditTrigger = 'approval-audit'`.

**Halts are entities.**

- `H.halt(name, schema)` declares a halt once.
- `ctx.halt(halt, show)` raises it.
- `halt.resolved(match?)` builds the filter for its resolutions. `match` is `Partial<D>`, so a decision field that does not exist is a type error. The parent's misspelled-decision failure, which silently gave `samples: 0`, cannot happen.

**Policies no longer know agent names.** `ModelChoice` carries only `kind` and `metrics`. Scenario 6 declares one model policy per reviewer, and both read one shared lineup function.

**What remains a string.** Tags (`ctx.tag`, `byTag`) stay strings. They are the author's own grouping labels, not references to entities. The kernel cannot type them without a tag entity that has one use per scenario. The risk is now confined to one place.

### 7. Triggers

**Unit sources:**

- `on.enters(kind, state)`
- `on.streak(kind, state, n, group)`
- `on.deadline(kind, due, whileIn)`. `due` is re-evaluated on every data update, so an extended deadline moves the timer and the old deadline never fires.

**Metric sources (repairs critique b).** `on.metric(read, { trip, reset, minSamples })` has two overloads:

| `read` returns | Source type | `event.group` | `group` tag on the firing entry |
|---|---|---|---|
| One `Rate` | `MetricSource<null>` | `null` | None |
| `Record<string, Rate>` | `MetricSource<string>` | The group key | Yes |

- Each group, or the whole source, is a two-state latch, which gives the hysteresis.
- Neither form needs a fake group key or a lane name as a string. Scenario 9's pause trigger reads `{ lane: conversations }` inside its closure.

**Effects:** `create`, `move` (this unit, or `lane + key`), `remember`, `pause`, `resume`.

**Recording:**

- Every firing is a `firing` entry with `status` `fired`, `tripped` or `reset`, and carries the metric reads that caused it.
- Pause and resume are `lane` entries. A resume entry carries the paused `durationMs`.

### 8. Scheduler and placement

**Scheduler.**

- The scheduler returns an ordered `start` list and an optional `preempt` list.
- The kernel starts units in that order while lane WIP, runner slots, account eligibility and lane pause allow.
- Preempted attempts end `cancelled`.
- Blocked attempts free runner slots but count toward WIP. Waiting attempts count toward nothing.

**Placement.** `command.on(...runners)` places an invocation on the first listed runner with a free slot and a passing preflight. Scenario 4's backups run on two SSH hosts, each with `slots: 1`, through one command. The per-host factories and the host field in kind data are gone (principle 10).

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it blocks the attempt on the kernel halt `cost-ceiling`.
- Daily budgets are scheduler reads of `metrics.sum`.

### 10. Accounts and quota (principle 15)

- Quota is a ledger partition of append-only usage and cooldown events, folded at read time.
- `sqlite.ledger(path, { sharedQuota })` places that partition in a shared file. Two harnesses that name the same accounts see each other's cooldowns on every eligibility check. No harness takes a lock over another's account state.
- Shares belong to pools, and therefore to one harness.

### 11. Memory

- The kernel owns the envelope.
- Candidates are never recalled until accepted.
- Recall is one deterministic kernel policy over what the store's `search` returns. It orders by similarity when the store reports it, then specificity, then track record.
- `RunOptions.scope` narrows recall for one invocation.
- An agent reads the union of the libraries it `recalls` and writes to the one library it `records`.

**Owner-authored recall policies.** The adversary's proposed clause-review scenario asks for these. They are not in the battery, so by principle 21 there is no `H.policy.recall`. The kernel's ranking is a policy in principle 14's sense: deterministic, authored once, reading track record at decision time. A recall policy entity, and a halt-latency measure, enter when a battery scenario needs them.

### 12. Durability (scenario 10)

The author writes declarations only. The mechanism is unchanged from the parent:

- **Replay.** Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember`, `spawn` and `wait` is a ledger entry with a sequence number. After a restart the flow body re-executes, and recorded results are returned without invoking anything again.
- **Interrupted invocations.** An invocation that was running at the crash is recovered through `Executable.recover`:
  - Commands follow `.recovery`: `'rerun'`, `'park'` (the default), or a check command.
  - Agents ask `Model.recover`.
- **Batches.** A batch records its submitted handle before waiting. After a restart it is collected, not resubmitted.
- **Halts resolved while down.** A client adapter that runs while the harness is down appends `requested` operation entries. On start the kernel applies them in order.
- **Wakes.** Durable waits store `wakeAt` and child keys on the attempt entry. On start the kernel re-evaluates them against the children's recorded positions.
- **The attempt record.** A resumed attempt keeps its id. The crash is an `interrupted` entry, and interrupted invocations are excluded from model and agent rates.
- **A changed definition.** A changed flow fingerprint blocks the attempt on the kernel halt `definition-changed`. The supervisor resolves it with `restart` or `abandon`.
- **Single writer.** `start()` holds a renewed ledger lease. A second process refuses to start while the lease is live, or takes over after expiry and records `took-over`.

### 13. Control API

- The API is made of operations. Clients are granted operations, not capability strings.
- `claude-code.supervisor` is one client. `http.control` is a plain-HTTP client.

### 14. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names, including halts;
- a flow whose states are not states of its lane's kind;
- a `wait` or a `failsTo` target whose position is wrong (`wait` requires a waiting state);
- an unregistered lane referenced by a trigger;
- an agent that no pool can serve;
- a command without argv or runners;
- a missing ledger;
- a batch on a model without `submit` and `collect`.

A harness with no pools, agents or models is valid.

## What changed and why

### Repairs of the adversary's critiques

| Critique | Repair |
|---|---|
| a. Raw strings | `H.halt` entity with `resolved(match)`. Descriptor-typed `EntryFilter` fields. `ModelChoice.agent` removed. |
| b. Fake groups | Ungrouped `on.metric` overload. `MetricEvent<G>` with `group: null`. |
| c. Phase dispatch | `ctx.wait` (a durable, capacity-free wait inside one attempt) replaces `until` + re-entry branching. `failsTo` replaces `unit.failures` branching. |
| Scenario 4: placement | `Command.on(...runners)` restores placement to the runner layer, without kind data. |

### Cut

| Cut | Reason / replacement |
|---|---|
| `ctx.until`, `Until` | Replaced by `ctx.wait`. |
| `ctx.children` | Replaced by `wait({ children })`. |
| `HaltRequest` | Replaced by the `Halt` entity. |
| `UnitView.parent`, `created`, `spentUsd`, `failures` | Never read by a scenario. Kept on the kernel's `UnitRecord`. |
| `ActiveView.startedAt` | Unread. |
| `AccountView.pool`, `coolingUntil` | Unread. Eligibility already folds cooldowns. |
| `SchedulerView.lanes` | Unread. |
| `ModelChoice.agent`, `role`, `lane`, `unit`, `now` | Unread, or a principle-10 leak. |
| `AccountChoice.model`, `now`, `metrics` | Unread. |
| `RetryView.error` | Unread. |
| `UnitEvent.attempt.id`, `costUsd`; `MetricEvent.at` | Unread. |
| `EntryFilter.verdict` | Unread; `successRate` covers it. |
| `on.enters` array form | No caller. |
| `Lane.kind`, `Library.memory/store`, `Pool.members`, `Flow.kinds/params` as public fields | Not part of the DSL; the runtime owns them. |
| `folder.files` `write` option | One caller. The folder store writes data and state into frontmatter by default. |
| `linear.Issue.id` | Unread. |
| `Recall`, `RecallView`, `Recalled` in kernel | No implementer or caller; the ranking is internal. |
| Re-exports | Narrowed from ~30 kernel types to the six scenarios import: `Metrics`, `Model`, `Rate`, `EntryFilter`, `PendingView`, `SupplyOf`. |

### Added

| Addition | Why |
|---|---|
| `H.halt` | Repairs critique a. |
| `KindDescriptor.failsTo` | Principle 12. |
| `ctx.wait` (two overloads) | Repairs critique c. |
| `Children<T,S>` | The handle that `wait({ children })` takes. |
| `MetricSource<G>`, `MetricBounds` | Repairs critique b. |
| `AttemptEntry` status `waiting` with wake fields | Records the durable wait. |

The net surface is smaller.

## Principles broken

None.

- **Principle 12** is now satisfied in full: the lane retry default, plus a failure move only where a kind declares one.
- **Principle 15** holds: shared quota is a ledger partition of append-only events.
- **Principle 14** holds through the kernel's fixed deterministic recall policy. An owner-authored variant waits for a battery scenario that needs it (principle 21).
