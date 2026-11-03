# harness-dsl: the seat is a place, the call is what runs (child of g01-durable-0-2-0-1--2-0-1-2)

This child keeps the parent's engine unchanged: one ledger, replay at zero cost, per-step crash rules, collected jobs, the Kanban pull model and halt addresses. The operator is **rename**.

The weakest noun in the parent was **Seat**.
- Principle 8 defines a seat as *role × models × choice policy*: a place a role sits, filled at attempt time by the model a policy picks.
- The parent's `Seat` was also the runnable thing a step executes. It carried the pool, the workspace, the guard, the halts a model may raise, the output schema and `.batch()`.
- A seat does not run. You cannot batch a place. The adversary's "overloaded pivot" critique is a naming defect: one noun covered two things.

The fix gives each thing its own noun:
- **Seat** keeps only its principle-8 meaning, plus the pool that pays for it: `H.seat(name).role(r).model(m | policy).pool(p)`. It is the metric key.
- **Call** is the model-call executable. Principle 3 already names it: "a step is a command, a model call, a batch of model calls, or an external job". It is built as `H.call(name, seat).output(schema).workspace(ws).guard(...).halts(...)`.
- **Batch** is `H.batch(call)`. It returns a **Job**, so batching belongs to the executable, not to a seat or a step.
- **Prompt** is the call's input (`{ text, resources?, skills?, facets? }`). It replaces `AgentTask` and its `task` field, which reused the word for "unit of work" and broke standard 22.

## Execution vocabulary (one definition each)

- **Unit**: one card.
  - It has a stable id and a `key`.
  - At most one non-terminal unit per lane holds a key.
  - It outlives its attempts.
- **Attempt**: one pull of a unit through its lane's flow.
  - It ends with exactly one outcome: `succeeded`, `failed` or `cancelled`.
  - While open it is either *running* (unit position `active`, holding WIP, slots, leases and reservations) or *blocked* (position `waiting`, holding nothing).
  - A blocked attempt records its blocker: `decision`, `timer`, `children`, `job` or `recovery`.
- **Step**: a named address in a flow. Reactions, triggers, metrics and halts all address steps by name. `loop` and `exit` are structure, not steps.
- **Invocation**: one execution of an executable within a step. A step retry and each job poll are new invocations.
- **Round**: one pass of a loop, numbered by `ctx.iteration`.
- **Executables**:
  - command;
  - call (one model call);
  - job (submit and collect: an external job, or `H.batch(call)`).

"Run" is not used.

## Entities

**Kinds** (vocabulary, no backend):
- work kind;
- state;
- signal;
- role;
- memory kind;
- halt;
- resource;
- facet (with its value set);
- command;
- job;
- flow;
- operation.

**Instances** (carry a backend, built in subpaths):
- account (with its quota partition);
- quota partition;
- model;
- embedder;
- runner;
- workspace;
- supplier;
- store;
- memory store;
- ledger;
- client;
- observer.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Seat | role × model or model policy × pool | a filled place, and the metric key for model comparisons |
| Call | seat × output schema × workspace × guard × raisable halts | one model-call executable |
| Lane | kind × suppliers × store map × flow (exits, params) × retry × lease × order × ceiling | a swimlane of managed units |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

An agent, in principle 8's sense, is a seat whose `model` is a single model rather than a policy. It gets no separate builder.

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- **No active states.** A kind declares no active state. An active unit's place is its attempt's current step.
- **What a kind declares:** attributes, states, `key` and `initial`. Nothing about failure.
- **Exits.** The lane maps each flow exit to a state of the kind.
- **Failure.** The unit returns to pending under the lane's `retry`. When retry is exhausted, it moves to `retry.exhausted`. A lane without `retry` is a startup error.
- **Cancellation.** Cancellation comes only through a reaction to a signal; `H.cancel` is one such signal.
- **States are entities in every view.**
  - `UnitView.state` is the `State` entity, typed as the kind's state union. `TransitionEvent.to` and `ChildResult.state` are entities too.
  - Code compares by identity: `event.unit.state === AwaitingCustomer`.
  - `OutcomeCounts.of(state)` replaces the name-keyed `byState`.
  - `UnitView.kind` and `UnitView.lane` are entities.
  - `UnitView.enteredAt` is when the unit entered its current state, read from the recorded transition.
  - Backends see `UnitRecord` with names, which is storage only.

## Loops: carry and span (critique 1, and the adversary's Grant scenario)

The parent's builder could not see the auditor's deficits. The parent's return bound also reset whenever a `restart` began a new attempt. Both now have declared mechanisms; neither needs a ledger read in the flow.

```ts
.loop('rounds', { schema: z.array(z.string()), initial: [] },
  round => round.step('build', builderCall, ctx => ({ text: `... fix: ${ctx.steps.rounds.join('; ')}` }))
                .step('audit', auditorCall, ...),
  { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0,
    next: ctx => ctx.steps.audit.deficits })
```

- **Carry.** A loop may declare a carried value: a schema and an initial value.
  - Inside the body, `ctx.steps[loopName]` is the carry, typed from the schema.
  - At the end of each round, `next` computes the next carry from that round's outputs.
  - The kernel records the carry on the ledger as `loopRound`. On replay it reads the carry back; the flow never reads the ledger.
  - After the loop, `ctx.steps[loopName]` is the final carry.
- **Span.** `span: 'attempt' | 'unit'` (default `'attempt'`) says what the round count and the carry belong to.
  - With `span: 'unit'`, a new attempt of the same unit continues the loop at the next recorded round with the recorded carry. The new attempt may come from a `restart` reaction, a retry or a re-pull.
- **Scenario 11.** The counsel loop is `{ max: 2, span: 'unit' }`. A redline that restarts at `draft` no longer resets the return count, so the bound "after the second return, Declined" holds across re-entry.
- **The adversary's Grant scenario.**
  - The carry is the list of panel notes: `next: ctx => [...ctx.steps.review, ctx.steps.panel.notes]`.
  - Every `assess` prompt contains every prior note verbatim.
  - With `max: 3, span: 'unit'`, an applicant revision that restarts at `assess` keeps both the count and the notes.
- **Round results are not memory.** Carried values are attempt-local or unit-local data. They are not memory items, so principle 14 stays intact. Nothing lives in a driver session, so principle 1 stays intact.

## Strings that stood in for entities (critique 2a)

- **States.** State comparisons compare entities (above).
- **Seats.**
  - `StepEvent.modelOf(seat)` and `DecisionEvent.modelOf(seat)` take the seat entity.
  - They replace the `seats` arrays and the `assignment.seat.name === drafter.name` comparison. The `Assignment` type is deleted.
- **Facets.**
  - Facets declare their value set: `H.facet('category', ['billing', 'refund'])`.
  - `of(value)` accepts only those values.
  - A crossing band split `per` a facet yields `CrossingEvent<V>`, whose `value` is typed and present. There are no `event.value === undefined` guards.
  - A band without `per` yields `value: undefined`.
- **Patterns.** `PatternEvent.group` is typed as whatever `per` returns, for example the service union.
- **Resources.** Resources stay plain entities. The `sectionsOf(string)` and `resourcesFor(string)` lookups are a scenario defect, not a surface defect.
  - Attributes carry an enum (`section: z.enum(['sports', 'opinion'])`), and a typed record (`{ sports: H.resource('sports'), opinion: … }`) is indexed by that enum.
  - That is a typed key, not a name lookup. Parsing a vendor's string happens once, at the supplier boundary, as zod parsing.
- **Stored units.** The `sqlite.scan` record no longer exposes a state name. The tenancy review is a timer on the unit (below), not a scan comparing `'Customer'`.

## Timers move only when their deadline moves (critique 2b)

`H.when.timer(lane, { at })` arms a timer at creation.

- **Recompute on update.** After every `attributesUpdated` or transition, the kernel recomputes `at(unit)`.
  - If the value is unchanged, the timer is untouched.
  - If it changed, the old timer is cleared (`timerCleared: moved`) and a new one is set.
  - If the value is `undefined`, the timer is disarmed.
- **What this removes.** A redline or a reply that does not change the deadline no longer re-arms an unrelated timer.
- **Scenario 9.** The SLA extension is declared: the reviewer's `workUpdate` changes `slaDeadline`, the deadline function's value changes, and the timer moves. The old deadline never fires.
- **`at` must be deterministic.** It reads only the unit view.
- **Months.** `H.nextTime` gained `on` (weekday or day of month), so the tenancy review is `at: unit => unit.state === Customer ? H.nextTime('09:00', { after: unit.enteredAt, on: 1 }) : undefined`.

## Seats, calls, batches, A/B (critique 3)

- **Overload removed.** The seat now holds role, model choice and pool. The call holds output, workspace, guard and halts.
- **Batch.** Batch-ness lives on the executable: `H.batch(call)`.
  - Startup refuses a batch whose seat's model, or any policy candidate, has a driver without `submitBatch`.
  - Startup also refuses a seat whose pool holds no account its models' drivers serve. This is where scenario 10's subscription-plus-batch mismatch is caught, by a named rule.
- **No more thunk.** `PolicyCtx` gains:
  - `peers`: the other seats of the same role in the attempt's flow;
  - `current`: the model the seat used in its last recorded invocation.
  
  A reviewer policy reads its rival as `ctx.peers` and no longer needs a forward-reference thunk.
- **No collapse in scenario 6.**
  - The policy measures `rate({ seat: ctx.seat, model: ctx.current })` against the peer's current series. The comparison therefore follows the swap instead of freezing on the old incumbent.
  - Each reviewer seat is given disjoint candidates, so the two seats can never land on one model.
  - Startup refuses two seats of one role in one flow whose candidate sets intersect when both are policies. "Two agents of the same role on different models" is thus enforced, not hoped for.

## Smaller repairs

- **GPU hours in flight.** The kernel records `jobCollected`. `Metrics.jobs({ job, window })` returns:
  - `inFlightMs`, the submit-to-collect intervals clipped to the window, so a job running at midnight splits across days;
  - `running`, the jobs still in flight;
  - `samples`.
  
  It replaces the step-duration metric.
- **Scenario fixes.** These are scenario defects, fixed in the next step:
  - "Heartbeats first" is written one way in both scenarios 1 and 7: `.expedite(heartbeats)` only where the requirement says *first ahead of WIP*; otherwise first in `standard`. Scenario 1 uses `standard(heartbeats, bugs, features, epics)` in both files.
  - Share fractions are stated as caps per account, with no hidden meaning.
  - Unrequested `admit` lambdas are dropped. Scenario 9 drops its invented pause budget. Scenario 8 drops its inconclusive gate, and its policy question becomes a metric query: `outcomes(...).of(Inconclusive)`.

## Unchanged from the parent

The following carry over without change:
- **Classes of service:** expedite with holds, fixedDate, standard, aging.
- **WIP over lane groups.**
- **`admit`**, kept for budgets (scenario 3).
- **Reactions:** `update`, `restart` and `enter`, gated `at` typed steps.
- **Halts:**
  - the entity is `H.halt(name).decision(schema)`;
  - the address is `flow.halt(step, halt, opts)`;
  - three resolvers: human, policy and timeout;
  - an `escalate` option;
  - a `when` option giving a not-asked branch typed `D | undefined`;
  - grants name halts.
- **Quota partitions** on the account, with harness identity joining them.
- **Restart rules:**
  - a writer claim;
  - replay;
  - `afterCrash`: `rerun`, `park` (with `alreadyDone`) or `askDriver`;
  - `flowVersion` parks the attempt;
  - an interrupted attempt is excluded from every rate.
- **Leases and `after` ordering.**
- **Store maps with `inFlight`.**

## Startup validation (known weakness 9)

`start()` fails before any supplier starts on any of:

1. Two descriptors with one name, within an entity sort.
2. A lane without `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state outside the kind, or a flow path that reaches no exit.
4. A kind without `initial`.
5. A lane in no class of service, or in two.
6. An unregistered lane, journal or metric referenced by a trigger, the scheduler, a spawn or a WIP group.
7. A signal routed into a lane without a reaction, including `H.cancel` or the `workCancel` grant.
8. A reaction `at` or `restart` naming a step its flow lacks.
9. A seat without a pool, or a seat model or policy candidate that no account of its pool serves.
10. `H.batch(call)` on a driver without `submitBatch`; `askDriver` on a driver without `session`.
11. A guard the driver cannot `enforce`.
12. A grant naming a halt no registered flow, call or ceiling uses.
13. A halt policy over a halt or kind other than the one at its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet whose name is a column name (`kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`), or a facet with an empty value set.
17. `Lane.after` on a kind without a key.
18. One account name bound to two quota partitions; a partition that refuses this harness name.
19. Two policy seats of one role in one flow with intersecting candidate sets.
20. A loop carry whose `initial` fails its own schema; a `span: 'unit'` loop inside another loop.
21. A memory scope or prompt facet value outside its facet's value set.

## What changed and why

**Rename (operator).**
- The model-call executable is renamed from `Seat` to `Call` (`H.call(name, seat)`). Principle 3 calls it a model call; a seat is principle 8's place, not a runnable.
- `Seat` is reduced to role, model or policy, and pool.
- `seat.batch()` becomes `H.batch(call)`.
- `AgentTask { task }` becomes `Prompt { text }`, because "task" collided with the work vocabulary.
- These touch scenarios 1–3, 5–12, every model step, `ModelRequest` (`call` and `prompt` fields) and the startup rules 9, 10 and 19.

**Critique repairs.**
1. **Scenario 1 deficits and the Grant return bound.** Loops gain a typed `carry` with `next`, recorded as `loopRound`, and a `span`. A unit-spanning loop keeps its count and its carry across restart and re-entry.
2. **Strings standing in for entities.**
   - `UnitView.state`, `.kind` and `.lane`, `TransitionEvent.to` and `ChildResult.state` are entities.
   - `OutcomeCounts.of(state)` is added.
   - `modelOf(seat)` replaces seat-name comparison.
   - Facets have typed value sets; `CrossingEvent<V>` and `PatternEvent.group: G` are typed.
   - The scan record drops its state name.
3. **Timer coupling.** A timer moves only when its computed deadline changes. `timerCleared: moved` replaces `rearmed`.
4. **Seat overload, batch leak, A/B collapse, thunk.** Handled by the split above, plus `PolicyCtx.peers` and `PolicyCtx.current`, and startup rule 19.
5. **GPU hours in flight.** `jobCollected` and `Metrics.jobs` are added.

**Deleted:**
- `Seat.output`, `.workspace`, `.guard`, `.halts` and `.batch` (moved to `Call`, or replaced by `H.batch`);
- `AgentTask`;
- `Assignment`;
- `StepEvent.outputs` and `StepEvent.seats`;
- `DecisionEvent.seats`;
- `OutcomeCounts.byState`;
- `StoredUnit.state` in the sqlite adapter.

**Added:**
- `Call`, `H.call`, `H.batch` and `Prompt`;
- `Carry` and `LoopBounds`, with `span` and `next`;
- `FacetBand` and `Facet<V>.values`;
- `PolicyCtx.peers` and `PolicyCtx.current`;
- `Metrics.jobs` and `JobRef`;
- `UnitRecord` as the backend-side record, with `loops`;
- the `loopRound` and `jobCollected` events;
- `H.nextTime({ on })`.

### Battery pass, scenarios 7–12

Writing scenarios 7 to 12 against this surface exposed three gaps. Each is fixed by the smallest change that removes the gap.

1. **`UnitView.enteredAt` (and `UnitRecord.enteredAt`).**
   - **Gap.** Scenario 8's tenancy is reviewed monthly by a timer whose `at` must be deterministic over the unit view. The view had no time to measure from except `createdAt`. A deadline computed from `createdAt` lands in the past after the first review and fires at once.
   - **Fix.** `enteredAt` is the time of the recorded transition into the current state. With it, `H.nextTime('09:00', { after: unit.enteredAt, on: 1 })` gives the first of the next month after the unit became `Customer`. A reinstatement re-enters `Customer` and re-bases the review.
   - **Why this stays within the rules.** The value is read from the ledger, never from unit data, so principle 17's rule for clocks holds by analogy.
2. **`Scope.facets` (and `StoredScope.facets`), and `Prompt.facets`.**
   - **Gap.** Scenario 9 records an experience item "scoped to the drafter role and the category". A category is a declared facet, not a resource. The only fields that could have held it were `skills` (a string standing in for an entity, against principle 8) or a resource per category (a resource is a leased shared thing, which a category is not).
   - **Fix.** Scope now carries typed facet values. A prompt carries the facet values of the call it feeds, so recall can match the item's `when.facets` by identity and rank it by specificity like any other scope field.
   - **Startup.** Rule 21 refuses a value outside the facet's value set.
3. **Reaction semantics with both `restart … at` and `enter`.**
   - **Gap.** Scenario 9's customer reply must restart a draft awaiting approval *and* reopen a conversation already answered and parked at `AwaitingCustomer`. The reaction type allowed both fields, but the design did not say what they mean together.
   - **Rule.** `update` always applies. `restart` applies when the unit's open attempt stands at one of the `at` steps. `enter` applies when the unit has no open attempt. An attempt open at a step outside `at` keeps running with the updated attributes. This is how scenario 11's redline is "applied in the next round" during `draft`.

No type or builder was removed in this pass.

**Open:**
- Resource-to-glob mapping for file leases is still a call-guard concern (known weakness 4).
- Pool-serves-model is checked at startup (rule 9), not declared (known weakness 5).
- Memory capture still needs an author-written trigger (known weakness 10).

## Principles broken

None knowingly.

- **Principle 8 and the agent.** Principle 8 says "an agent is a seat with one model". This child honours that as a definition, not as a second builder: a seat given a single model *is* the agent.
- **The call and principle 9.** The call is a pivot (seat × output × workspace × guard × halts). It has a noun, and the noun names what it produces: one model call.
