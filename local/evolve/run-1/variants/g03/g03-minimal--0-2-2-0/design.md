# harness-dsl: inference pass (child of g02-minimal-al-0-2-2)

The operator for this child is **inference**. I found every place a parent scenario needed one of the following:

- a type annotation,
- an explicit type argument,
- an `as const`,
- a helper written only to satisfy the types,
- a string that stands in for an entity.

I changed the surface so that inference carries each one. The adversary's three sharpest critiques of the parent are repaired below, and so are its Scenario 4 findings.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(n, position)` or `H.state(n, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(state?)` | Data shape, states, an optional failure move. It also builds typed supply values (`create`, `update`) and filters (`entered`, `attempts`). |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decisionSchema)` | A named outside decision. |
| Kind | **tag** | `H.tag(n)` | An author-named grouping dimension for metrics. |
| Instance | model | `anthropic.model(id)` | A model: identity and price. It does not carry a driver. |
| Instance | account | `claudeCode.subscription`, `anthropic.account` | A credential plus the driver that calls a model through it. |
| Instance | runner, store, memory store, supplier, ledger, guard, observer, client | adapters | Specific resources. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, {params, phases}).suppliers().store().wip().retry().maxUsdPerUnit()` | A work queue: kind × suppliers × store × handler × retry. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).phases(...).params(z).does(ctx => phase)` | A handler body written in its own phases. |
| Composite | **command** | `H.command(n).input().output().argv().on(...).preflight(check).recovery(r)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry}(n, f)` and `H.policy.rule(n).input(z).decides(f)` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n)...start()` | The running thing. |

## Execution vocabulary

- **Run**: one process lifetime.
- **Attempt**: one execution of a lane's flow for one unit. Its states are running, blocked, waiting and ended. Its outcome is succeeded, failed or cancelled.
- **Invocation**: one call of one executable inside an attempt. Each retry and each batch item is its own invocation.
- **Phase**: a flow's own name for where it is or how it ended. The lane maps each phase to a state of its kind. "Step" is not a word in this design.

## Rules

### 1. Skeleton and failure (principle 12)

The four positions, three outcomes and terminal verdicts are unchanged.

A failed attempt asks the lane's retry policy (`RetryView.failures`). The policy answers in one of two ways:

- **`{ retryInMs }`**: the unit stays at pending, not schedulable before that time.
- **`'stop'`**: what happens depends on the kind.
  - If the kind declares `.failsTo(state)`, the unit moves there.
  - If it does not, the unit stays pending and is **held**. The operation `work.retry` clears the hold.

The default lane retry policy is 3 retries at 1, 4 and 16 minutes, then `'stop'`.

### 2. Phases

A flow speaks in its own phases:

- `ctx.move(phase)`
- `ctx.wait(phase, ...)`
- `return phase`

The lane maps phases to states with `handler(flow, { phases })`. The map is required only when some phase is not a state name of the lane's kind. If `.phases` is omitted, the phases are the kind's state names, or the names shared by both kinds when the flow is for two.

At `start()` the runtime checks every mapping target's position:

- a `wait` phase must map to a waiting state;
- a `move` phase must map to a non-terminal state.

A flow may end by returning a waiting phase. The unit is then parked until something outside moves it (a supply, an operation or a trigger).

### 3. Durable waits

The attempt holds no slot and no WIP while it waits, and it resumes by replay.

### 4. Moves and preemption

- **Outside moves.** A move from outside cancels a live attempt first.
- **Preemption.** A preempted attempt ends `cancelled`, and its unit returns to pending with no backoff.

### 5. Supply values come from the kind

`Kind.create` and `Kind.update` return typed `Supply` values.

### 6. Filters are built by entities, never by strings

Every filter is built by a descriptor:

- `kind.entered`
- `kind.attempts`
- `executable.invocations`
- `H.modelInvocations`
- `halt.resolved`
- `trigger.tripped`
- `lane.pauses`

Any filter can be narrowed with `filter.where(tag, value)`. Scope takes descriptors for kinds and roles. The scheduler uses `unit.is(Kind)`.

### 7. Grouping

- `rateBy({ by: tag })` returns `RatesBy<string>`.
- `rateBy({ by: { model: agent } })` returns `RatesBy<Model>`.
- `RatesBy.get` returns a zero-sample rate for an absent group.
- `metrics.count` counts entries.

### 8. Rules infer their input

`H.policy.rule(n).input(z).decides(f)`.

### 9. Triggers

**Sources:**

- `on.enters`
- `on.streak`
- `on.deadline`
- `on.metric`

**Streak semantics.** A streak counts consecutive terminal transitions of the kind within one group. Any other terminal state in that group resets the count. The streak fires once on reaching `n` and re-arms only after a reset.

**Duration.** `UnitEvent.durationMs` is `number | null`.

**Deadlines.** A deadline is re-evaluated on every data update.

**Metric latch.** A metric trigger is a two-state latch per group, and each firing is recorded with its reads.

### 10. Placement and preflight

- `command.on(...runners)` places an invocation on any listed runner with a free slot.
- `command.on(record, key)` pins each invocation to a runner chosen from its input.
- `command.preflight(check)` runs a check before the invocation.

### 11. One model, many accounts

A `Model` is identity and price. The `Account` carries the driver.

### 12. Cost, quota, memory, durability, control API, validation

These are as in the parent:

- **Cost.** `maxUsdPerUnit` blocks the attempt on `kernelHalts.costCeiling`.
- **Quota.** Shared quota is an append-only ledger partition, `sqlite.ledger(path, { sharedQuota })`.
- **Memory.** Recall is a fixed deterministic kernel policy.
- **Durability.**
  - The ledger replays a resumed attempt.
  - Recovery is declared per executable.
  - A submitted batch is collected, never resubmitted.
  - A lease enforces a single writer.
  - A definition change parks the attempt on `kernelHalts.definitionChanged`.
- **Control API.** As before, plus `work.retry(key)`.

## What changed and why

**Added:**

- `H.tag`
- `FlowShape.phases`
- `HandlerArgs` / `PhaseMap`
- `Lane.retry`
- `Command.on(placement, key)`
- `Command.preflight`
- `Kind.create`, `Kind.update`, `Kind.entered`, `Kind.attempts`
- `Executable.invocations`
- `H.modelInvocations`
- `Trigger.tripped`
- `LaneRef.pauses`
- `EntryFilter.where`
- `Metrics.count`
- `RatesBy<K>`
- `kernelHalts`
- `ControlApi.work.retry`
- `UnitRecord.held`

**Removed:**

- `SupplyOf`
- raw `EntryFilter` fields
- `byTag` strings
- `Result.model`
- `UnitView.kind` and `UnitView.lane`
- `claude-code.model`
- `ssh.host` preflight
- `H.policy.rule(name, fn)`

**Changed:**

- `failsTo` now applies when the lane's retry policy stops.
- Preemption restarts from the top.
- `Model` no longer has a driver.

### Writing scenarios 06–10 (this pass)

**1. `MetricEvent.crossing: string` added** (Scenario 9).

- **Problem.** A metric trigger that creates a unit on trip and must cancel that same unit on reset needs a key both firings share. A category key alone cannot be reused, because a second crossing after an earlier Audit closed would collide with the terminal unit. Before this change, the only workarounds were:
  - reading the ledger in the trigger, or
  - inventing a supplier.
- **Change.** `crossing` is the id of the tripping firing. The kernel repeats it on the reset of the same latch cycle. The Audit key is then `audit-${group}-${crossing}`.
- **Effect on deduplication.** Deduplication by group key stays the latch's job, and is now addressable.

**2. `ModelChoice` re-exported from `harness-dsl`** (Scenario 6).

- **Problem.** A model policy that ranks two agents by `rateBy({ by: { model: agent } })` must name the very agent it configures. An inline arrow makes the agent's type depend on its own initializer, which triggers TypeScript's circularity error.
- **Change.** The policy is written as a function declaration whose signature is `(choice: ModelChoice) => Model`. That breaks the cycle without `any`, and the type now comes from the main module.
- **Possible later change.** A role-level grouping (`by: { model: role }`) would remove the declaration. It was not added, because only this scenario needs it (principle 21).

**3. Rule 2 states that a flow may end in a waiting phase.**

- Scenario 6 ends a review with Draft `returned`, and Scenario 8 ends a review with Tenancy `between-reviews`.
- In each case the unit is parked until a supplier, an operation or a clock moves it.
- The attempt's outcome is `succeeded`.

### Known gaps

**Scenario 7's shared module** is shown as a shared section inside one file. Scenario files may import only `harness-dsl` modules, so two harness files cannot import one module here. Both harnesses are exported from the one file, and each process starts one of them.

**Scenario 6** records fact-check lessons from the command's output through `ctx.remember`. Commands have no `records`. The lesson is still produced by the command and recorded by the kernel; the flow only routes it.

## Principles broken

None.
