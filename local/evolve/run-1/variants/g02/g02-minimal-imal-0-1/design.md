# harness-dsl: minimal, cut (g01, child of g00-minimal-0)

The parent's shape stays: a small vocabulary, flows that are durable by replay, and policies as the only place where decisions are made. This child does four things:

1. It cuts every method and option the battery does not call.
2. It brings the skeleton back to the current principle 12.
3. It moves shared quota into a ledger partition (principle 15).
4. It answers the adversary's three critiques.

It also adds the smallest surface that scenarios 9 and 10 need, because the parent reached only 8/10 coverage.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` | A named lifecycle state with its position. Terminal states carry a verdict. States are shareable entities. |
| Kind | **kind** | `H.kind(n).data(z).states([...], initial).failsTo(state?)` | One sort of work: a data shape plus states. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. It lists intents, never tool names. |
| Kind | **memory** | `H.memory(n, 'fallible' \| 'owner')` | A memory kind. Experience is `fallible`; taste is `owner`. |
| Kind | **resource** | `H.resource(n)` | Something work touches: a service, a database, a section. It is used in recall scope and in memory `when`. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources that carry their backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?).suppliers().store().wip().maxUsdPerUnit()` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | The recall source for one memory kind: memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(ctx => …)` | A handler body. |
| Composite | **command** | `H.command(n).input().output().argv().on().restart()` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model,account,scheduler,recall,retry,rule}` | One entity with six decision shapes. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

Two suppliers ship with no backend, because the clock and the control API are kernel:

- `H.timetable(name, kind, at, produce)`
- `H.operator`

## Execution vocabulary

- **Run**: one lifetime of a harness process, from the moment it claims the ledger's writer lease until it stops or the lease expires.
- **Attempt**: one execution of a lane's flow for one unit.
  - Its outcome is `succeeded`, `failed` or `cancelled`.
  - While live, it is running or blocked.
- **Invocation**: one call of one executable inside an attempt.
  - A step retry is a new invocation.
  - Each batch item is its own invocation.
- **Step**: not a term. Where the battery says "step", read "invocation".

## Rules

### 1. Positions and verdicts (principle 12, as amended)

A unit is at one of four positions:

| Position | Meaning |
|---|---|
| `pending` | Schedulable. |
| `active` | An attempt is live. |
| `waiting` | Parked. It holds no capacity and is not schedulable. |
| `terminal` | Finished. |

Each state declares its position:

- Example of a non-terminal state: `H.state('todo', 'pending')`.
- Example of a terminal state: `H.state('done', { terminal: 'success' })`.
- A terminal state's verdict is `success`, `failure` or `neutral`, with no default.
- State names are unique per harness. Kinds that both have a `cancelled` state share one entity.

### 2. Success rate

- Success rate is `success / (success + failure)` over terminal transitions of a kind.
- Neutral terminals (inconclusive, parked, churned, walked away, rejected) are excluded from the denominator. Each is countable by state through `rate` and `rateBy`.
- "Loaded with warnings" is a second success state: it is success to the scheduler and distinct by name in metrics.

### 3. Attempt failure is not a state

- A flow returns `ctx.fail(reason)` to end its attempt `failed`. This is the only way.
- By default, the unit then returns to its pending state, retried with exponential backoff (1 minute doubling, capped at 1 hour, 3 failures).
- A kind that declares `.failsTo(state)` moves there once retries are exhausted.
- Without `failsTo`, an exhausted unit stays at pending with `retriesExhausted`. It is shown on the board and not offered to the scheduler until an operation moves it.
- No flow may disguise a failure as a pending or neutral state.

### 4. The flow's return value is the unit's resting state

| Return value | Effect |
|---|---|
| A pending state | Re-queues the unit. |
| A terminal state | Ends the unit. The attempt is `succeeded`, whatever the verdict. |
| A waiting state | Parks the unit until a supplier update, trigger or operation moves it. |
| `ctx.until(rest, { at \| children, then })` | Parks the unit waiting with a wake condition. |
| `ctx.fail` | See rule 3. |

Any move of a waiting unit clears its wake condition. A suspended tenancy therefore cannot wake into a review.

### 5. Durability by replay

- Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember` and `spawn` is a ledger entry with a sequence number.
- On resume, the body re-executes and recorded results are returned without invoking anything again.
- Every attempt records a definition fingerprint.

### 6. Restart rule, declared per command

The interrupted invocation is handled according to `.restart(rule)` on the command:

| Rule | Behaviour |
|---|---|
| `'rerun'` | Run the invocation again. |
| `'park'` (the default for commands) | Block the attempt on the kernel halt `restart-uncertain`. |
| An executable returning `boolean` | Ask whether the effect happened: `true` continues, `false` parks. |
| `'ask'` (the default for agents) | Call the driver's `Model.recover(invocation)`. If the driver answers `'unknown'`, park. |

The other cases need no declaration:

- A batch invocation with status `submitted` is collected through `collectBatch`, never resubmitted.
- Halts resolved while the harness was down are found in the ledger.
- Children are read from the ledger and are not restarted.
- If replay meets a different executable or halt at a recorded sequence number, the attempt blocks on the kernel halt `definition-changed`. The supervisor resolves it with `restart` or `abandon` through `resolveHalts`. No new operation is needed.

The attempt keeps its id and gets `interrupted`/`resumed` entries. Interrupted invocations are flagged and excluded from model, agent, runner and account metrics.

### 7. Single writer

`start()` calls `ledger.claim(holder, ttl)` and then renews the lease:

| Result | Effect |
|---|---|
| `held` | The second copy refuses to start. |
| `took-over` | The first holder's lease had expired; this copy proceeds and records a run entry. |

### 8. Shared quota is a ledger partition (principle 15)

- A ledger exposes `quota: QuotaPartition`, which supports only `append` and `fold`.
- `sqlite.ledger(path, { sharedQuota })` places that partition in a shared file.
  - Every harness appends its own consumption and cooldown events.
  - Every harness folds the window at read time.
  - No lock is taken. The main ledger's single-writer lease does not cover the partition.
- Accounts do not select a quota book:
  - The choice is made once, on the harness's ledger. One account cannot be pointed at different books.
  - Two harnesses agree by importing the same ledger option from the shared module.
- Shares stay on the pool, so they stay per harness.

### 9. Moves cancel live attempts

- A supplier update, a trigger's `act.move` or `work.update` that moves a unit with a live attempt first ends that attempt `cancelled`.
- A deadline source recomputes `due(data)` on every data change. The old deadline never fires, so an extended SLA moves its timer.

### 10. Triggers

- **Sources:** `enters`, `streak`, `deadline`, `time`, `threshold`.
- **`threshold`:**
  - It evaluates `measure(metrics)` per group after each ledger append.
  - It fires `crossed` when a group passes `crosses` with at least `minSamples` samples.
  - It fires `recovered` when the group passes `recovers`.
  - Its last phase per group is read back from its own firing entries. That gives hysteresis and one firing per crossing.
- **Effects:** `create` (deduplicated by key while that unit is non-terminal, optionally tagged), `move` (the event's unit, or `lane, key, state`), `remember`, `pause`, `resume`.
- **Unit tags:** a unit created with tags carries them on every ledger entry about it (transitions, attempts, invocations, halts). Metrics can therefore filter and group created units by a key the trigger knew, such as the category of an Audit.
- Pause and resume write `lane` entries carrying the firing and the metric value. A `resumed` entry's `durationMs` is the length of the pause, so total paused time is a `sum`.
- Every firing is recorded.

### 11. Scheduler

- The single scheduler policy returns `start` and optionally `preempt`.
- WIP counts active units, and blocked attempts count toward it. Waiting units count toward nothing.
- A paused lane starts nothing new.
- Preempted attempts end `cancelled`.

### 12. Memory

- The envelope is `id`, `created`, `when` and `status`.
- `when` names kinds, roles and resources as entities, plus skill strings.
- `candidate` items are not recalled until accepted.
- Reads union across the libraries an agent `recalls`. Writes go to the one library it `records`.
- An agent's `ask` intent produces a `ModelResponse` of status `asked`. The kernel turns it into an ordinary halt named `<agent>-question`, and the answer resumes the same invocation.
- There is one human-in-the-loop mechanism: the halt.

### 13. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it blocks the attempt on the kernel halt `cost-ceiling`.

### 14. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names (a shared state counts once);
- a lane/flow mismatch;
- unknown states in flows, triggers or `failsTo`;
- a `failsTo` state that is not terminal with a `failure` verdict;
- an unregistered lane in a trigger;
- an agent no pool can serve;
- a command without argv or runner;
- a batch on a model without `submitBatch`;
- an unclaimable ledger.

A harness with no pool, agent or model is valid.

### 15. Operator actions are halt resolutions

- An editor's or approver's decision is the `decision` of a resolved halt entry, recorded with the attempt's tags.
- An owner-defined metric over operator actions is a `rate` over halt entries filtered by `decision` and `tags`. Scenario 6 uses this.
- No separate "action" entry exists.

## Answers to the adversary

**(a) "schedule" names three things.** Each word now has one meaning:

| Name | Meaning |
|---|---|
| `H.timetable` | The supplier. |
| `H.policy.scheduler` / `.scheduler()` | The scheduler. |
| `H.on.time` | The trigger source. |
| `TimeSpec` | Only the value type they share. |

The `halt` versus `asked` duplication is removed by rule 12: `asked` is the driver's way to raise a halt.

**(b) Kind data carries runner identity; strings stand for entities.**

- `H.resource` makes scope and `when` take entities.
- Runner selection stays `.on(input => Runner)`. The scenarios key it on a `z.enum` field of the unit's own vocabulary, mapped through a record. The kind never names a runner.

**(c) `Ledger extends QuotaBook`.** This is replaced by rule 8.

## What changed and why

Cut, because the battery never needs them or only one caller used them:

| Cut | Replacement |
|---|---|
| `H.lifecycle` | an array of state entities |
| `H.slot.port` | none; no caller |
| `InferSchema` | none |
| `DataOf`/`StateOf` | one `SupplyOf<K>` |
| `MemoryKind.data` and the `M` generic on library/draft | none; no caller |
| The 3-kind `for` overload | none |
| The `Lifecycle` overload of `states` | none |
| `H.ops.curateMemory` | folded into `writeMemory` (write, accept, merge, drop) |
| `QuotaBook` and `sqlite.quota` | the quota partition (rule 8) |
| The `quota` option on accounts | the quota partition (rule 8) |
| The `model` filter and `'model'`/`'kind'`/`'lane'`/`'executable'` groupings | tag grouping |
| `Ref` ports | env refs only |
| The `outcome` filter over seven outcomes | `position`, `verdict` and `outcome` (attempt) |

Added, each with its scenario:

| Addition | Scenarios |
|---|---|
| `H.state` (principle 12 now requires state entities) | all |
| `.failsTo`, `ctx.fail` (principle 12's failure default) | 1, 5, 8 |
| `H.resource` (critique b) | 1, 4, 6 |
| `Command.restart` | 10 |
| `H.on.threshold`, `act.pause/resume`, `act.move(lane, key, state)` | 9 |
| `Window.hours`, the `mode` filter, the `'entries'` measure | 9 |
| `Model.submitBatch/collectBatch/recover`, `Ledger.claim/renew`, `QuotaPartition` (kernel only) | 10, 7 |

Renamed:

| Before | After |
|---|---|
| `H.schedule` | `H.timetable` |
| `H.policy.schedule` | `H.policy.scheduler` |
| `H.on.clock` | `H.on.time` |
| `idle` | `waiting` |
| `ended`/`succeeded`/`failed`/`cancelled` positions | terminal plus verdict |

### Scenario pass 06–10

Writing scenarios 6–10 exposed two gaps. Both are fixed by widening an existing surface; no new entity or method is added.

**1. Created units could not be grouped by the trigger's key.**

- The problem: scenario 9 must count "Audits opened per category this month". An Audit's category lives in its data, and metrics never read unit data. The threshold firing knows the group, but the firing count is not the audit count, because creation is deduplicated.
- The fix: `act.create(lane, data, key?, tags?)` takes optional unit tags, and the kernel stamps them on every entry about that unit (rule 10).
- The count is then a `sum` of `entries` over transitions into `audit-open`, filtered by the `category` tag.

**2. Creations could not be told apart from retries.**

- The problem: a transition into a pending state happens both when a unit is created and when a failed attempt returns it to pending. Counting "opened" units honestly needs to tell them apart.
- The fix: `EntryFilter.cause` filters transitions by their recorded `cause`.
- `TransitionEntry.cause` already existed; only the filter is new.

Clarified, with no surface change:

| Clarification | Where it is used |
|---|---|
| Operator actions are halt resolutions (rule 15). | Scenario 6's acted-on metric. |
| Scenario 7 writes its "shared module" as the shared section at the top of one file, because a scenario is one file. Both harnesses reference the same account, ledger-option and library descriptors. | Scenario 7 |

## Principles broken

None.
