# harness-dsl: reconcile (child of g00-minimal-0)

The parent's surface was mostly sound; its execution model was not. This child keeps the parent's vocabulary. It rebuilds units, attempts, re-entry, cancellation, time and external events on the Kubernetes controller pattern:

- **Desired state.** A unit's `data` and `state` are desired state. The ledger records every change to them as a new **generation**.
- **Reconcile.** A lane's flow is a reconciler. One attempt reconciles one unit at one generation.
  - The attempt ends when the flow returns a resting state for the unit.
  - Re-entry is a new attempt, never a long-lived one.
- **Conditions.** Facts about attempts and lanes that are not states are kernel-owned conditions with a reason and a timestamp. Examples: blocked, interrupted, definition changed, cost ceiling, superseded, paused.
- **Owner references.** A spawned unit records its owner. The owner can wait on its children's positions without holding capacity.

The lens word "controller" is not adopted, because the owner's words already fit: lane, flow, attempt. "Generation" and "condition" are adopted, because nothing in the brief named them.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(n, 'pending'\|'active'\|'waiting')`, `H.state(n, 'terminal', verdict)` | One named state with its position. A terminal state also has a verdict. States are shareable entities. |
| Kind | **kind** | `H.kind(n).data(z).states([...], { initial, afterFailure })` | The vocabulary of one sort of work. |
| Kind | **resource** | `H.resources(group, names)` | Named things that work touches: services, databases, sections, hosts' charges. A group's `.schema` is a zod enum usable in kind data. |
| Kind | **role** | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. Its intents are `read`, `edit`, `execute`, `browse`, `halt`. |
| Kind | **memory** | `H.memory(n, 'experience'\|'taste')` | A memory kind. |
| Instance | account, model, runner, store, memory store, quota book, supplier, ledger, guard, observer, client | adapters only | Each carries its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m\|policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params).suppliers().store().touches().wip().maxUsdPerUnit()` | A work queue: kind × suppliers × store × handler, plus the resources a unit touches. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | A recall source: memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, members, policy)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Composite | flow, command, policy, operation, calendar | `H.flow`, `H.command`, `H.policy.*`, `H.ops.*`/`H.operation`, `H.calendar` | Described below. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

## Execution vocabulary (one definition each)

- **Run**: one lifetime of a harness process. A run holds the ledger's writer lease.
- **Attempt**: one reconciliation of one unit by its lane's flow.
  - It starts from a pending state at a known generation.
  - It ends when the flow returns, fails or is cancelled.
  - Its outcome is `succeeded`, `failed` or `cancelled`.
  - While it lives it is `running` or `blocked`. It may also be `parked`, which means held for the supervisor after a restart problem.
  - An attempt survives a run boundary with the same id.
- **Step**: one recorded call inside an attempt. The calls are `run`, `batch`, `halt`, `spawn`, `remember`, `decide`, `move` and `update`.
  - A step has a sequence number and a name. The name defaults to the executable's or the halt's name.
  - A step is the unit of replay.
- **Invocation**: one execution of an executable inside a step.
  - A retried step has several invocations.
  - A batch step has one invocation per item.
  - Invocation status is `ok`, `failed`, `timed-out`, `interrupted` or `recovered`.

## Rules

### 1. Skeleton (principle 12, as amended)

- A unit is at one of four positions:
  - `pending`: schedulable.
  - `active`: an attempt is live.
  - `waiting`: parked. The unit holds no capacity and is not schedulable.
  - `terminal`.
- An attempt's outcome is one of three: succeeded, failed, cancelled.
- Every terminal state declares `success`, `failure` or `neutral`. There is no default; the type requires the third argument.
- A kind's success rate is `success / (success + failure)` over terminal transitions. `neutral` terminal states are excluded from that rate. They remain countable by state name.

### 2. Positions are enforced by types

- `ctx.move` accepts only active states.
- A flow returns one of these, and the result is a resting state:
  - a pending state, which requeues the unit;
  - a waiting state, which parks it until an outside move;
  - a terminal state;
  - `ctx.wait(waitingState, { at?, children?, then: pendingState })`.
- Suppliers and triggers may set pending, waiting or terminal states, never active ones.

### 3. Attempt failure is not a unit state

- `ctx.fail(reason)` ends the attempt `failed`. The unit then moves to the kind's declared `afterFailure` state.
- A flow never needs to pick an unrelated state to report a crash. This repairs the parent's `if (!ok) return 'vendor-replied'`.

### 4. Re-entry

- `ctx.wait` ends the attempt `succeeded` and records a wake condition on the unit.
- The wake condition is a time, the children reaching terminal, or both.
- When it is met, the unit moves to `then`, and the next attempt starts from there.
- An Epic therefore has several attempts, and none of them holds a slot while Features run.

### 5. Generations and outside changes

- Every supply `update`, trigger move and `work.update` operation increments the unit's generation.
- **Changes that set a state.** If an outside change sets a state while an attempt is live, the kernel cancels that attempt with condition `Superseded`, then applies the move.
- **Patch-only changes.** These do not cancel. The live attempt keeps the snapshot it started with.
- **Wake conditions.** Any outside move replaces the unit's wake condition. A suspended tenancy cannot wake into `review-due`.

### 6. Timers are recomputed per generation

- `H.on.deadline(kind, due, whileIn)` arms a timer from `due(data)` at each generation.
- A timer armed at an older generation never fires. Extending an SLA is therefore a patch.

### 7. Owner references

- `ctx.spawn(lane, data[])` creates units whose `owner` is the spawning unit.
- `ctx.children()` reads them, by position, from the ledger.

### 8. Triggers

- **Sources:**
  - `enters(kind, states)`;
  - `streak(kind, state, n, group)`;
  - `deadline(kind, due, whileIn)`;
  - `time(kind, spec, whileIn)`;
  - `metric({ every, read, enter, exit })`.
- **How a metric source works:**
  - `read` returns rates keyed by group.
  - A group fires `entered` once when `enter(rate)` first holds, and `exited` once when `exit(rate)` holds after that. This is hysteresis.
  - The armed state of each group is derived from the group's last firing entry, so it survives restarts.
  - Metrics are computed from the ledger, so a metric source fires only from recorded state.
- **Effects:**
  - `create(lane, data, key?)`: ignored while a non-terminal unit with that key exists. This deduplicates by group key.
  - `move(state)`, for unit sources.
  - `moveUnit(lane, key, state)`.
  - `pause(lane)` and `resume(lane)`.
  - `remember(library, draft)`.
- **Recording:**
  - Every firing is a `firing` entry carrying group, edge, value and samples.
  - A pause or resume is a `lane` entry that references that firing.
  - `metrics.duration({ lane, condition: 'paused' })` and `metrics.countBy` answer "how long paused" and "how many Audits per category".

### 9. Supply

- Suppliers emit `create` or `update`. An `update` addresses an existing unit by key, which is how a vendor reply reaches a Negotiation.
- Time-based supply is `H.calendar(...)`.
- Operator supply is `H.operator`.
- "Schedule" now names nothing but the scheduler. This answers critique 3a.

### 10. Scheduler

- The single policy `H.policy.scheduler` returns `start` and an optional `preempt`.
- The kernel then starts units in that order, while all of these allow it:
  - lane WIP;
  - lane `paused`;
  - runner slots;
  - placement;
  - account eligibility.
- Preempted attempts end `cancelled`, and the unit returns to the state its attempt started from.
- Capacity rules:
  - Blocked attempts release runner slots but count toward lane WIP.
  - Waiting units count toward nothing.
- Account eligibility is read from each account's quota book at decision time, never cached.

### 11. Placement by resource

- `lane.touches(data => resources)` declares what a unit touches.
- A runner declares the resources it `hosts`.
- `cmd.on(hostA, hostB)` places the invocation on a listed runner that hosts one of the unit's resources. A runner that hosts nothing accepts anything.
- Resource names come from a typed group, so a typo is a compile error.
- Touched resources also join the recall scope and are visible to the scheduler, for keyed exclusion. This answers critique 3b.

### 12. Halts

- A halt can be raised in three ways:
  - by the flow (`ctx.halt`);
  - by an executable (a role with intent `halt`, whose driver returns `asked`; the answer is fed back to the same session);
  - by the kernel (`cost-ceiling`).
- All three are one `halt` entry kind. Intent `ask` is gone.

### 13. Cost

- `maxUsdPerUnit` applies across all of a unit's attempts.
- An invocation that would pass it raises the kernel halt `cost-ceiling`.
- Daily budgets are scheduler reads of `metrics.sum`.

### 14. Timeouts and retry

- `ctx.run(exec, input, { retry, timeoutMs, step })` sets both on the step.
- A timed-out invocation is killed, frees its slot, and is recorded `timed-out` with `ok: false`.

### 15. Accounts and quota

- Account window state is the ledger's quota section, keyed by account.
- An account instance may name the backend of its own partition (`quota: QuotaBook`); a subscription account must.
- Two harnesses that import one account descriptor therefore share one partition. They cannot disagree about where it lives, because the choice sits on the account, not on the harness.
- Shares belong to pools, and so to one harness.
- This answers critique 3c without a second kernel store. The quota partition is part of the ledger contract (`Ledger.quota`, `QuotaBook`), split by owner key.

### 16. Memory

- The kernel owns the envelope.
- `when` takes entity references (kinds, roles, resources) and stores their names.
- `candidate` items are not recalled until accepted.
- Recall reads the union of an agent's `recalls` and writes to its single `records`.

### 17. Control API

- The API is made of operations, and clients are granted operations.
- New in this child: `manageAttempts` (`restart`, `abandon` a parked attempt).
- Clients post halt resolutions and operations to the ledger inbox (`Ledger.post`), which is open to non-writer processes.

### 18. Startup validation

`start()` fails in each of these cases:

- duplicate names;
- a lane/flow shape mismatch (also a type error);
- an unknown state;
- an unregistered trigger lane;
- an agent no pool serves;
- a command without argv or runner;
- a step placed on runners none of which can host the lane's resources;
- a batch on a model without `submit`;
- a missing ledger;
- a refused writer claim.

Harnesses with no model, agent or pool are valid.

## Restart (scenario 10): the mechanism

Durability is replay over recorded steps. The author writes none of it.

1. **Writer lease.** At start the run calls `claimWriter`.
   - If a live run holds the lease, start refuses.
   - If the lease has expired, the new run takes over, and a `took-over` run entry names the dead run.
2. **Replay.** For each `running` or `blocked` attempt, the flow body is re-executed. Completed steps return their recorded results and cost nothing.
3. **The step that was interrupted.** This is the step with `begun` and no `done`. It is handled by its executable's `interrupted` setting, written `.ifInterrupted(...)`:
   - `rerun`: run it again.
   - `park`: park the attempt with condition `Interrupted`. This is the default for commands.
   - `ask` on an agent: call the driver's `recover(session)`. This is the default for agents.
   - `ask` on a command: run the given check. If the effect happened, record `recovered` and continue; if not, park.
4. **Batches.** The batch id is recorded at submit, so the restart calls `collect`. The batch is never resubmitted.
5. **State that moved while down.**
   - Halt resolutions posted while the harness was down are read from the inbox.
   - Children's positions are read from the ledger, so children finished while down wake the owner.
   - Running children are not touched.
6. **Changed definitions.** Each attempt records its flow fingerprint, and replay compares each step's name and sequence number with the record.
   - On any mismatch before the interrupted step, the attempt is parked with condition `DefinitionChanged` and the first differing step as the reason.
   - The supervisor then `restart`s it (a new attempt from the top) or `abandon`s it (`cancelled`).
7. **One attempt, one id.** Interrupted invocations are recorded `interrupted` and excluded from every rate. A crash is never a model, agent or runner failure.

## Brief questions

- **Is state an entity?** Yes, restored. The amended principle 12 requires it.
- **Role vs agent.** Kept separate. Scenario 6 has two agents of one role.
- **Is policy one entity?** Yes, with six decision shapes. The scheduler is one of them.
- **Is library distinct from lane?** Yes. Memory items have no position.
- **Is trigger distinct from a flow?** Yes. Flows only spawn their own children.
- **Is the supervisor an entity?** No. It is a client.

## What changed and why

| Change | Why |
|---|---|
| Seven outcomes become the amended skeleton (four positions, three attempt outcomes, verdicts on terminal states); states are entities again | Principle 12 now rules this. |
| `afterFailure` on kinds, plus `ctx.fail` | Adversary §1. Flows no longer launder crashes into domain states. |
| Generations, `Superseded`, wake replacement, timers per generation | The parent's Tenancy wake race (§1). Scenario 9 SLA extension. Scenario 2 external cancellation. |
| `ctx.until` becomes `ctx.wait`; owner references | The lens. W2 completed. |
| `H.on.metric` with enter/exit hysteresis and group keys; `pause`/`resume`/`moveUnit` effects; `lane` entries; `count`, `countBy`, `duration` metrics | Scenario 9. Adversary §2. |
| `timeoutMs` on steps; `timed-out` status | Adversary §2 (hung probe). |
| `H.resources` with a typed schema; `lane.touches`; runner `hosts`; `on(...runners)` replaces runner functions | Critique 3b and W4. |
| `H.schedule` supplier becomes `H.calendar`; `H.on.clock` becomes `H.on.time`; `policy.schedule` becomes `policy.scheduler` | Critique 3a. |
| `ask` intent and the `question` output field become intent `halt`, one halt entry kind | Critique 3a, second half. |
| Quota is a ledger partition owned by the account; required on subscription accounts | Critique 3c and scenario 7. |
| Steps, `ifInterrupted`, `Model.submit`/`collect`/`recover`, writer lease, inbox, fingerprint parking, `manageAttempts` op | Scenario 10. |
| Removed `H.lifecycle`, `H.slot`, `DataOf`/`StateOf` (replaced by one `SupplyOf`), the memory data generic | Principle 21. |

## Principles broken

None.

- **Principle 12** is now met.
- **Principle 15** holds. Quota remains ledger state. The ledger contract's quota section may have a different backend per account, and that backend is still an implementation of the ledger's `QuotaBook` interface, not a second kernel store.
- **Principle 10** holds. `afterFailure` and `initial` are lifecycle facts of the kind, not relationships to other entities. Resources touched by a unit are declared on the lane (`touches`), not on the kind.
