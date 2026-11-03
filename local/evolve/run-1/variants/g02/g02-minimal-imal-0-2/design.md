# harness-dsl: g01, scenario 8 repaired

This child of `g00-minimal-0` fixes the scenario its adversary found worst: scenario 8, lifecycles that do not fit.

The parent's root defect was a seven-outcome skeleton combined with no way for a flow to say "this attempt failed". Authors therefore returned whatever state would compile, and the state lied.

This variant does three things:

- It adopts principle 12 as amended: three attempt outcomes, four unit positions, and terminal verdicts.
- It gives flows an honest failure value.
- It answers the adversary's three sharp critiques.

Scenarios 9 and 10, which the parent did not cover, become expressible as a side effect.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state.pending(n)`, `.active(n)`, `.waiting(n)`, `.terminal(n, verdict)` | A named state. It declares its position; a terminal state also declares its verdict. States are shareable entities. |
| Kind | **kind** | `H.kind(n).data(z).states([...], initial).onFailure(state?)` | One sort of work: a data shape plus a list of states. |
| Kind | **resource** | `H.resource(n)`, `.of(key)` | Something work touches: a service, a database, a section. Used in memory scope, recall scope and leases. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'fallible' \| 'owner')` | A memory kind. Experience is `fallible`; taste is `owner`. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapter subpaths only | Resources that carry their backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params).suppliers(...).store(s).wip(n).maxUsdPerUnit(x).retry(p)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | A recall source: memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, members, policy)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Composite | **flow** | `H.flow(n).for(...kinds).params(z).does(ctx => ...)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(runner).restart(rule)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, recall, retry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger(l).lanes().pools().triggers().scheduler(p).clients().observers()` | The running thing. |

Two things are suppliers with no backend, because the clock and the control API are kernel:

- `H.timetable(name, kind, cadence, produce)`
- `H.operator`

## Execution vocabulary

- **Run**: one lifetime of a harness process. It begins with a `run` entry, written after the writer claim.
- **Attempt**: one execution of a lane's flow for one unit.
  - While it is live it is `running`, `blocked` or `suspended`:
    - `blocked`: on a halt waiting for a human;
    - `suspended`: on `ctx.wait`, waiting for time or for children.
  - It ends with exactly one outcome: `succeeded`, `failed` or `cancelled`.
  - A crash marks it `interrupted`, then `resumed`. It is never a new attempt.
- **Invocation**: one call of one executable inside an attempt.
  - Each retry is a new invocation.
  - Each batch item is its own invocation; the items share a `batchId`.
- **Step**: not a word in this design.

## Rules

### 1. Skeleton (principle 12)

**Attempts.**
- An attempt ends `succeeded`, `failed` or `cancelled`.
- A flow that returns a state ends its attempt `succeeded`: the execution worked, whatever the work's verdict.
- A flow that returns `ctx.fail(reason)` ends it `failed`.
- A move from outside (supplier, trigger, operation, preemption) ends a live attempt `cancelled`.

**Units.**
- Every state declares a position: `pending`, `active`, `waiting` or `terminal`.
- The scheduler starts only `pending` units.
- `waiting` units hold no WIP and no runner slot.
- Every terminal state declares a verdict: `success`, `failure` or `neutral`. There is no default.

**Failure default.**
- After a failed attempt, the unit returns to its last pending state under the lane's `retry` policy.
- The default lane policy is exponential backoff with no limit.
- If the kind declares `.onFailure(state)`, a failed attempt moves the unit there instead.
- A lane retry policy that can return `'stop'` requires the kind to declare `onFailure`. `start()` checks this.

### 2. What a flow may write

The types enforce all of this.

- `ctx.move(s)` accepts only `active` states.
- A flow returns one of:
  - a `pending` state, which re-queues the unit;
  - a `terminal` state, which ends the unit;
  - `ctx.rest(waitingState, wake?)`, which ends the attempt and parks the unit;
  - `ctx.fail(reason)`.
- `await ctx.wait(waitingState, { at | children })` suspends the attempt in place:
  - the unit sits in the waiting state;
  - the attempt holds nothing;
  - on wake, the same attempt resumes after the `wait`.
- Rest versus wait: `rest` ends the attempt, and `wait` keeps it. Tenancies and negotiations rest between rounds. A release waits for its smoke children.

### 3. Wake conditions are tied to the state they were armed in

- A wake fires only if the unit is still in the state that `rest` or `wait` put it in.
- Any other move clears the wake.
- So a tenancy suspended by the billing webhook never wakes into `review-due`. Suspension is a rest with no wake.

### 4. Success rate

`successRate(kind)` is `success / (success + failure)` over terminal transitions, with `hits` and `samples`.

- `neutral` verdicts are outside the denominator.
- Neutral verdicts are counted by state through `rate`, `rateBy` and `tally` with `position: 'terminal'` and `state`.
- So "how often are experiments inconclusive" is `rate({ among: { kind, position: 'terminal' }, count: { state: 'inconclusive' } })`.
- `loaded-with-warnings` is a second `success` state: it is success to the scheduler and distinct by name.

### 5. Durability by replay, with declared restart behaviour

Every `run`, `batch`, `halt`, `wait`, `decide`, `move`, `update`, `remember` and `spawn` is a ledger entry with a sequence number. On restart:

1. **Writer claim.** The kernel takes `ledger.claimWriter(holder, ttl)` and renews it while running.
   - A second process against the same ledger is refused while the claim is live.
   - It takes over, recording `run: took-over`, once the claim's TTL has lapsed.
2. **Interruption.** Every live attempt gets an `interrupted` entry, then `resumed` when re-entered.
   - Interruption is never an attempt outcome and never a model failure.
   - Metrics count the attempt once.
3. **Definition check.** The attempt's `flowVersion` is compared with the current flow.
   - If they differ, the kernel raises a kernel halt `definition-changed` with decision `{ restart | abandon }`.
   - Replay that reaches a recorded entry with a different executable or sequence raises the same halt.
   - Abandon ends the attempt `cancelled`. Restart starts it from the top under the same attempt id.
4. **Replay.** Completed invocations, resolved halts and finished waits return their recorded results at no cost.
   - A halt resolved while the harness was down is already on the ledger, because the control API writes it.
   - Children that terminated while the harness was down are read from the ledger. Children still running are left alone.
5. **The invocation that was running** follows its executable's `afterCrash` rule:
   - `'rerun'`: invoke it again.
   - `'park'`: kernel halt `unsafe-restart` with decision `{ continue | rerun | abandon }`. This is the default for commands.
   - `{ check }`: run the check executable. A non-null result is taken as the step's output; null parks the attempt.
   - `'reconcile'`: ask the model driver `reconcile(session)`. The session id is recorded via `onSession` before the call is awaited. This is the default for agents whose model supports it; otherwise they park.
6. **Batches.** A submitted batch has its `batchId` recorded before it is awaited, and is collected with `collect(batchId)`, never resubmitted.

The author writes only `.restart(...)` on the commands and agents whose default is wrong. No flow code is involved.

### 6. Halts are the one human mechanism

There are three origins:

| Origin | Raised by |
|---|---|
| `flow` | `ctx.halt` |
| `agent` | A driver response `asked`. The kernel raises a halt `question` with decision `{ answer }` and re-invokes the agent with the answer. |
| `kernel` | `cost-ceiling`, `definition-changed`, `unsafe-restart` |

All are resolved through `halts.resolve`. Roles that may ask carry the `ask` intent; no output field is needed.

### 7. Supply and moves

- A supplier emits `create` or `update`. An update may set a state. A webhook can therefore update an existing negotiation.
- Any move from outside a live attempt cancels the attempt first.
- The ledger keeps every unit's snapshot, so a kind with no store still has data, state and telemetry.

### 8. Triggers

**Sources.**

| Source | Fires |
|---|---|
| `enters` | on entering a state |
| `streak` | after N consecutive entries of a state, per group |
| `deadline` | at a date read from unit data |
| `time` | on a cadence, for units in given states |
| `metric` | on a threshold crossing, per group |

- **Deadlines** are re-armed on every data change. Extending an SLA through `work.update` moves the timer, and the old deadline never fires.
- **Metric sources** are evaluated on their interval over the ledger only.
  - They carry two thresholds, `enter` and `exit`.
  - They fire once per crossing, per group, and only with at least `minSamples`.
  - The reading is recorded on the `firing` entry.

**Effects.**

| Effect | Does |
|---|---|
| `create(lane, data, { key, oneOpenPer })` | Creates a unit. With `oneOpenPer`, it is ignored while a non-terminal unit of that lane holds that group. |
| `move(state)` | Moves the source unit. The type is `never` for metric sources. |
| `close(lane, group, state)` | Moves the open unit holding a group. |
| `remember(library, draft)` | Records a memory item. |
| `pause(lane, reason)` / `resume(lane, reason)` | Records a `lane` entry carrying the reading. Nothing new starts in a paused lane; running attempts finish. `metrics.paused({ lane })` sums the paused time. |

### 9. Cost

- `maxUsdPerUnit` is cumulative across all of a unit's attempts.
- An invocation that would pass it raises the kernel halt `cost-ceiling`.
- Daily budgets are scheduler-policy reads of `metrics.sum`.
- Batch invocations are priced at the model's `batchDiscount` and tagged `mode: 'batch'`.

### 10. Scheduler

- There is one `H.policy.scheduler`. It returns an ordered `start` list and optional `preempt` list.
- The kernel starts units in order while lane WIP, pauses and runner slots allow.
- Blocked attempts release runner slots but keep lane WIP.
- Suspended attempts and waiting units hold nothing.

### 11. Accounts and quota (principle 15)

- Account window state is a **ledger partition**: `ledger.quota: QuotaPartition`.
  - It is append-only `QuotaEvent`s: usage, cooldown and window, each stamped with the harness name.
  - The kernel folds the window at read time.
  - It has no lock and no writer claim. The writer claim covers the work partition only.
- By default the ledger's own backend holds the partition.
- Two harnesses sharing accounts give their ledgers the same partition: `sqlite.ledger(path, { quota: sqlite.quota(sharedPath) })`.
- Accounts carry no quota option, so within one harness an account cannot have two books.
- Shares belong to the pool, and therefore to one harness.

### 12. Memory

- The kernel owns the envelope: `id`, `created`, `when`, `status`.
- `when` names entities (kinds, roles, resources), not strings.
- `candidate` items are never recalled until accepted.
- Recall is a policy over the store's `search`. Similarity is an input the backend supplies; the ranking is still the policy's.
- Reads union across the libraries an agent `recalls`. Writes go to the one library it `records`.

### 13. Runner routing

- `command.on(runner)` sets the default runner.
- `ctx.run(cmd, input, { on: runner })` routes one invocation.
- Kind data never names a runner. A harness maps its own vocabulary (for example `z.enum(['orders', 'users'])`) to runners in a typed record, so a typo is a compile error.

### 14. Startup validation

`start()` fails on any of these:

- duplicate names;
- a flow that does not cover its lane's kind;
- an unknown state in a trigger;
- an unregistered lane in a trigger;
- a `'stop'`-capable lane retry without `onFailure`;
- an agent no pool can serve;
- `'reconcile'` on a model without `reconcile`;
- `batch` on a model without `submit`;
- a missing ledger;
- a live writer claim held by another process.

Harnesses with no pools, agents or models are valid.

## What changed and why

**Scenario 8 (operator target).**

- **Principle 12 adopted.** The parent's `idle` and `ended` outcomes become the `waiting` position and the `neutral` verdict. States are now entities with declared positions.
- **`ctx.fail(reason)` replaces the lies.**
  - A negotiator or mail failure is a failed attempt; the unit stays pending under retry. It is no longer `'vendor-replied'`.
  - A classifier crash in scenario 2 is a failure, not `escalated`.
  - A failed hourly experiment sample is a failed attempt, retried. Missing data therefore stays visible.
  - A kind that wants "insufficient data" declares a separate neutral terminal state; it is not conflated with `inconclusive`.
- **Typed positions.** `move` takes active states only, and returns take pending or terminal states, `rest` or `fail`. A flow can no longer smuggle a wrong-position state.
- **Wake bound to its state (Rule 3).** This closes the tenancy suspension race.

**Adversary critique (a): "schedule" named four things; halts had two mechanisms.**

- The supplier is now `H.timetable`.
- The decision is `H.policy.scheduler`, set by `.scheduler(...)`.
- The time trigger is `H.on.time`.
- `TimeSpec` is renamed `Cadence`.
- Agent `asked` responses become kernel-raised halts (Rule 6). The builder's `question` output field is gone.

**Adversary critique (b): kind data carried runner identity.**

- Runner routing moves to `RunOptions.on` (Rule 13).
- `H.resource` replaces raw strings in memory scope and recall scope.
- This also answers seed weakness W4.

**Adversary critique (c): `Ledger extends QuotaBook`.**

- Quota is now a named ledger partition (`Ledger.quota`), not an interface the ledger also happens to be, and not an account option (Rule 11).
- What remains possible: harness B is configured without the shared partition.
  - Nothing in one process can prove another process's configuration.
  - Instead, drivers report `reportedUtilization`. When the provider's figure exceeds the folded partition, the kernel records a drift warning, so the misconfiguration shows up in telemetry.

**Side effects that cover scenarios 9 and 10.**

- **Scenario 9:** metric sources with hysteresis, `oneOpenPer`, `close`, `pause` and `resume`, `lane` entries, `metrics.paused`, `metrics.tally`, deadlines re-armed on data change, and `hours` windows.
- **Scenario 10:**
  - `restart` rules on commands and agents;
  - `onSession` and `reconcile`;
  - `submit` and `collect` batches;
  - `flowVersion` and the `definition-changed` halt;
  - `ctx.wait` for children;
  - the writer claim;
  - `interrupted` and `resumed` attempt entries.

**Removed.**

- `H.lifecycle`: arrays of state entities are shareable.
- `InferSchema`.
- The `quota` option on accounts.
- `command.on(fn)`: replaced by `RunOptions.on`.

## Principles broken

none

The parent broke principle 12 with a seven-outcome skeleton. The amended principle now covers its reasons:

- the `waiting` position covers years-long units that hold no capacity;
- the `neutral` verdict covers terminal states that are neither success nor failure.

The break is repaired, not restated.
