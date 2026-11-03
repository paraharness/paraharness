# harness-dsl — minimal seed

The smallest surface I could defend against the eight-scenario battery. I started from zero nouns and only added one back when a scenario could not be written without it.

## Entities

**Kinds** (pure vocabulary, no backend)
- `H.kind(name, { data, states, initial, tags })` is a work kind. `states` is a plain map from state name to skeleton outcome. `kind.extend(name, patch)` derives a kind (for example Feature from Bug) and must rename it.
- `H.memory(name, { stance })` is a memory kind. `stance` is `experience` or `taste`.
- `H.role(name, { instructions, intents })` is a role. Intents (`read`, `write`, `execute`, `browse`, `halt`, `record`) are kernel vocabulary. Drivers map them to their own tools, which closes known weakness 3.

**Instances** (carry a backend, come only from subpaths)
- Accounts, models, runners, stores, memory stores, suppliers, workspaces, guards, clients, and projections or messages.

**Pivots** (each one is named for what it produces)
- **lane**: kind × suppliers × store × flow × cast. It produces a *queue of handled units*. Each kind has one lane per harness, and the lane is named after its kind.
- **journal**: memory kind × memory store × recall × who recalls and records. It produces *recallable memory*.
- **harness**: ledger × lanes × journals × triggers × scheduler × clients. It produces *a running harness*.

**Behaviour**
- **flow**: a typed chain of steps. It declares the kinds it accepts, not an input schema.
- **trigger**: source → effects.
- **policy**: a deterministic decision. It has three shapes: `pick`, `order` and `recall`.
- **metric**: an owner-defined rate over ledger events.
- **operation**: a control-API verb.

**Execution vocabulary (three words, down from four)**
- *Attempt*: one execution of a lane's flow against one unit. It can span process restarts and halts.
- *Step*: a named position in a flow.
- *Invocation*: one call of an executable at a step. Retries are extra invocations of the same step.
- "Run" is cut. A process lifetime is not a domain concept. The ledger resumes from its own events, so restarts need no name.

## Answers to the brief

**Is `state` an entity?** No. The lifecycle is a plain map on the kind: `states: { triage: 'pending', building: 'active', merged: 'succeeded' }`.
- Sharing a lifecycle is done with `kind.extend`, not with shared state objects. A standalone object literal would widen its values to `string` without `as const`, and `as const` is forbidden.
- Triggers attach to `(kind, stateName)` through `H.when.enters(Bug, 'down')`. The state name is type-checked against the kind.
- Flows no longer name states at all, which closes known weakness 1:
  - A flow emits **marks** (`.mark('drafting')`, `.end('parked')`).
  - Each lane maps marks to its kind's states with `lane.states({...})`. That mapping must also cover `failed` and `cancelled`.
  - The compiler forces every mark to be mapped.
  - This is how one flow serves Bug and Feature (scenario 1). It also makes attempt failure distinct from unit failure: a failed attempt of an Experiment can map back to `resting`.

**Is role separate from agent?** Agent is cut. This is the less obvious option.
- A role is vocabulary. A step asks a role through a **seat** (`H.ask(reviewer, { seat: 'reviewerA' })`, which defaults to the role name).
- The lane's **cast** (`lane.cast({ builder: choice })`) assigns a model or a model-choice policy to every seat. The flow's seat names are tracked in its type, so a missing seat is a compile error.
- "Cast" is a noun, the cast of a production, so principle 9 holds.

**Are pool, scheduler, recall and model choice one policy?** Yes. There is one entity, `policy`, with three signatures.
- **`H.policy.pick(name, candidates, decide)`** is the **pool**. A pool is a pick over accounts, so the pool entity is cut.
  - The context gives each candidate's eligibility and `QuotaView`: window, cooldown, renewal, share cap and share used.
  - The same builder chooses models (scenarios 1, 3, 6) and SSH hosts (scenario 4).
- **`H.policy.order`** is the scheduler. It returns `{ order, preempt? }`.
  - It sees pending units with `waitingSeconds` and `deadline`, active attempts with `blocked`, metrics, and spend.
  - The kernel starts units in the returned order, subject to WIP limits, runner slots and account eligibility.
- **`H.policy.recall`** is recall.
- Every decision is appended to the ledger as a `policy` event.
- The flow-local gate `halt({ unless })` is the one place a plain deterministic function sits in a decision slot. Its result is recorded as a policy event named after its step.

**Is journal distinct from lane?** Kept distinct. Merging was tempting, because curation in scenario 6 (candidate → accepted → merged/dropped) looks like a lifecycle. It would cost honesty:
- A memory item would have a skeleton outcome. An accepted taste item would be "succeeded", which is a lie.
- A candidate would be "pending", which tells the scheduler it is waiting for an attempt.
- Recall is not handling, and recall policies would have to pretend to be flows.

Instead, an item's envelope carries a curation `status` (`candidate | active | retired`), and curation is the operation `H.op.curateMemory`.

Known weakness 12 is stated in the DSL: `recalledBy` reads the union of every journal whose kind is in scope, while each recording names exactly one journal (`then.record(journal, …)`, `recordedBy`).

**Is trigger distinct from a flow step that creates work?** Both exist, for different jobs:
- **`spawn`** is in-flow and parent/child. The attempt *yields* at the spawn, and a new attempt resumes after the spawn step once every child is terminal. An Epic has several attempts and holds no slot while its Features run.
- **Triggers** are cross-kind and blind. The heartbeat flow never names Bug.

Sources are `enters`, `repeats` (consecutive pattern), `overdue` (time), `updated` (external change) and `transition` (every transition). Any source can be narrowed with `.where(predicate)`.

Effects are `create`, `cancel(to)`, `record` and `run`. Every source fires from a ledger event:
- The kernel appends `clock.due` before an `overdue` trigger fires.
- Suppliers append `unit.updated`.
- Every firing appends `trigger.fired`.

**Is supervisor an entity?** No. A supervisor is a client adapter with a grant list (`claudeCode.supervisor({ grants })`). The plain-HTTP client of scenario 4 is the same shape (`http.control({ grants })`). Grants are operations: the ten in `H.op` plus `H.operation(name, { input, run })`.

**Do flows need `.input()`?** No. `H.flow(name, { kinds: [Bug, Feature], args })` gets its data type from the kinds it accepts. `lane.handle(flow, args)` is checked by a contravariant `accepts` member, and `args` carries per-lane parameters such as the Bug and Feature round counts.

## Entities considered and cut

| Entity | Fate | Why |
|---|---|---|
| state | cut | A plain map on the kind. Flow marks are mapped by the lane. |
| agent | cut | Replaced by seat + cast on the lane. |
| pool | cut | A `pick` policy over accounts. Share caps are harness settings (`share`). |
| scheduler (entity) | cut | An `order` policy. |
| observer / projection | cut | A projection is an executable run by a trigger on `H.when.transition()`. |
| supervisor | cut | A client adapter. |
| run | cut | See execution vocabulary. |
| skill, resource | cut | Strings in a memory scope and in `ask({ resources })`. |
| deadline / SLA entity | cut | `lane.deadline(fn)` feeds the scheduler. `H.when.overdue` fires the trigger. |
| retry policy entity | cut | `StepOptions.retry` is declared data on the step. |
| work store | not added | Principle 15. A lane may have no store. |
| quota store | not added | It is a part of the ledger interface (`Ledger.quota`) that a backend may place elsewhere. |

## Rules

1. **Skeleton (replaced, see Principles broken).** The six outcomes are pending, active, succeeded, failed, cancelled and **concluded**. Concluded means terminal and neither success nor failure.
   - Success rate is `succeeded / (succeeded + failed)`, reported with its sample count.
   - `metrics.outcomes(kind)` breaks counts down by named state and by outcome.
2. **Units at rest.** A unit whose state maps to `pending` and that carries `notBefore` (from `end(..., { resumeAt })`) or awaits an update (`resumeOnUpdate`) is not schedulable and holds no capacity.
3. **Halts.** A halt is an attempt state (`blocked`) recorded as `halt.opened`.
   - A blocked attempt releases its runner slot but still counts toward lane WIP.
   - It is rebuilt from the ledger after a restart.
   - It resumes at the same step on `halt.resolved`.
4. **Cost ceilings and cancellation.**
   - `lane.maxUsd(usd)` caps the unit's total spend across attempts.
   - `cancel(to)` aborts any active attempt and moves the unit to `to`. If `to` is terminal the unit ends there. If `to` is non-terminal, the unit is requeued at once, whatever outcome that state maps to, and its next attempt starts from the beginning of the flow.
   - `Plan.preempt` cancels the listed attempts and requeues their units.
5. **Suppliers.** A supplier emits `Supply`, which takes one of two forms:
   - A `NewUnit` carries full data and has mode `create` or `upsert`.
   - A `UnitPatch` has mode `update` and carries a partial `patch` merged into the existing unit's data. This is how a vendor reply updates a Negotiation.
   - Both forms may set `reopen`, which is how the weekly schedule reopens recurring Topics.
   - `spawn` and `then.create` accept only `NewUnit`.
6. **Recall.** Recall is deterministic over (items, scope, store contents). A vector store is a backend exposing `nearest`, and its embedding is fixed per store. A command listed in `recordedBy` records memory by printing drafts on its structured output.
7. **Batch.** `H.batch` invokes `Model.batch`. Usage is recorded with `batch: true` and priced at the model's `batchFactor`.
8. **Shared accounts.** The SQLite ledger takes `quotaPath`. Harnesses that point at one quota file share windows and cooldowns, while each keeps its own events, units and shares. Eligibility is read at pick time.
9. **Conditional ends.** `end(fn)` ends the attempt with the returned mark. If `fn` returns `undefined`, the flow continues with the next step.
10. **Step failure.** A step that still fails after its declared retries fails the attempt. A human gate on a bad result is an explicit `halt` with `unless`.
11. **Startup validation.** `start()` refuses:
    - two descriptors with one name;
    - unmapped marks or seats;
    - a trigger or spawn whose target lane is not registered;
    - a journal written by a role that is not in `recordedBy`;
    - a metric that is not registered;
    - a model whose account is ineligible for every share.
    - Descriptors built inside a step function are invocation values and are exempt from name checks.
12. **Zero-model harness.** Nothing in the kernel references `Model` or `Account` unless a cast does.

## What changed and why (versus the brief)

**Choices taken where the brief left an option open**
- Agent cut in favour of seats and a lane-level cast.
- Flows emit marks, not states; the lane maps them.
- Observers cut; projections are trigger-run executables.
- `run` cut from the vocabulary.
- A sixth outcome, `concluded`.

**Declined**
- Merging journal into lane.
- A second kernel store for quota.

### Revision 2 (writing the battery)

- **`Supply` split into `NewUnit | UnitPatch`.** Scenario 8's vendor webhook knows only the reply, not the whole Negotiation. An update that demanded full data could not be written honestly. `spawn` and `then.create` now accept only `NewUnit`.
- **`Source.where(predicate)` added.** Scenario 4 records a note only when a successful Backup took over two hours. Scenario 6 skips returned drafts with empty notes. Scenario 2 fires only when the customer's message actually changed. The predicate is deterministic over the recorded event, and only passing firings append `trigger.fired`.
- **`StepOptions.onFail` removed.** No scenario needed it. Scenario 5's validation gate is an explicit `halt` with `unless`, which gives the human a typed decision instead of an untyped "halt on failure". This follows principle 21.
- **`lancedb.memory` embedding is now described in the adapter**, as provider and model. No adapter offered an embedding `Model`, and passing a chat model would have been a lie.
- **Rules stated explicitly:**
  - conditional `end` returning `undefined` continues the flow (rule 9);
  - non-terminal `cancel(to)` requeues the unit (rule 4), which scenario 2's "return to classifying" needs;
  - a failed step fails the attempt (rule 10).

## Principles broken

- **12 (Lifecycle skeleton).** Two departures:
  - The five outcomes become six. `concluded` is added because scenarios 3, 5, 6 and 8 have terminal outcomes that are neither success nor failure. Success rate is `succeeded / (succeeded + failed)` with samples; concluded and cancelled are reported beside it.
  - Named states are entries in the kind's lifecycle map, shared by `extend`, not entities.
