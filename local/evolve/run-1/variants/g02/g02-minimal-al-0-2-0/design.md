# harness-dsl: archive and briefing (child of g01-minimal-imal-0-2)

The operator for this child is **rename**. The weakest noun in the parent was **library**. It named two different things:

- **Where memory items of one kind are kept.** Items are written there, curated there, and live in a store.
- **What one model call is told.** This is a ranked selection over several such places.

The parent said "reads union across libraries, writes go to one library". That asymmetry (seed weakness 12) was a symptom of the conflation. The adversary's legal-review scenario shows the cost: two agents sharing one library cannot rank differently. Principle 14 says recall is a policy, but the parent had no place to put that policy.

The rename splits the noun in two:

- **archive** = memory kind × store. This is where items live, are written and are curated.
- **briefing** = archives × recall policy. This is what a call is told.

An agent `recalls(briefing)` and `records(archive)`. Reading many and writing one is now visible in the types, not stated in prose. Every place that touched `library` is adjusted:

- `ctx.remember`
- `act.remember`
- the `MemoryItem.archive` field
- `ControlApi.memory`
- `MemoryStore.search` and `MemoryStore.list`

The same pass gives two other weak names real nouns:

- `Until` (a preposition) becomes **`Wait`**. `ctx.wait(state, wake)` names the position the unit takes.
- The parent's `.recovery(...)` and `Executable.recover` were two words for one concept. They become one concept, **recovery**:
  - `Executable.recovery` is a declared value.
  - `Command.recovers(how)` is its setting verb.
  - `Model.recover` is the driver's answer when the recovery is `'ask-driver'`.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A named, shareable position in a lifecycle. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(state?)` | A data shape, a set of states, and an optional failure move. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decisionSchema)` | A named outside decision with a typed answer. |
| Kind | **tag** | `H.tag(n)` | A named dimension for metrics, such as category or model. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each with its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?).suppliers().store().wip().maxUsdPerUnit().retry()` | A work queue: kind × suppliers × store × handler. |
| Pivot | **archive** | `H.archive(n, memory, store)` | Where items of one memory kind live: memory kind × store. |
| Pivot | **briefing** | `H.briefing(n, archives, ranking?)` | What a call is told: archives × recall policy. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(body).phase(state, body)` | Handler bodies, one per lifecycle phase. |
| Composite | **command** | `H.command(n).input().output().argv().on(...runners).recovers(how)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, recall, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

The following are plain values, not entities:

- `H.clock` and `H.operator`: kernel suppliers with no backend.
- `H.env`.
- `TimeSpec`, `Scope`, `Bound` and `SupplyOf<K>`.

Halts and tags are kinds in the sense of principle 8: pure vocabulary with no backend, shared by reference.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of one flow phase for one unit.
  - Its states are `running`, `blocked` and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable. A retry is a new invocation, and each batch item is its own invocation.
- **Phase**: the flow body selected by the unit's state when the attempt starts. A phase is not a step. "Step" is not a word in this design.

## Rules

### 1. Skeleton (principle 12)

**Positions and verdicts.**

- A unit has one of four positions: `pending`, `active`, `waiting` or `terminal`.
- A terminal state declares its verdict: `success`, `failure` or `neutral`. There is no default.
- Blocked is an attempt state, never a unit state.

**How a flow phase ends:**

| The phase returns | Attempt outcome | What happens to the unit |
|---|---|---|
| A state | `succeeded` | Moves to that state. |
| `ctx.wait(state, { at \| children, then })` | `succeeded` | Parks in a waiting state, with a wake that moves it to `then`. |
| `ctx.fail(reason)`, or it throws | `failed` | Stays pending under the lane's retry policy. |
| Interrupted by a move, a preemption or a cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

**Failure default.**

- With no `.retry()` on the lane, the kernel retries with exponential backoff: 1 minute, doubling, capped at 1 hour, unbounded. The unit stays at its pending state.
- With `lane.retry(policy)`, the policy returns `retryInMs` or `'stop'`.
- `'stop'` moves the unit to the kind's `failsTo` state. Only then does an attempt failure move a unit.
- `start()` refuses a lane that has a retry policy when its kind declares no `failsTo`.
- `unit.failures` is no longer visible to flows. It exists only in `RetryView`, so no flow branches on failure history.

### 2. Phases replace hand-written re-entry (critique c)

- `.does(body)` handles any state that has no phase of its own.
- `.phase(state, body)` handles a unit picked up in `state`.
- The kernel chooses the body, so the author never writes `if (ctx.unit.state === 'smoked')`.
- An Epic is written as `.does(plan)` and `.phase('integrating', integrate)`. A Release is written as `.does(fullRelease)` and `.phase('smoked', conclude)`.
- Each phase is its own attempt. Each has its own fingerprint, recorded on the attempt entry as `phase`.

This is lifecycle declared by the kind's states, not resumption: no step in a phase is ever re-run to discover where the flow was.

### 3. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions. Neutral states are excluded.
- Neutral states are countable by state entity: `rate({ among: { kind, position: 'terminal' }, count: { state: inconclusive } })`.
- Every rate has `hits` and `samples`. `value` is `null` when `samples` is 0.

### 4. Named halts and tags (critique a)

**Halts.**

- `ctx.halt(approveReply, show)` returns the halt's typed decision.
- `approveReply.resolved({ approved: true })` is the `EntryFilter` for metrics. Its keys are checked against the decision schema.
- A misspelt halt is a compile error, not `samples: 0`.

**Tags.**

- `ctx.tag(category, value)` sets a tag.
- `category.is('billing')` is a filter.
- `rateBy({ ..., by: category })` groups by the tag.

**Entity references in filters.**

- `EntryFilter` takes entity references (`kind`, `lane`, `state`, `executable`, `model`, `trigger`, `halt`), never names.
- References inside policy closures resolve at decision time, so a policy may name a trigger declared later in the file.

**Model choice.**

- `ModelChoice` no longer carries `agent` or `role`. A model policy cannot branch on agent names (principle 10).
- Two agents with two strategies are two policies, which may share a function.

**Halt latency.**

- Halt `resolved` entries carry `durationMs` (raised to resolved), so `mean({ of: 'durationMs', among: halt.resolved() })` measures it.

### 5. Recall (principle 14; the adversary's new scenario)

The kernel builds the candidates:

- It queries each archive in the briefing through `MemoryStore.search`.
- It drops candidate-status items.
- It decorates each item with `sort`, `ageDays`, `specificity`, `similarity` (if the store reports it) and `trackRecord`, a `Rate` over the succeeded attempts in which the item was present.

The briefing's ranking then decides:

- The `ranking` (an `H.policy.recall`) receives these items with `metrics` and returns the ordered items to feed the call.
- With no ranking, the kernel default orders by similarity, then specificity, then track record.
- Exclusion, decay and caps are written by the owner in the ranking.
- Two agents over one archive with different rankings are two briefings.

Every recall is recorded:

- Each recall is a `decision` entry.
- The entry lists `excluded` items with their `trackRecord`, including samples.

Writes:

- Writes go to one archive: `records(archive)`, `ctx.remember(archive, …)` or `act.remember(archive, …)`.

### 6. Supply and keys

- A `create` whose key belongs to a non-terminal unit is ignored.
- `update`, `act.move(lane, key, state)` and `work.update` address the open unit with that key.
- Together these give per-group deduplication.
- The ledger keeps every unit's snapshot, so a storeless kind still has data, state and telemetry.

### 7. Triggers

**Unit sources:**

- `on.enters(kind, states)`.
- `on.streak(kind, state, n, group)`.
- `on.deadline(kind, due, whileIn)`. `due` is re-evaluated on every data update, so a moved deadline re-arms and the old one never fires.

**Metric sources (critique b):**

- `on.metric(read, bounds)` reads one `Rate`. It is a single latch with no group, and its events have `group: undefined`.
- `on.metric(read, { ...bounds, group: tag })` reads a record keyed by group, with one latch per group. Its events have `group: string`.
- The firing entry is tagged with that tag. "Audits opened per category" is therefore `rateBy({ among: { entry: 'firing', trigger, status: 'tripped' }, count: same, by: category })`. This is the same tag that grouped the approval rates.
- A lane-level threshold is an ungrouped metric. No lane name pretends to be a group.
- Each latch fires `tripped` once when it crosses `trip` with at least `minSamples`, and `reset` once when it crosses `reset`.

**Effects and records:**

- Effects are `create`, `move`, `remember`, `pause` and `resume`.
- Every firing is a `firing` entry carrying the metric reads that caused it.
- Pause and resume are `lane` entries. A resume entry carries the paused `durationMs`.

### 8. Scheduler and placement

- One scheduler policy returns `start` and `preempt`. The kernel starts units in that order while WIP, runner slots, account eligibility and lane pause allow.
- Preempted attempts are cancelled, and their units return to their prior pending state.
- Blocked attempts release runner slots but count toward lane WIP.
- Waiting units count toward nothing.

**Placement.**

- `Command.on(...runners)` means any one of these runners. The kernel picks a runner with a free slot whose `preflight()` passes, and records it as `runner` on the invocation.
- Placement is declared on the executable and never encoded in kind data (the critique of scenario 4).
- `ActiveView.runners` lets a scheduler preempt the attempts that actually hold the contested runner.

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts. An invocation that would pass it raises the kernel halt `cost-ceiling`.
- Daily budgets are scheduler reads of `metrics.sum`.

### 10. Accounts and quota (principle 15)

- Quota is ledger state, kept as an append-only partition of usage and cooldown events per account and harness, and folded at read time.
- `sqlite.ledger(path, { sharedQuota })` places that partition in a shared file. No harness locks another harness's account rows, and the ledger's single-writer lease covers runs only.
- Shares belong to pools, and therefore to one harness.

### 11. Durability (scenario 10)

**Replay.**

- Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember` and `spawn` is a sequenced ledger entry.
- On restart the current phase body is re-executed against recorded results. Completed invocations are returned without running again and cost nothing.

**The invocation that was running at the crash** follows its executable's `recovery`:

| Recovery | Behaviour |
|---|---|
| `'rerun'` | Run it again. |
| `'park'` | Raise the kernel halt `interrupted`. This is the default for commands. |
| A check executable | `true` continues, `false` reruns. |
| `'ask-driver'` (always, for agents) | Ask `Model.recover`. `'unknown'` parks. |

**State that moved while the harness was down.**

- A batch records its handle before waiting, and is collected rather than resubmitted on restart.
- Halt resolutions made during downtime are `operation: requested` entries, applied on start.
- Children are re-read from the ledger, and the `wait(children)` wake is re-evaluated.

**The attempt record.**

- A resumed attempt keeps its id.
- The crash is an `attempt: interrupted` entry.
- Interrupted invocations are excluded from model and agent rates.

**Changed definitions.**

- If the phase fingerprint changed, the kernel raises the halt `definition-changed`. The supervisor resolves it with `restart` or `abandon`.

**Single writer.**

- A single-writer lease is held on `harness:<name>`.
- A second process refuses to start while the lease is live, and takes over after it expires.

### 12. Control API and observers

- Clients are granted operations. `claude-code.supervisor` and `http.control` are two clients.
- An observer may declare `on: EntryFilter`, built from entity references. For example, Slack is filtered with `{ entry: 'transition', kind: Incident }` rather than by string comparison.

### 13. Startup validation

`start()` fails in each of these cases:

- duplicate registered descriptor names (including halts, tags, archives and briefings);
- a lane/flow state mismatch;
- a phase on a state the kind lacks, or on a terminal state;
- an unknown state in a trigger;
- an unregistered lane in a trigger;
- a retry policy without `failsTo`;
- an agent no pool can serve;
- a command without argv or runner;
- a batch call on a model without `submit` and `collect`.

A harness with no pools, agents or models is valid.

## What changed and why

**Rename (the operator).**

- `library` is split into **archive** and **briefing**, for the reasons given at the top.
- `H.library` is gone. `H.archive` and `H.briefing` replace it, and `H.policy.recall` is restored.
- `Agent.recalls` now takes one briefing.
- `Library` becomes `Archive` in every memory API.
- `Until` becomes `Wait`, and `ctx.until` becomes `ctx.wait`.
- `Command.recovery` becomes `Command.recovers`. `Executable.recover(...)` becomes the declared `Executable.recovery` (critique c, principle 22).

**Critique a (raw strings stand in for entities).** Repaired with:

- `H.halt` and `H.tag`.
- Entity-reference filters.
- `Halt.resolved(match)` typed by the decision schema.
- `ModelChoice` without agent names.

**Critique b (lane-level thresholds faked as groups).** Repaired with:

- An ungrouped `on.metric` overload.
- Grouped metrics keyed by a `Tag`.
- `conversationsLane` and `auditTrigger` strings are no longer needed: filters take the lane and trigger entities.

**Critique c (multi-attempt re-entry is resumption by another name).** Repaired with:

- `Flow.phase(state, body)`, which removes author-written phase dispatch.
- `lane.retry` plus `kind.failsTo`, which replace `if (ctx.unit.failures >= 3)`.
- `UnitView.failures` is removed from flows.

The inconsistent support lifecycles are fixed in the scenarios: `sent` is `terminal/success` and `escalated` is `terminal/failure` in both scenario 2 and scenario 9.

**Scenario 4 critique.**

- `Command.on(...runners)` removes the host-in-kind-data workaround and its six renamed descriptors.
- `ActiveView.runners` makes preemption target the runner actually contested.
- `slack.notify({ on })` removes the string filter.
- The Incident flow will loop on its own halt rather than returning to pending.

**Adversary's new scenario.**

- Owner-authored recall per briefing, with exclusions recorded with their samples.
- Halt latency through `HaltEntry.durationMs`.

**Added:**

- `Lane.retry`
- `KindDescriptor.failsTo`
- `Runner.preflight`
- `Recalled.sort` and `Recalled.ageDays`
- `RecallView.metrics`
- `DecisionEntry.excluded`
- `AttemptEntry.phase`
- `InvocationEntry.runner`
- `Observer.on`
- `EntryFilter.model`

`Ledger.recordCooldown` now takes the harness, so the shared partition stays append-only per harness.

**Removed:**

- `HaltRequest`
- `ModelChoice.agent` and `ModelChoice.role`
- `UnitView.failures`
- string-typed filter fields
- the observer's `null` message return

## Principles broken

None.

- Principle 12 holds with the amended failure default, now expressed by `lane.retry` and `kind.failsTo`.
- Principle 14 now holds literally: recall is an owner-authorable deterministic policy.
- Principle 15 holds: shared quota is an append-only ledger partition placed by the ledger backend, not a second store.
