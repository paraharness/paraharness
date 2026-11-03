# harness-dsl: inference pass on the Kanban lens (child of g01-durable-0-2-0-1--2-0-1-2)

The parent's engine is kept unchanged:
- one ledger;
- replay at zero cost;
- per-step crash rules;
- jobs collected rather than resubmitted;
- lanes as swimlanes, with named states as columns outside the flow;
- classes of service.

This child applies one operator: **inference**. Wherever a parent scenario needed a type annotation, `satisfies`, `as const`, an explicit type argument, a type import, a forward-reference thunk or a string comparison to keep the types honest, the surface now carries that type instead. The child also repairs the adversary's worst-scenario finding and its three sharpest critiques.

## Execution vocabulary (one definition each)

- **Unit**: one card.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a key.
  - It outlives its attempts.
- **Attempt**: one pull of a unit through the lane's flow.
  - It ends with exactly one outcome: `succeeded`, `failed` or `cancelled`.
  - While open it is either *running* (position `active`, holding WIP, slots, leases and account reservations) or *blocked* (position `waiting`, holding nothing).
- **Step**: a named column of a flow. The step name is the address used by reactions, triggers, metrics and halts. `loop` and `exit` are structure.
- **Invocation**: one call of an executable within a step. A step retry and each job poll are new invocations.

"Run" is not used.

## Lifecycle (principle 12)

- **States.** `H.state(name, 'pending' | 'waiting')` and `H.terminal(name, verdict)` declare states; the verdict has no default.
- **No active states.** A kind declares no active states. Where an active unit stands is its attempt's current step.
- **What a kind declares:** attributes, states, `key` and `initial`.
- **Where an ending attempt leaves the unit:**
  - **Exit.** The lane's `exits` map sends an exit to any state of the kind.
  - **Failure.** A failed attempt returns the unit to pending under the lane's `retry`. When retries are exhausted, the unit moves to `retry.exhausted`. A lane without `retry` is a startup error.
  - **Reaction.** A reaction's `enter` cancels any open attempt (outcome `cancelled`, never a failure) and moves the card.
- **`UnitView.state` is the State entity**, not its name. Triggers, admission gates and policies compare states by identity (`event.unit.state === AwaitingCustomer`).

## Inference audit (the operator)

Each row is a place in the parent's scenarios where inference did not carry the type, and the surface change that fixes it.

| Parent scenario site | What the author had to write | Surface change |
|---|---|---|
| s02, s09: one route shared by webhook and poll | `type ConversationAttrs = z.infer<…>`, `Router<ConversationAttrs>`, an import of the adapter's event type | `Lane.supply(suppliers \| readonly suppliers[], route)`: one route over several suppliers of one event type, inferred inline. |
| s05: shared step retry | `satisfies { backoff: 'exponential' … }`, because a free const widened the literal | `H.retry(retry): Retry` gives the literal a contextual type. |
| s09: category list | `as const satisfies readonly string[]`, `new Map<string, Resource>`, a tuple-typed arrow, `function resourcesFor(name: string): Resource[]` | `H.facet(name, values)` and `H.resources(name, values)` with `const` type parameters. Each yields a typed `schema` for attributes and outputs. `Facet.of(v)` and `ResourceFamily.get(v)` accept only declared values. |
| s06: `sectionsOf(section: string)` | lookup of a resource by its name | `H.resources('section', ['sports', 'opinion'])` with `.get(section)`. |
| s06: A/B reviewer policy | type imports `Model`, `ModelPolicy`, `SeatRef`, `Assignment`, `AgentTask`; a helper with annotated parameters; `(): SeatRef => reviewerB` thunks | `H.policy.lineup` (see Seats). The task helper's return type is inferred. |
| s02, s06, s03: model behind a decision or step | `event.seats.find(a => a.seat.name === drafter.name)?.model`, `event.seats.synthesize?.model` | `DecisionEvent.modelOf(seat)` and `StepEvent.modelOf(seat)`, compared by identity. |
| s09: crossing per category | an `event.value === undefined` guard on every consequence | `CrossingEvent<V>`. When the band has `per: facet`, `value: V` is required and typed. Without `per`, there is no `value` field. |
| s04: pattern group | `event.group: string` | `PatternEvent<…, G>`, where `G` is inferred from `per`. |
| s08: inconclusive rate | `ended.byState.Inconclusive`, a string key | `OutcomeCounts<S>.count(state)` takes the State entity. |
| s02, s08: state checks | `event.unit.state === 'AwaitingCustomer'`, `stored.state === 'Customer'` | `UnitView<A, S>.state: S`. `H.when.sweep(lane, { every, in: [Customer] })` replaces the sqlite scan supplier. |
| s10: mismatched model and pool | caught only by startup rule 9 | `Account<V>`, `Model<V, B>` and `Pool<V>` carry the driver vendor as a phantom parameter. `Seat.pool` rejects a pool holding accounts the model cannot serve. Vendor literals appear only in adapter blocks. |
| s10, s03: batching | `seat.batch()` available on any seat | `H.batch(seat)` accepts only `Seat<O, V, true>`, a seat whose every candidate model supports a batch API. |
| s04, s05: per-host literals and source lists | `satisfies` on host literals, `NightlyLoadAttrs['source'][]` | No new surface. Scenarios derive lists from `schema.options` and key runner maps by the same enum. |

Two kinds of annotation remain, and both are honest:
- parameter types on plain helper functions (e.g. a migration key builder), which TypeScript requires of any function;
- nothing else.

## Repairs to the adversary's critique

### Worst scenario (1): the builder never saw the deficits

`Flow.loop` gains a **carry** form:

```
.loop('rounds', { schema: z.array(z.string()), initial: [] }, round => round
    .step('build', builder, ctx => ({ task: `…fix: ${ctx.steps.rounds.join('\n')}` }))
    .step('audit', auditor, …),
  { max, until, next: ctx => ctx.steps.audit.deficits })
```

- **Reading the carry.** The loop name becomes a step address inside the body, typed `C`. Its value is the carry before this round.
- **Updating the carry.** After each round, `next` computes the new carry from that round's outputs.
- **Persistence.** The kernel records `carryRecorded` per iteration, so a resumed loop sees the right carry.
- **Why a schema.** The schema validates the carry at replay and makes `C` inferable before the body is checked.
- **What it replaces.** The builder's prompt is now fed by typed state, not by vendor session memory. The parent's principle 1 and 14 leak is closed.

### The adversary's Grant scenario: bounds across re-entry, notes across attempts

`Lane.on(halt, reaction)` is a **decision reaction**. It is the same `on` used for signals, keyed by the halt entity:

```
.on(counsel, {
  when: d => d.verdict === 'return',
  update: (a, d) => ({ ...a, counselNotes: [...a.counselNotes, d.notes] }),
  enter: declined,
  count: 2,
})
```

- **Notes.** Every matching decision applies `update`, recorded as `attributesUpdated`. The notes become domain state that the next `draft` reads from its attributes: verbatim, not memory, no ledger read.
- **Bound.** `enter` applies when the matching decisions over the unit's whole life reach `count`.
  - The kernel keeps the count (`UnitRecord.decisionMatches`, derived from `decisionRecorded`).
  - A `restart` or a fresh attempt does not reset it.
- **Scenario 11's "Declined after the second return"** becomes `count: 2`. A return otherwise exits to a pending state, and a new attempt redrafts.

### Critique 1: strings standing in for entities

- `UnitView.state` is the State entity; `UnitView.kind` and `UnitView.lane` are refs.
- `AttemptView.halt` is a `HaltRef`.
- `ChildResult<S>.state` is typed from the child lane.
- Facets are declared with their values, so `FacetValue<V>` and crossing values are typed.
- Resource families replace name lookups.
- The sweep source replaces `stored.state === 'Customer'`.
- `modelOf(seat)` replaces seat-name comparison.
- Storage keeps names (`UnitRecord`, `StoredScope`, `StoredDimensions`). That is serialization, not surface.

### Critique 2: timer re-arm was a hidden coupling

`H.when.timer(lane, { reads: ['slaDeadline'], at: view => … })` declares the fields the deadline depends on.

- **What `at` can see.** It receives `TimerView<Pick<A, K>>`: only the declared fields, plus `key` and `createdAt`. The declaration therefore cannot lie.
- **When the timer re-arms.** The kernel re-arms it only when an `attributesUpdated` event changes one of those fields. That event now records `changed`. The old deadline is cleared (`timerCleared: rearmed`) and never fires.
- **No reads.** A timer with no `reads` is armed once at creation.
- **Disarming.** Timers are disarmed when the unit reaches a terminal state, so authors no longer write `position === 'terminal' ? undefined : …`.
- **Effect on the battery.** Scenario 9's SLA extension works by declaration. Scenario 2's customer reply re-arms nothing, because it changes `lastMessage`, not the deadline.

### Critique 3: the seat overloaded; batch leaking; A/B collapse; the rival thunk

- **The seat now carries:** role, model choice, pool, output, workspace and raisable halts.
  - The guard moved to the workspace (`Workspace.guard({ leaseFiles, beforeStop })`). File leases and the stop check concern the files the workspace holds, not the role or model.
  - Batch moved off the seat to `H.batch(seat)`, which is typed to batch-capable models.
- **Pool and model are matched by type.** See the inference table.
- **Lineup.** `H.policy.lineup(name, candidates, choose)` is a pivot whose noun is what it produces: a lineup, an assignment of distinct models to the seats that share it.
  - **Context.** `choose` receives `ctx.seats`, discovered at startup from the seats whose `.model(lineup)` names it, and `ctx.current(seat)`. No seat refers to another, so there is no thunk.
  - **Result.** It returns one assignment per seat.
  - **Distinctness.** The kernel rejects an incomplete or duplicate lineup, records the rejection on `policyDecision.rejected`, and keeps the current lineup. Two reviewer seats therefore cannot collapse onto one model.
  - **No stale series.** The policy reads each seat's rate on its current model, so it never keeps measuring a model the seat has left.
- **Seat versus agent.** A seat with a fixed model is principle 8's agent, so there is one builder and one noun.

### Smaller findings

- **"Heartbeats first."** It is encoded one way across the battery: first in `standard(...)` order. `expedite` is reserved for preemption (scenario 4).
- **GPU hours in flight per day.** `Metrics.jobs({ job, window })` derives the figure from `jobSubmitted` and `jobCollected`.
  - Hours are apportioned to the calendar window they fall in.
  - It returns hours, samples and the number still `running`, so jobs in flight are visible.
- **Admission gates.** `admit` gates that no scenario asked for are removed from the scenarios. The surface is unchanged.

## Entities

**Kinds** (vocabulary, no backend):
- work kind;
- state;
- signal;
- role;
- memory kind;
- halt;
- resource and resource family;
- facet;
- command;
- job;
- flow;
- operation.

**Instances** (carry a backend):
- account, with its quota partition;
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

`H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow (exits, params) × retry × lease × order × ceiling × reactions | a swimlane of managed units |
| Seat | role × model choice × pool × workspace × raisable halts | a model-call executable |
| Lineup | seats × candidate models × joint choice policy | distinct model assignments |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Sources of triggers (all from recorded ledger events)

| Source | Fires on |
|---|---|
| `transition` | a recorded transition |
| `pattern` | consecutive matching transitions per group |
| `timer` | `timerFired` |
| `sweep` | `clockTicked`, for each unit in the named states at that sequence number |
| `step` | `stepEnded` |
| `decision` | `decisionRecorded` |
| `invocation` | an invocation |
| `crossing` | a recorded `crossing`, with hysteresis between `enter` and `exit`, once per crossing, optionally per facet |

## Halts, jobs, quota, leases, order, restart

These are unchanged from the parent unless named here.

- **Halts.** A halt entity versus its flow address; `when` for a question that is not asked; `skip` as a registered policy; a `timeout` that resolves the halt; `escalate`; grants that name halts.
- **Jobs.** A job holds no capacity while it runs and is collected on restart.
- **Quota.** Quota partitions live on accounts, with per-harness share caps.
- **Leases.** `Lane.lease` takes exclusive or shared leases on resources.
- **Order.** `Lane.after` orders units by key.
- **Restart.** A writer claim with a TTL; `afterCrash` with `rerun`, `park` or `askDriver`; `alreadyDone`; `definitionChanged` parking.
- **Loops.** Recorded iterations and carries, so a backfill resumes at its next batch and a build loop resumes with the right deficits.

## Startup validation

`start()` fails, before any supplier starts, on any of:

1. Two descriptors with one name, within an entity sort.
2. A lane with no `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state outside the kind, or a flow path that reaches no exit.
4. A kind whose `initial` state is missing.
5. A lane in no class of service, or in two.
6. A lane, journal or metric referenced by a trigger, scheduler entry, spawn or WIP group but not registered.
7. A signal routed or triggered into a lane without a reaction, or `workCancel` granted on a lane without a cancel reaction.
8. A reaction `at` or `restart` naming a missing step.
9. A seat without a pool. The vendor mismatch is a type error; this check guards untyped callers.
10. An `H.batch` on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A workspace guard the driver cannot `enforce`.
12. A grant naming a halt that no flow, seat or ceiling uses.
13. A halt policy whose halt or kind differs from its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet named like a column (`kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`), or a facet with no values.
17. `Lane.after` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name.
20. A lineup shared by fewer than two seats, or with fewer candidates than seats.
21. A timer `reads` field absent from the kind's attribute schema.
22. A decision reaction on a halt that the lane's flow never asks, or with `count` below 1.
23. A loop carry whose `initial` fails its schema.

## What changed and why

### Added

- `Lane.supply` over several suppliers.
- `H.retry`.
- `H.facet(name, values)` with `schema` and `values`.
- `H.resources` and `ResourceFamily`.
- `H.policy.lineup` and `Lineup`.
- `H.batch(seat)`.
- `Workspace.guard`.
- `Account<V>`, `Model<V, B>`, `Pool<V>` and `VendorFits`.
- `Flow.loop` with a carry (`Carry`, `next`).
- `Lane.on(halt, DecisionReaction)` with `when`, `update`, `enter`, `count`.
- `H.when.sweep`.
- Timer `reads` and `TimerView`.
- `CrossingEvent<V>`.
- `PatternEvent<…, G>`.
- `modelOf` and `facet` on events.
- `OutcomeCounts.count(state)`.
- `Metrics.jobs`.
- `ChildResult<S>`.
- `Signal.entity`.
- Ledger events `carryRecorded`, `decisionReacted`, `jobCollected` and `clockTicked`; `policyDecision.rejected`; `attributesUpdated.changed`; `timerSet.reads`.
- `UnitRecord` as the storage shape, with `carries` and `decisionMatches`.

### Removed

- `Seat.batch`.
- `Seat.guard`, moved to the workspace.
- `sqlite.scan`, replaced by the sweep trigger source.
- `StepEvent.outputs` and `seats`, and `DecisionEvent.seats`, replaced by `modelOf`.
- `OutcomeCounts.byState`.
- `UnitView.state` as a name.
- `PatternEvent.group: string`.
- `CrossingEvent.value?: string`.

### Why

Each change removes an annotation, cast, thunk or string comparison that a scenario was forced to write (see the inference audit), or repairs a named defect of the parent (see Repairs).

### Open

- **Pool serves models (known weakness 5).** It is now type-checked through vendors but still lives on the driver.
- **Memory capture still needs an author-written trigger (weakness 10).**
- **File-to-resource mapping for leases (weakness 4)** is a workspace guard setting.
- **Decision reactions cancel the open attempt.** When `enter` ends an attempt at a halt, the attempt's outcome is `cancelled` and the unit's verdict carries the meaning (Declined is a failure). Some may read that as two records of one event.

## Principles broken

None knowingly.

- **Seats, lineups and agents (principle 8).** A seat with a fixed model is the principle's agent. A lineup is a seat's choice policy shared across seats so that their models stay distinct. It is a pivot with a noun (principle 9) and earns its place only where models are compared side by side (scenario 6).
- **Decision reactions (principle 17).** The decision reaction reads nothing from the ledger in a flow, and its count is kernel state derived from recorded decisions. It therefore stays inside principles 15 and 17.
