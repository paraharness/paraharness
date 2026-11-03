# harness-dsl: one dimension noun (child of g01-durable-0-2-0-1--2-0-1-2)

This child keeps the parent's Kanban-lens execution model unchanged in its essentials:
- lanes as swimlanes;
- named states outside the flow, and in-flight columns that are the flow's steps;
- pull scheduling with classes of service;
- one ledger with replay;
- per-step crash rules and collected jobs.

The operator asked for a merge of two entities that rhyme. The merge is **Facet into Resource**: a facet is now a *resource family*. The child also repairs the adversary's three sharpest critiques and the founding-scenario defect (the builder could not see the auditor's deficits).

## The merge: facet becomes a resource family

### Why they rhyme

Both entities are named identities that the kernel stores as a dimension, so that unrelated parts of a harness meet on one value.

| Entity | Referenced by |
|---|---|
| Resource (a section, a database, a host) | leases, memory scope, metric dimensions |
| Facet value (a category) | metric dimensions, halt policies, crossings |

The battery shows the rhyme hurting. Scenarios 6 and 9 declared *both* for one concept: a category facet for metrics and a category resource for memory scope. They bridged the two with `resourcesFor(name: string)` and `sectionsOf(section: string)`, which are string lookups that principle 8 forbids. Principle 8 already says resources are what "metric facets reference by identity".

### What the merged entity is

- `H.resource(name)` declares a single resource, as before. It has no family, and its `value` is its name.
- `H.resources(family, values)` declares a **resource family**: a closed, typed set of member resources.
  - `family.of(value)` returns the member `Resource<V>`. `V` is the literal union of the declared values.
  - `family.parse(text)` returns `Resource<V> | undefined`, for values that arrive untyped from outside (a CMS section string).
  - `family.members` lists every member.
- **One column.** The metric dimension is a single typed column, `resources: ResourceRef[]`. The parent's `facets` and `resource` columns are one column now. Sample dimensions, metric queries, halt-address `resources`, `DecisionEvent.resources`, `HaltPolicyCtx.resources`, memory `Scope.resources`, `AgentTask.resources` and leases all carry the same objects.
- **Crossings per family.** `H.when.crossing(metric, { ...band, per: family }, edge)` is an overload. It yields `FamilyCrossingEvent<V>`, whose `resource: Resource<V>` is required and typed. The scenario-9 guard `event.value === undefined` on every consequence disappears.
- **Patterns per resource.** `H.when.pattern(lane, { per })` returns a `Resource<V>`. `PatternEvent.resource` replaces the free-string `group`.

So "the category billing" is one object. A halt address tags with it, a metric reads by it, a memory item is scoped to it, and a crossing reports it.

### What honesty it costs (reported as the operator asks)

1. **Facet values must be enumerable at definition time.**
   - The parent's `facet.of(anyString)` admitted open-ended values (per customer, per ticket).
   - A family is closed. An open dimension can only be expressed by `parse` returning `undefined`, which drops the sample, or by a catch-all member.
   - No battery scenario needs an open facet; the categories, sections, services and databases are all enumerable. This is still a real loss of expressiveness.
2. **A category is now a "resource", and resources can be leased.**
   - `lease(() => ({ resource: category.of('billing'), mode: 'exclusive' }))` compiles. It has a meaning (one billing attempt at a time) that nobody asked for.
   - The word "resource" now covers a shared thing you contend for *and* a label you group by.
   - The kernel does not forbid leasing a family member. That is the price of one noun.
3. **Principle 18 lists `resource` as a column and facets as declared entities.** Merged, a facet is a declared entity (the family) whose values live in the resource column.
   - The rule "a facet that repeats a column is a startup error" becomes: a family named `kind`, `lane`, `state`, `model`, `seat`, `resource` or `halt` is a startup error.
   - A family whose member collides by name with a singleton resource is also refused.
   - I read this as satisfying principle 18, not breaking it. A reader holding the old text will see one fewer noun than it lists.
4. **Recall by resource is now also recall by category.** An item scoped `resources: [category.of('refund')]` is recalled only by attempts whose task or halt carries that member.
   - This is what scenario 9 wants.
   - An author who tags a halt with a family member for metrics also widens that attempt's memory scope. The coupling is intended, but it is a coupling.

## Repairs to the adversary's critiques

### Critique 1: strings standing in for entities

- **States are compared by identity.**
  - `UnitView<A, S>.state` is the `State` entity, typed as the kind's state union, so `event.unit.state === AwaitingCustomer` compares objects.
  - `TransitionEvent.to` is also a `State`.
  - `ChildResult.state` is a `State`.
  - `OutcomeCounts.count(state)` replaces `byState.Inconclusive`.
- **Scans filter by state.** `sqlite.scan` takes the kind and a typed `states` filter, and yields `ScannedUnit<A>` with typed attributes. The `stored.state === 'Customer'` comparison and the `Topic.parse` re-parse disappear.
- **Seats are compared by identity.** `Assignment.seat` is compared by identity (`a.seat === drafter`), never by name.
- **Resources and facet values are typed.** `sectionsOf` and `resourcesFor` are replaced by `family.parse` and `family.of`. `PatternEvent.group` and `CrossingEvent.value` are replaced by typed `resource` fields (see the merge).
- **Unit views carry entities.** `UnitView.kind`, `UnitView.lane` and `AttemptView.halt` are entities, not names.
- **Removed fields.** `UnitView.attempts` and `UnitView.failedAttempts` are deleted. They were the "attempt arithmetic" escape hatch the adversary named, and no requirement needs them in a flow or a policy. Retry counts live in the lane's policy and in `Metrics.attempts`.

### Critique 2: timer re-arm as a hidden coupling

- **The deadline is a derived value.** A timer's deadline is the value of `at(unit)`.
  - The kernel re-evaluates `at` after every recorded change to the unit: attribute update, transition or position change.
  - It re-arms only when the computed instant differs from the armed one (`timerCleared: deadlineChanged`).
  - It disarms when `at` returns `undefined` (`deadlineRemoved`) or when the unit becomes terminal.
- **Unrelated updates do nothing.** An `update` that does not change the deadline's inputs leaves the timer untouched. Scenario 11's redline no longer re-arms anything. Scenario 2's `customerReplied` does not move the SLA.
- **The dependency is declared.** It is exactly what `at` reads. Scenario 9's SLA extension (a supervisor `workUpdate` of `slaDeadline`) moves the timer because the deadline function's output changed, not by accident. The old deadline is cleared before the new one is set, and it never fires.

### Critique 3: the seat is overloaded, batch leaks onto it, A/B collapses, rival thunks

- **The seat carries four concerns, not eight.** It now carries role, model or model policy, pool, and raisable halts. That is principle 8's "role × models × choice policy" plus the accounts the call runs on.
  - **Output schema moves to the role.** It is the shape of what the role produces, which is vocabulary, not a relationship. Scenario 6's two reviewer seats share one role and therefore one output shape, which is what "two agents of the same role" means.
  - **Workspace and guard move to step options** (`StepOptions.workspace`, `StepOptions.guard`). Where a call runs, and what it must pass before it may stop, are properties of that step in that flow. Startup refuses a guard on a step whose executable's driver cannot `enforce` it.
- **Batch is a typed property of the model.**
  - `Model.batch` is part of the instance. The `anthropic` adapter returns `BatchModel`; the `claude-code` adapter returns `Model`.
  - `Seat<O, M>` carries its model type, and a model policy carries its candidates' type.
  - `H.batch(name, seat)` accepts only `Seat<O, BatchModel>`. Pairing a non-batch model with a batch step is a compile error, no longer only startup rule 10.
  - The job name is explicit, because principle 11 requires derived descriptors to be renamed.
  - The remaining pool/model mismatch (a model whose driver serves no account in the seat's pool) is still a startup rule. Typing account families would add a type parameter to every account, pool and model for one check.
- **A/B collapse and the rival thunk.** `PolicyCtx` now carries:
  - `current`: the model this seat last held, from the ledger;
  - `rivals`: the latest assignment of every other seat that shares this seat's role in the same flow, derived by the kernel.

  A comparison policy reads its rival from `ctx.rivals` with no forward-reference thunk. It can refuse a candidate a rival already holds, so two seats never end on one model. It measures `ctx.current`, not a hard-coded incumbent, so after a swap the series it reads is the new model's, keyed on the seat.

### Smaller wounds named in the critique

- **"Heartbeats first" has one encoding.** It is `standard(heartbeats, bugs, features, epics)`. `expedite` is reserved for preemption with `holds` (scenario 4); scenarios 1 and 7 both use `standard`.
- **Share fractions** are written so the scenario's per-account shares are visible and explained by name.
- **Bugs filed by a trigger into a tracker-backed lane** are typed through `create(lane, attrs)` with the lane's attribute type, and stored through that lane's store map.
- **Economy.** The parent's `admit` lambdas that re-implemented rules nobody asked for (s09's pause gate, s12's GPU gate) are removed.
  - `admit` stays for scenario 3's budget.
  - It also stays for scenario 8's "a policy elsewhere asks how often experiments are inconclusive". The scheduler is the policy that asks there.
- **GPU hours per day.**
  - `Metrics.jobs({ job, window })` computes in-flight hours as the overlap of each job's `jobSubmitted` to `jobCollected` interval with the window. Jobs still running are counted up to now.
  - It returns `hours`, `running` and `samples`.
  - A job spanning midnight is split across the two days. This replaces the step-end `durationMs` amounts.

## Founding scenario: the builder sees the deficits

**Loop carry.** `flow.loop(name, carrySchema, body, { max, until, carry })` declares a typed value carried from one round to the next.
- Inside the body, `ctx.steps[loopName]` is the value carried into the current round: `undefined` in round one, then `carry(ctx)` computed at the end of the previous round.
- The kernel records it as `loopCarried`, so replay and resumption see it.
- `carry`'s context includes the previous carry, so it may accumulate: every prior deficit, or every prior counsel note.

Scenario 1's builder task reads `ctx.steps.rounds?.deficits`. Nothing comes from a driver session or from memory, and no flow reads the ledger.

## Re-entry without losing the attempt

**`restart` becomes `rewind`.** `Lane.on(signal, { rewind: step, at })` moves the *open attempt's* cursor back to `step`.
- It does not cancel, and the attempt keeps its id.
- Superseded step outputs remain recorded. Rewinding into a loop starts that loop's next iteration with its carry intact.
- It is recorded as `attemptRewound`.

`enter: state` still cancels and moves the unit (scenario 2's customer reply returns the unit to `New`).

This fixes the hole the adversary found in scenario 11 and in its grant scenario. A redline at counsel no longer resets per-attempt loop counts, because there is no new attempt.

### Reaction semantics (ruled while writing scenario 11)

1. **`at` gates movement, not data.**
   - A reaction's `at` gates its `rewind` and `enter` only.
   - Its `update` applies whenever the signal is delivered to the unit: at any step, while blocked, or with no open attempt.
   - A signal is therefore never dropped because it arrived at the wrong moment. `signalDelivered.applied` and `gatedAtStep` record what happened.
2. **A rewind aimed at a running step is deferred.**
   - The step is not interrupted. Its output is recorded, and then the cursor moves back.
   - Inside a loop this is the next round, with the carry intact.
   - This is how scenario 11's "a redline arriving while `draft` runs is not lost and is applied in the next round" holds. The same reaction, delivered while the unit waits on counsel, rewinds at once.
   - `attemptRewound` is appended when the cursor actually moves.
3. **Several reactions per signal are allowed** when their `at` lists are disjoint. Overlapping `at` lists for one signal on one lane are a startup error (rule 21 below).

## Bounded decisions, declared

`flow.halt(step, halt, { bound: { counts, maxCount, exit } })` is the declared bound the kernel enforces on re-entry.
- **Counting.** The kernel counts this unit's recorded decisions at this address for which `counts(decision)` is true, across every attempt and rewind of the unit.
- **Exit.** The decision that brings the count to `maxCount` ends the attempt at the named exit. The exit is added to the flow's exit type, so the lane must map it. The kernel records `haltBoundReached`.
- **Scenario 11.** "After the second return, Declined" is `bound: { counts: d => d.verdict === 'return', maxCount: 2, exit: 'declined' }`.
- **No arithmetic in the flow.** The flow contains no count and reads nothing from the ledger.

## Entities

**Kinds** (vocabulary, no backend):
- work kind
- state
- signal
- role (with output shape)
- memory kind
- halt
- resource and resource family
- command
- job
- flow
- operation

**Instances** (carry a backend, built in subpaths):
- account (with its quota partition)
- quota partition
- model (batch-capable or not)
- embedder
- runner
- workspace
- supplier
- store
- memory store
- ledger
- client
- observer

**Pivots:**

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow (exits, params) × retry × lease × order × ceiling × reactions | managed units |
| Seat | role × model or model policy × pool × raisable halts | a model-call executable |
| Pool | accounts × shares × drain policy × fallback | quota-eligible access |
| Journal | memory kind × store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts on typed columns | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission | pull decisions |
| Harness | the assembly of the above | a running harness identified by name |

## Rules carried from the parent

These are unchanged except where noted.

### Lifecycle

- An attempt has exactly one outcome: succeeded, failed or cancelled.
- A unit sits at one of four positions. `active` and `waiting` are derived from the open attempt's status.
- The kind declares only pending, waiting and terminal states. Each terminal state carries a verdict, with no default.
- Failure goes through the lane's `retry`, which must declare its `exhausted` state.
- Cancellation goes through an `enter` reaction.
- Blocked attempts (on a decision, timer, children, job or recovery) hold no WIP, no slots and no leases.

### Halts

- A halt entity can be addressed by many steps.
- It can be resolved in three ways:
  - by a human, through a client granted `resolve(halt)`;
  - by a registered halt policy, whose reads are recorded with dimensions and sample counts;
  - by a timeout that resolves without cancelling the attempt.
- Clocks on a halt run from the recorded `attemptBlocked`.

### Jobs

- A job is submitted, then collected by poll.
- While it runs it holds nothing. It is never resubmitted on restart.
- `H.batch` is a job over a batch-capable seat, recorded with `viaJob` pricing.

### Quota

- Accounts name a quota partition of append-only events, folded at read time.
- A harness joins each partition under its name.
- Share caps are per harness; utilization and cooldowns are folded across all harnesses.

### Restart

- There is one writer claim with a TTL.
- Completed steps replay at zero cost.
- The running step follows its `afterCrash` setting: `rerun`, `park` (unless `alreadyDone` reports true) or `askDriver`.
- A `flowVersion` mismatch parks the attempt as `definitionChanged`.
- Recorded loop iterations and carries let a backfill resume at its next batch.

## Startup validation

`start()` fails, before any supplier starts, when any of the following holds.

**Names and registration**
1. Two descriptors share one name within a sort. This includes two resources with one name and a family member colliding with a singleton resource.
2. A lane, journal or metric is referenced but not registered.

**Lanes and flows**
3. A lane has no `retry`, or its `exhausted` state is outside the kind.
4. An exit-map state is outside the kind, a flow path reaches no exit, or a halt `bound.exit` is unmapped.
5. A kind has no `initial` state.
6. A lane sits in no class of service, or in two.
7. A signal is routed into a lane that has no reaction to it.
8. A reaction's `at` or `rewind` names a step the flow lacks.

**Seats, drivers and guards**
9. A seat has no role or no pool, or a seat's model (or a candidate of its policy) has a driver that serves no account in its pool.
10. `askDriver` is set on a driver that has no `session`.
11. A step `guard` names a driver capability the executable lacks, or a guard sits on a command step.

**Halts and grants**
12. A grant names a halt that nothing uses.
13. A halt policy is registered for a halt or kind other than its address.
14. A halt's timeout is not later than its escalation.
15. A halt `bound.maxCount` is less than 1.

**Metrics and resources**
16. A crossing is declared over a total metric.
17. A resource family is named after a column.

**Ordering and quota**
18. `Lane.after` is set on a kind without a key.
19. One account name is bound to two quota partitions.
20. A quota partition refuses this harness's name.

**Reactions**
21. Two reactions to one signal on one lane have overlapping `at` lists, or both omit `at`.

## What changed and why

### The merge (operator)

- `H.facet`, `Facet` and `FacetValue` are deleted.
- `H.resources(family, values)` and `ResourceFamily<V>` are added. `Resource<V>` gains a typed `value`.
- `Dimensions.facets` and `Dimensions.resource` become `Dimensions.resources`.
- `HaltOptions.facets` becomes `HaltOptions.resources`.
- `HaltPolicyCtx.facets` and `DecisionEvent.facets` become `resources`.
- `Band.per` takes a family. `CrossingEvent.value?: string` becomes `FamilyCrossingEvent.resource`.
- `PatternEvent.group` becomes `PatternEvent.resource`.
- Ledger `facets` and `StoredFacetValue` become `resources: string[]`.

The cost is listed under "What honesty it costs".

### Critique repairs

- **States and lookups.** `UnitView.state` is typed as a `State` entity. `OutcomeCounts.count(state)` is added. `sqlite.scan` is typed and state-filtered.
- **Unit fields.** `UnitView.attempts` and `UnitView.failedAttempts` are removed.
- **Timers.** Timer deadlines are derived values, re-armed only on change.
- **Seat contents.**
  - Role output moved to `Role.output`.
  - Workspace and guard moved to `StepOptions`.
- **Batch.** `Seat.batch()` becomes `H.batch(name, seat)`, typed against `BatchModel`.
- **Model policies.** `PolicyCtx.current` and `PolicyCtx.rivals` are added.
- **GPU hours.** `Metrics.jobs` and the `jobCollected` event are added.

### Founding-scenario and re-entry repairs

- The loop `carry` overload and the `loopCarried` event are added.
- Reaction `restart` becomes `rewind`, which keeps the attempt; `attemptRewound` is added.
- `HaltOptions.bound` and `haltBoundReached` are added.
- `FlowCtx.metrics` and `FlowCtx.now` are removed. A flow reads only its unit, its params, its steps and its iteration. This makes "the flow reads nothing from the ledger" true by type.

### Scenarios 7 to 12, written against this surface

No type changed. One semantic gap was ruled.

- **Scenario 11's redline-during-draft needs a defined reaction semantics.** A redline that arrives while `draft` runs must not cancel the attempt and must not be lost. The surface allowed `rewind: 'draft', at: ['draft', 'counsel']`, but said nothing about what a rewind to the running step means, or whether `at` also gates `update`.
- **Ruled:** `at` gates movement only, a rewind to the running step is deferred to that step's end, and several reactions per signal are allowed with disjoint `at` lists (new startup rule 21). See "Reaction semantics" above.
- **Why not a new method.** A separate `defer` option, or a second signal per phase, was considered. Each would add a word for what is one reaction with one target. The deferred rewind is the only reading of "rewind to the running step" that neither cancels nor drops.

### Unchanged

- Lanes, classes of service and WIP groups.
- Quota partitions and supervisor sessions.
- The restart mechanism.
- Leases, ordering and store maps.

### Open

- **Pool to model.** The pool-to-model driver match is still a startup rule (known weakness 5).
- **Memory capture.** It still needs an author-written trigger (known weakness 10).
- **File leases.** The resource-to-glob mapping for file leases is still inside the driver's `leaseFiles` guard (known weakness 4).
- **Attempt step.** `AttemptView.step` is still a string on the untyped `UnitView` default. Typed step names exist on lanes, reactions and step triggers, where comparisons happen.
- **Scenario 12's submit and collect.** They are one job step, not two named steps. The job is the noun for "submitted now, collected later", so a separate `submit` step and `collect` step would be two words for one thing (principle 22).

## Principles broken

None knowingly.

- **Principle 8 and principle 18.** Facets are now resource families, so "metric facets reference [resources] by identity" holds literally. The "facet repeats a column" rule is restated as "a family named after a column". Leasing a family member is permitted, and that is the honesty cost reported above.
- **Principle 8's seat/agent pair.** It is satisfied as in the parent: a seat with a fixed model is the principle's agent, so there is one builder.
