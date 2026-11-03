# harness-dsl: minimal seed

This design uses the smallest surface I can defend against the eight scenarios. I started from the assumption that eight nouns are too many. The battery forced back the ones listed below. Each entity that stays has at least one scenario that cannot be written without it.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **kind** | `H.kind(n).data(z).states(map, initial)` | The vocabulary of one sort of work: a data shape plus a lifecycle. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. It names intents, not tool names. |
| Kind | **memory** | `H.memory(n, 'fallible' \| 'owner').data(z?)` | A memory kind. Experience is `fallible`; taste is `owner`. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota book, guard, observer, client | adapters only | Specific resources that carry their backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params).suppliers(...).store(s).wip(n).maxUsdPerUnit(x)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | The recall source for one memory kind: memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Composite | **flow** | `H.flow(n).for(...kinds).params(z).does(async ctx => state)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(runner)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model,account,schedule,recall,retry,rule}(n, fn)` | One entity with six decision shapes. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger(l).lanes(...).pools(...).triggers(...).scheduler(p).clients(...).observers(...)` | The running thing. |

Some things are plain values, not entities, and are never registered:

- `H.lifecycle(map)`
- `Scope`
- `TimeSpec`
- `H.env(name)` and `H.slot.port(n)`
- `H.schedule(...)` and `H.operator`. These two are suppliers with no backend, because the clock and the control API are kernel.
- `DataOf<K>` and `StateOf<K>`. These are type helpers only.

## Execution vocabulary (one definition each)

- **Run**: one lifetime of a harness process, from `start()` until `stop()` or a crash. It is recorded as `run` entries.
- **Attempt**: one execution of a lane's flow for one unit.
  - A unit has zero or more attempts.
  - An attempt is `running`, `blocked` (halted, waiting on a human), or `ended` with succeeded, failed or cancelled.
  - The attempt's outcome describes the execution. The unit's state describes the work.
- **Invocation**: one call of one executable inside an attempt. A retry is a new invocation. Each item of a batch is its own invocation.
- **Step**: not a word in this design. It is removed.

## Rules

### 1. Lifecycle skeleton (a replacement; see Principles broken)

There are seven outcomes:

| Outcome | Meaning |
|---|---|
| `pending` | Schedulable now. |
| `active` | An attempt is running or blocked. |
| `idle` | Resting. The unit holds no capacity and is not schedulable. It wakes by time, by its children ending, by a supplier update, by a trigger or by an operation. |
| `succeeded` | Terminal. |
| `failed` | Terminal. |
| `cancelled` | Terminal. |
| `ended` | Terminal, and neither success nor failure. |

A kind maps each named state to one outcome. States are not entities: a lifecycle is a plain map. Triggers address `(kind, stateName)`.

### 2. Success rate is `hits / samples`

- Hits are units entering a `succeeded`-mapped state.
- Samples are units entering a `succeeded`- or `failed`-mapped state.
- `ended` and `cancelled` are excluded from the denominator. They are always countable by state name through `rate` and `rateBy`.
- "Loaded with warnings" is a separate `succeeded` state. It is success to the scheduler and distinct by name in metrics.
- "Inconclusive", "parked", "churned" and "walked away" are `ended` states.

### 3. Rates are honest

- Every rate carries `hits` and `samples`.
- `value` is `null` when samples is 0.
- Every metric read made inside a policy is recorded on that policy's `decision` entry.

### 4. Flows are durable by replay

- Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember` and `spawn` is a recorded entry with a sequence number.
- After a restart, the flow body is re-executed. Recorded results are returned without invoking anything again.
- Flow bodies must therefore be deterministic: they use `ctx.now()` and do no ambient I/O.
- A blocked attempt survives a restart and resumes at the same halt.

### 5. The flow's return value is the unit's resting state

| Return value | Effect |
|---|---|
| A `pending` state | Re-queues the unit. |
| A terminal state | Ends the unit. |
| An `idle` state | Parks the unit until a supplier update, trigger or operation moves it. |
| `ctx.until(rest, { at \| children, then })` | Parks the unit idle with a wake condition. |
| An `active`-mapped state | Fails the attempt. |

### 6. Flows speak the kinds they declare

- `H.flow(n).for(Bug, Feature)` types `ctx.unit.data` as `Bug | Feature`.
- `ctx.move` accepts only the states both kinds share.
- A lane accepts a flow only if the flow covers the lane's kind and the flow's states are among the kind's states.
- Per-lane differences are flow `params` supplied by the lane.

### 7. Moving a unit with a live attempt cancels the attempt first

This applies to moves from a supplier update, from a trigger's `act.move`, and from the `work.update` operation.

### 8. Supply

- A supplier emits `create` or `update`.
  - `create` is ignored if the key already exists.
  - `update` patches the store and may set a state.
- An update may re-open a terminal unit. Every terminal transition counts in metrics.
- The ledger keeps every unit's supplied snapshot, so a kind with no store still has data, state and telemetry.

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass the ceiling halts the attempt with the kernel halt `cost-ceiling`.
- Daily budgets are scheduler-policy reads of `metrics.sum`.

### 10. Scheduler

- The harness has one schedule policy. It returns an ordered `start` list and an optional `preempt` list.
- The kernel starts units in that order while lane WIP and runner slots allow.
- Preempted attempts end `cancelled`, and their units return to their prior pending state.
- Blocked attempts release runner slots but still count toward lane WIP.
- Idle units count toward nothing.

### 11. Accounts and quota

- Account window state lives in the account's `QuotaBook`.
  - By default that is the ledger's quota section.
  - When accounts span harnesses, it is a shared book (`sqlite.quota(path)`).
- Shares belong to the pool, and therefore to one harness.

### 12. Memory

- The kernel owns the envelope: `id`, `created`, `when`, `status`.
- `candidate` items are never recalled until they are accepted.
- Recall always runs a recall policy over what the store's `search` returned.
- The flow narrows the recall scope for one invocation with `run(exec, input, { scope })`. This is how a section, a skill or a resource enters recall.
- Reads union across every library an agent `recalls`. Writes go to the one library it `records`.

### 13. Triggers

- The sources are `enters`, `streak`, `deadline` and `clock`.
- The effects are `create`, `move` and `remember`.
- Every firing is recorded.

### 14. Control API

- The API is made of operations, and clients are granted operations.
- The supervisor is `claude-code.supervisor`.
- A plain HTTP client is `http.control`.

### 15. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names;
- a lane/flow mismatch;
- an unknown state in a flow or trigger;
- an unregistered trigger lane;
- an agent no pool can serve;
- a command without argv or runner;
- a missing ledger;
- a batch call on a model that cannot batch.

Harnesses with no pools, agents or models are valid.

## Brief questions

- **Is `state` an entity?** No; it is cut. A lifecycle is a plain map.

- **Is `role` separate from `agent`?** Yes. Scenario 6 needs two agents of one role on different models in one flow.

- **Is `policy` one entity?** Yes, with six decision shapes. The scheduler is a policy plus `lane.wip`.
  - `pool` is kept as its own entity. Shares are runtime-editable configuration, and a policy may not change itself.

- **Is `journal` distinct from `lane`?** Yes, and it is renamed **library**.
  - Memory items have no lifecycle, no attempts and no scheduling.
  - Mapping them onto outcomes would be the lie that scenario 8 forbids.

- **Is `trigger` distinct from a flow step?** Yes.
  - Flows may only `spawn` their own children.
  - Triggers connect unrelated kinds, and time and patterns are their sources.

- **Is `supervisor` an entity?** No; it is cut. It is a client adapter.

- **Does a flow need `.input()`?** No. `.for(...kinds)` replaces it.

## Considered and cut

| Cut | Where it went |
|---|---|
| state | a plain map |
| scheduler | a policy |
| supervisor | a client |
| journal | library |
| step | invocation |
| observer as kernel entity | an adapter interface |
| resource entity | strings in scopes and leases |
| metric entity | `rate`/`rateBy` over tagged entries |
| hierarchy on kinds | `ctx.spawn` |
| `.key()` | supply |
| trigger `run` effect | removed |
| `timeout` | removed |
| `H.libraries()` | removed |
| separate tracker supplier/store | removed |

## What changed and why

Versus the brief and the seed weaknesses:

- Flows declare the kinds they speak (W1, W11).
- `spawn` plus `until(children)` replaces the slot-holding await (W2).
- Roles carry intents (W3).
- Triggers gain time and pattern sources (W5).
- Moves cancel live attempts, and the scheduler can preempt (W6).
- Deadlines are trigger sources, and the per-unit cost ceiling is a lane setting (W7).
- The `QuotaBook` can be shared (W8).
- Triggers can `remember`, with candidate status and curation (W9).
- Run, attempt and invocation are defined (W10).
- The read-union and write-one rule is stated for libraries (W12).
- `idle` and `ended` are added to the skeleton (W13).
- Clients name their transport (W15).
- Startup validation is specified (W16).
- Journal is renamed library (W17).

Changes made while writing the battery:

- **`RunOptions.scope`.**
  - Scenarios 1, 2 and 6 need one invocation's recall to be narrowed: the payments resource, the conversation category, the draft's section.
  - Before this change there was no way for the flow to tell recall what the current work touches.
  - The scope is merged into `RecallView.scope`.
- **`EntryFilter.status`.**
  - Approval rates (scenario 2) and editor-action rates (scenario 6) must count only `resolved` halt entries.
  - Without a status filter, the `raised` entries double the denominator.
- **`DataOf<K>` and `StateOf<K>` type helpers.**
  - A supplier `read` that maps many records to `Supply` values needs to name the supply type to keep state literals.
  - The alternative was `as const`, which the standard forbids.
- **Rule 5 states that returning an `idle` state parks the unit without a wake condition.**
  - Scenario 6 (a returned draft) and scenario 8 (a negotiation awaiting the vendor) wake on supplier updates, not on time.
- **The `.d.ts` files no longer contain Markdown code fences.** The fences made them uncompilable.
- **Scenario 7 defines its shared entities in one file.**
  - Scenario files may import only `harness-dsl`, so the "shared module" is a set of constants used by two harness descriptors in that file.
  - The design point is unchanged: descriptors are values, and two harnesses can hold the same one.

## Principles broken

- **12.** The five-outcome skeleton is replaced by seven: `idle` and `ended` are added.
  - **Why `idle`:** a tenancy or a negotiation must exist for years without holding capacity, and calling it `pending` would make it schedulable.
  - **Why `ended`:** experiments, parked topics and churn are terminal but neither success nor failure, and mapping them to `failed` or `cancelled` is a lie.
  - **What success rate means afterwards:** `succeeded / (succeeded + failed)`. `ended` and `cancelled` are reported beside it with their own counts.
