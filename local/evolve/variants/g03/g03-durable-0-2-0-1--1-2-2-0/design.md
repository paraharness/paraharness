# harness-dsl: second inference pass (child of g02-durable-0-2-0-1--0-1-2-2)

The parent's engine is kept unchanged:
- one ledger;
- replay at zero cost;
- per-step crash rules;
- jobs collected rather than resubmitted;
- lanes as swimlanes, with named states as columns;
- classes of service.

This child applies the **inference** operator a second time. The parent claimed its audit was complete, and the adversary showed it was not. This pass treats every remaining annotation, type import, named-function-with-typed-parameter and seat-identity closure as a defect of the surface, not of the scenario. It also repairs the adversary's worst-scenario findings, its new scenario (two locks held across a halt) and its three sharpest critiques.

## Execution vocabulary (one definition each)

- **Unit**: one card.
  - It has a stable id and a `key`.
  - At most one non-terminal unit per lane holds a key.
  - It outlives its attempts.
- **Attempt**: one pull of a unit through its lane's flow.
  - It ends with exactly one outcome: `succeeded` (the flow reached an exit), `failed` or `cancelled`.
  - While open it is either *running* (position `active`, holding WIP, runner slots, account reservations and leases) or *blocked* (position `waiting`, holding no WIP and no slot).
  - A blocked attempt keeps only the leases its lane declared `holdWhileBlocked`.
- **Step**: a named column of a flow. The step name is the address used by reactions, triggers, metrics and halts.
- **Invocation**: one call of an executable within a step.

"Run" is not used.

**Exit versus verdict.**
- An exit ends the attempt `succeeded`: the flow did its work.
- The state the exit maps to carries the kind's verdict.
- This is now the only rule. The parent's "decision reaction ends the attempt `cancelled` but the unit fails" is gone (see critique 2).

## Lifecycle (principle 12)

- **States.** `H.state(name, 'pending' | 'waiting')` and `H.terminal(name, verdict)`; the verdict has no default.
- **No active states.** A kind declares no active states. Where an active unit stands is its attempt's current step.
- **Where an ending attempt leaves the unit:**
  - **Exit.** The lane's `exits` map sends an exit to a state of the kind.
  - **Failure.** A failed attempt returns the unit to pending under the lane's `retry`. When retries are exhausted, the unit moves to `retry.exhausted`. A lane without `retry` is a startup error.
  - **Signal reaction.** `Lane.on(signal, { enter })` cancels any open attempt (outcome `cancelled`) and moves the card.
- **No dead ends.** A waiting state that nothing can leave is a startup error. "Something" means one of:
  - a signal reaction entering another state;
  - a sweep;
  - an order release.

## Inference audit, second pass

Each row is a site in the parent's scenarios that still carried a type by hand, and the surface change that removes it.

| Parent site | What the author wrote | Surface change |
|---|---|---|
| s06 reviewer lineup | `import { LineupCtx, Assignment }`, `function choose(ctx: LineupCtx): readonly Assignment[]`, `const current: readonly Assignment[]`, `ctx.current(seat) ?? (seat === reviewerA ? opus : sonnet)`, a module-level `reviewerModels` list | `LineupCtx.assignments` is always complete: at startup the kernel assigns candidates to seats in declaration order and records the assignment. `LineupCtx.spare` lists the candidates not assigned. The choose callback is written inline and needs no type, and it never names a seat. |
| s11 two contract lanes | `import { type Retry }`, `(name: string, laneRegion: 'eu' \| 'us', retry: Retry) => …` | `Lane.rename(name)` derives a renamed lane (principle 11 already requires derived descriptors to be renamed). `Lane.accepts(attrs => …)` partitions creations from a shared route. One base lane is written once; each regional lane is `base.rename('contracts-eu').accepts(a => a.region === 'eu').retry(…)`. No factory and no parameter types. |
| s01 `features()` thunk (TDZ at load) | a forward-reference function that threw at module load | No surface change is needed, because there is no cycle: the feature lane does not reference the epic flow. The scenario declares the feature lane before `decompose`. Startup rule 6 reports an unregistered spawn target by name, and the design now states that forward thunks are never required. |
| s02, s06, s09, s10 vendor phantoms | `Model<'claude-subscription' \| 'anthropic-api', false>` inferred through an adapter that named another adapter's literal | Removed (critique 3). `Model<B>` keeps only the batch capability, which belongs to its own driver. |
| s11 decision bound | `.on(halt, { when, update, enter, count })` beside `.on(signal, …)`, the same verb for two concepts | The bound moves to the halt step: `limit: { when, max, exit }`. The exit literal is inferred into the flow's exit union, so the lane's `exits` map must cover it. `annotate: (attrs, decision) => Partial<attrs>` replaces `update`. |

What remains:
- Parameter types on plain helper functions that are not callbacks of the surface (s12 `previousMigration(id: string)`). TypeScript requires these of any free function.
- No type imports.
- No `satisfies`.
- No explicit type arguments.
- No seat-identity comparisons.

## Repairs to the worst scenario (01)

- **TDZ.** Fixed by declaration order, as described in the audit above.
- **Wrong success for the builder model.** The policy now reads `ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window })`.
  - `Metrics.outcomes` gains the `seat` and `model` dimensions.
  - A unit's verdict is attributed to the seat and model of the attempt that moved it to terminal.
  - So "success on this kind of work" means the kind's terminal verdicts (principle 18), with `samples` beside the rate.
  - `PolicyCtx.kind` is a `WorkRef`, so it is accepted by `outcomes`.
- **NeedsOwner dead end.** The new startup rule forbids it. Scenario 01 declares an `owner-unblocked` signal, `.on(ownerUnblocked, { enter: Open })`, and grants `workSignal` to the supervisor.
- **One hardcoded service.** The heartbeat clock route maps over the declared service enum, one unit per service per tick.

## The adversary's new scenario: two locks held across a halt

The parent could not express ArchiveCopy for two reasons: `lease` returned one `Lease`, and every lease was released at a block.

- **Several leases, taken together.** `Scheduler.lease(lane, unit => Lease | readonly Lease[])` takes several leases atomically (`Ledger.takeLeases`). They are all taken, or the unit is not started and the wait is recorded.
- **Holding a lease across a block.** `Lease.holdWhileBlocked: true` keeps that lease while the attempt is blocked. WIP and runner slots are still released. The board shows the unit at `waiting`, holding the named resources.
- **Recording.** `attemptBlocked.heldLeases` and `leaseTaken.resources[].holdWhileBlocked` record what was kept.
- **Metric.** `Metrics.leases` adds `heldWhileBlockedMs` beside lock wait.
- **ArchiveCopy as written:**
  ```
  .lease(archiveCopies, u => [
    { resource: db.get('orders'), mode: 'shared', holdWhileBlocked: true },
    { resource: db.get('archive'), mode: 'exclusive', holdWhileBlocked: true },
  ])
  ```

Leases move from the lane to the scheduler. A lease is a capacity input to "what runs next" (principle 16), and the move also shortens the lane (critique 2). The same applies to unit ordering: `Lane.after` becomes `Scheduler.order(lane, { after, onPredecessorFailed })`.

## Repairs to the three sharpest critiques

### 1. The inference audit was false

The critique was correct. The second-pass table above names each site, and each fix is in the surface:
- `assignments` and `spare` on the lineup context;
- `rename` and `accepts` on lanes;
- declaration order for spawn targets.

On the rival-seat thunk, the critique also stands: the parent's policy compared `seat === reviewerA`. It no longer has to. Initial models come from candidate order, recorded as a `policyDecision`, and the policy maps over `ctx.assignments`.

### 2. `Lane.on` named two concepts, and the lane had ten concerns

- **`Lane.on` is now signals only.** The decision bound lives where the decision is asked: the halt step.
  - `limit.max` counts matching decisions over the unit's whole life. The kernel keeps the count in `UnitRecord.decisionMatches`, derived from `decisionRecorded`. Restarts do not reset it.
  - When the count reaches `max`, the step exits through `limit.exit` and records `decisionLimited`. The attempt ends `succeeded` at that exit, and the mapped state (Declined, a failure verdict) carries the meaning.
  - One record per meaning: the attempt outcome says the flow finished, and the verdict says how the work ended. That is the same rule as every other exit. The parent's `cancelled`-plus-failure double record is gone.
- **Notes.** `annotate` writes the decision into unit attributes, recorded as `attributesUpdated` and saved to the store, so the next attempt's draft reads the counsel notes from its attributes. The flow never reads the ledger.
- **The lane's concerns.** The lane now holds kind × suppliers (with `accepts`) × store × handler (exits, params) × retry × signal reactions × ceiling.
  - Lease and order moved to the scheduler, where capacity and sequencing already live.
  - Retry stays on the lane by principle 12.
  - The ceiling stays because it governs an attempt in flight, not admission.
  - That leaves seven concerns, each tied to a principle (16's three pillars, 12's retry, 13's reactions). We argue this is the lane's real shape and not overload: a lane *is* the pivot of supply × store × handler per kind.

### 3. Vendor strings coupled subpaths; files leaked into the kernel driver

- **Vendor coupling.**
  - `Account<V>`, `Model<V, B>`, `Pool<V>` and `VendorFits` are removed.
  - No adapter's types name another adapter's literal. Delete `harness-dsl/anthropic` and `harness-dsl/claude-code` still compiles.
  - What this costs: pool–model compatibility is checked at `start()` (rule 9, through `ModelDriver.serves`) instead of at compile time. We prefer an honest startup check to a type that couples two subpaths (principles 5 and 7).
- **Files in the driver contract.**
  - `ModelDriver.enforce('leaseFiles' | 'beforeStop')` is removed.
  - A driver may instead receive a kernel `Gate` on `invoke` and call `gate.check({ action: 'write', target } | { action: 'stop' })`. Targets are opaque strings the workspace defines; the kernel records each check as `gateChecked`.
  - Drivers without workspaces implement nothing (`gates` is optional).
  - The workspace guard is `exclusiveWrites` (two attempts may not write one target) plus `beforeStop`.
  - Startup rule 11 now reads: "a seat whose workspace has guards on a driver that does not declare `gates`". Only seats with guarded workspaces are affected; scenarios 2 and 4 are untouched.

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

`H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers (accepts) × store map × flow (exits, params) × retry × reactions × ceiling | a swimlane of managed units |
| Seat | role × model choice × pool × workspace × raisable halts | a model-call executable |
| Lineup | seats × candidate models × joint choice policy | distinct model assignments |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission × leases × order | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Supply with shared routes

Each lane runs its own routes.
- **Creations.** `accepts` filters the units a lane creates. If a created attribute set is accepted by no lane of the kind, or by two lanes sharing the supplier event, nothing is created and `createRejected` is recorded.
- **Signals.** A signal goes to the lane that holds the key. Other lanes record `signalSkipped`.

## Sources of triggers

These are unchanged from the parent:
- `transition`;
- `pattern`;
- `timer` (with `reads` for re-arming);
- `sweep`;
- `step`;
- `decision`;
- `invocation`;
- `crossing` (hysteresis, optionally per facet).

All of them fire only from recorded ledger events.

## Restart (principle 15, scenario 10)

This is unchanged from the parent:
- a writer claim with a TTL;
- `afterCrash: 'rerun' | 'park' | 'askDriver'`;
- `alreadyDone`;
- `definitionChanged` parking;
- recorded loop carries;
- jobs collected, not resubmitted.

Leases with `holdWhileBlocked` are recorded on the ledger, so they survive a restart.

## Startup validation

`start()` fails, before any supplier starts, on any of:

1. Two descriptors with one name, within an entity sort. A renamed lane counts as a new name.
2. A lane with no `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state outside the kind, or a flow path that reaches no exit.
4. A kind whose `initial` state is missing.
5. A lane in no class of service, or in two.
6. A lane, journal or metric referenced by a trigger, scheduler entry, spawn or WIP group but not registered.
7. A signal routed or triggered into a lane without a reaction, or `workCancel` granted on a lane without a cancel reaction.
8. A reaction `at` or `restart` naming a missing step.
9. A seat without a pool, or a pool holding an account no candidate model's driver `serves`.
10. An `H.batch` on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A seat whose workspace declares guards on a driver that does not declare `gates`.
12. A grant naming a halt that no flow, seat or ceiling uses.
13. A halt policy whose halt or kind differs from its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet named like a column, or a facet with no values.
17. `Scheduler.order` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name.
20. A lineup shared by fewer than two seats, or with fewer candidates than seats.
21. A timer `reads` field absent from the kind's attribute schema.
22. A halt `limit.max` below 1.
23. A loop carry whose `initial` fails its schema.
24. A waiting state of a lane's kind that no reaction, sweep or order release can leave.
25. Two lanes of one kind sharing a supplier where one of them has no `accepts`.
26. A `Scheduler.lease` lane that is not registered.

## What changed and why

### Added

- `Lane.rename`.
- `Lane.accepts`.
- `LineupCtx.assignments` and `LineupCtx.spare`.
- `HaltOptions.limit` (`HaltLimit<D, E>`, with the exit inferred into the flow's exits).
- `HaltOptions.annotate`.
- `Scheduler.lease`, taking one or several leases.
- `Scheduler.order`.
- `Lease.holdWhileBlocked`.
- `Metrics.outcomes` with `seat` and `model`.
- `LeaseWaits.heldWhileBlockedMs`.
- Kernel `Gate` and `GateAction`, and `ModelDriver.gates`.
- `Ledger.takeLeases`.
- Ledger events `createRejected`, `decisionLimited` and `gateChecked`.
- `attemptBlocked.heldLeases`.
- Startup rules 24–26.

### Removed

- `Lane.on(halt, DecisionReaction)` and `DecisionReaction`.
- The `decisionReacted` event.
- `Lane.lease` and `Lane.after`.
- `LineupCtx.current`.
- `VendorFits` and the vendor phantoms on `Account`, `Model`, `Pool` and `Seat`.
- `ModelDriver.enforce`.
- `Guard.leaseFiles`, renamed to `exclusiveWrites`.
- `WorkspaceBackend.changedFiles`, renamed to `changedTargets`.

### Why

Each change does one of three things:
- removes an annotation, type import or seat-identity closure the scenarios were forced to write;
- repairs a named defect (the TDZ thunk, wrong success measure, dead-end state, hardcoded service);
- answers a critique (two-concept `on`, lane overload, vendor coupling, files in the driver, two locks held across a halt).

### Open

- **Known weakness 5, pool serves models.** Compatibility is now a startup check through `driver.serves` rather than a type.
- **Known weakness 8, client transport.** `ClientEndpoint.transport` is still a string. `claudeCode.session` is the entity for one session over two endpoints.
- **Known weakness 10, memory capture.** Capture still needs an author-written trigger.

## Principles broken

None knowingly.

- **Principle 15 (the ledger is the only kernel state) and blocked-attempt leases.** `holdWhileBlocked` leases are ledger state.
- **Principle 12 (waiting holds no capacity).** Waiting still holds no capacity: WIP and slots are released. A lease is a claim on a named shared resource, not capacity, and the author declares it explicitly per lease. The board shows it.
- **Principle 7 (no vendor names in `H.*`).** No adapter types name another adapter.
- **Principle 17 (human-in-the-loop) and decision bounds.** The decision bound is declared on the halt step and enforced from recorded decisions, with no ledger read in the flow.
