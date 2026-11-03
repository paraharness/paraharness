# harness-dsl: scenario-fix on the coding team (child of g02-durable-0-2-0-1--0-1-2-2)

The parent's engine is kept:
- one ledger;
- replay at zero cost;
- per-step crash rules;
- jobs collected rather than resubmitted;
- lanes as swimlanes, with named states as columns;
- classes of service;
- loop carries;
- typed facets, resource families and crossings.

The operator is **scenario-fix**. The adversary named scenario 01 (coding team) as the worst-handled scenario, with four defects. This child changes the design until 01 is handled well, and answers the three sharpest critiques.

## Execution vocabulary (one definition each)

- **Unit**: one card. It has a stable id and a `key`, and it outlives its attempts.
- **Attempt**: one pull of a unit through the lane's flow. It has exactly one outcome: `succeeded`, `failed` or `cancelled`.
  - An attempt that reaches any exit has **succeeded**, whatever state the exit sends the unit to. The attempt outcome is the harness's track record. The unit's verdict is the kind's own outcome.
  - While open, an attempt is either *running* (position `active`) or *blocked* (position `waiting`).
  - A blocked attempt holds no WIP, no runner slot and no account reservation. It keeps only leases declared `heldWhile: 'open'`.
- **Step**: a named column of a flow, and the address used by reactions, triggers, metrics and halts.
- **Invocation**: one call of an executable within a step.

"Run" is not used.

## Repairs to scenario 01 (the operator)

### 1. TDZ on `spawn`

`spawn` takes the target lane as a value. The parent hid a forward reference behind a `features()` thunk, which threw a ReferenceError on load.

- There is no cycle: the feature lane's handler is `deliver`, not `decompose`. The scenario therefore declares `featureLane` before `decompose`.
- The design states the rule: **a lane is declared before any flow that spawns into it**. A flow that spawns into its own lane is the only possible cycle, and it is expressed as a loop or a re-entry, not a spawn.
- No thunk form exists in the surface. None is needed.

### 2. The model policy measured attempt success, not kind success

`Metrics.outcomes` now accepts `seat` and `model`.

- **How a verdict is attributed.** A unit's terminal verdict is attributed to the model each seat ran in the attempt that moved the unit to the terminal state. The data comes from the `invocation` events of that attempt.
- **The builder policy now reads:**
  `ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } })`
  It returns `successRate` and `samples` by the kind's terminal verdicts (principle 18).
- **Context type.** `PolicyCtx.kind` is a `WorkRef`, so the call type-checks without a cast.

### 3. NeedsOwner was a dead end

There are two changes.

**(a) Running out of rounds asks the owner.** It no longer parks the unit in an invented state.
- After the loop, the flow asks `halt('ownerReview', ownerReview, { when: deficits remain })`.
- The decision is `accept | drop | reopen`, and it maps to three exits:
  - `shipped` → `Shipped`;
  - `dropped` → `Dropped` (neutral);
  - `reopened` → `Open`, a pending state, so a fresh attempt runs.
- Principle 12 says waiting on a human is the attempt's blocked state, recorded once. Here it is that, and the kind declares no extra state for it.

**(b) Retry exhaustion goes to an honest terminal state.** It moves to `Abandoned` (failure).

**New startup rule 24: a waiting state no one can leave is a startup error.** A waiting state reachable from an exit, a retry exhaustion or an order hold is *live* only if at least one of these holds:
- a signal reaction of the lane can apply to it;
- a sweep trigger names it;
- it is the `onPredecessorFailed` state of a `Scheduler.order`, which the kernel releases on the predecessor's success;
- a registered client holds `H.ops.workMove`.

`H.ops.workMove` is a new operation. It moves a unit from a waiting state to a pending or terminal state of its kind, recorded as a `transition` with `by`.

### 4. The heartbeat probed one hardcoded service

There is no surface change. The clock route creates one unit per declared service: `serviceName.options.map(service => to.create({ service }))`. This is the same form scenario 04 uses.

## Repairs to the three sharpest critiques

### Critique 1: the inference audit was false

The critique is right. The audit is corrected and the code is changed where the cause was the surface.

- **Lineup.** The thunk-like seat comparison (`seat === reviewerA ? opus : sonnet`) is gone.
  - Before any decision is recorded, the kernel assigns `candidates[i]` to the i-th sharing seat in seat-name order. `LineupCtx.current(seat)` therefore always returns a `Model<V, B>`, never `undefined`.
  - `LineupCtx<V, B>` carries `candidates`.
  - `choose` is written inline. Its context type and its return type (`Assignment<V, B>[]`) are inferred.
  - Scenario 06 no longer imports `LineupCtx` or `Assignment`, and no policy references a seat declared below it.
- **Scenario 01's `features()` thunk** is removed (repair 1).
- **What remains, stated honestly.** The remaining annotations are parameter types on plain helper functions that TypeScript requires:
  - in scenario 11, `contractLane(name, region, retry)` uses the `Retry` type and a region union derived from the schema;
  - in scenario 12, `previousMigration(id: string)`.

  A helper that builds two lanes from one definition needs its parameters typed. No other annotation, `satisfies`, `as const` or explicit type argument remains.

### Critique 2: `Lane.on` named two concepts; the lane carried ten concerns; a decision reaction gave two records of one event

**Decision reactions are removed.** `Lane.on` means signals only. The bound on counsel returns moves to where it belongs: the exit.

```
.exit('returned', {
  when: ctx => ctx.steps.counsel.verdict === 'return',
  update: ctx => ({ counselNotes: [...ctx.unit.attributes.counselNotes, ctx.steps.counsel.notes] }),
})
...
exits: { returned: { to: Returned, bound: { times: 2, to: Declined } } }
```

- **What the kernel counts.** It counts exits per unit (`UnitRecord.exitCounts`, derived from `attemptEnded.exit`). The n-th time an exit is taken, where n equals `times`, the unit goes to `bound.to` instead of `to`.
- **One record per meaning.** The attempt reached an exit, so it **succeeded**. The unit's verdict (Declined, failure) records the kind's outcome. There is no cancellation and no double record, so the meaning of attempt outcome stays single (principle 22).
- **Exit `update`.** It writes `Partial<In>` onto the unit's attributes, recorded as `attributesUpdated`. The next attempt reads the notes from its attributes, with no ledger read in the flow.

**The lane is down to seven concerns:** kind, supply, handler (flow, exits, params), store, retry, ceiling and signal reactions.

`lease` and `after` moved to the scheduler, as `Scheduler.lease(lane, pick)` and `Scheduler.order(lane, { after, onPredecessorFailed })`. Leases and ordering decide *what may start now*, and that is the scheduler's pillar (principle 16).

**The adversary's scenario 13** is now expressible:
- `pick` returns `Lease | readonly Lease[]`, and the leases are acquired atomically (`Ledger.takeLeases`).
- `Lease.heldWhile: 'open'` keeps a lock through a blocked attempt, while WIP and slots are still released.
- `Metrics.leases` reports `heldWhileBlockedHours`.

### Critique 3: vendor strings coupled subpaths; files leaked into the kernel driver

**The vendor phantom is now each adapter's own literal.**
- `claude-code` yields `Account<'claude-code'>` and `Model<'claude-code', false>`.
- `claudeCode.apiKey(...)` exists because the Claude Code driver can run on an API key. Scenario 01's fallback uses it.
- `anthropic` yields `Account<'anthropic'>` and `Model<'anthropic', true>`.
- Deleting either subpath leaves the other's types intact (principle 6). The kernel only knows that the vendor is a string.

**Guards no longer live in the driver contract.**
- `ModelDriver.enforce('leaseFiles' | 'beforeStop')` is removed.
- In its place, `ModelRequest.guard?: SessionGuard` offers `beforeAction({ intent, target })` and `beforeStop()`.
- A driver advertises `honorsGuards`. Drivers that never touch a workspace set it to `false` and implement nothing.
- `Workspace.guard({ leaseEdits, beforeStop })`: `leaseEdits` refuses an `edit` action whose targets (from `WorkspaceBackend.targetsOf`) another open attempt has edited. The kernel speaks of intents and targets, not files.
- Startup rule 11 now reads: a guarded workspace on a seat whose driver has `honorsGuards: false`.

## Entities

**Kinds** (pure vocabulary, no backend):
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

**Pivots:**

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × handler (flow, exits with bounds, params) × retry × ceiling × signal reactions | a swimlane of managed units |
| Seat | role × model choice × pool × workspace × raisable halts | a model-call executable |
| Lineup | sharing seats × candidate models × joint choice policy | distinct model assignments |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission × leases × order | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Lifecycle (principle 12)

- **States.** `H.state(name, 'pending' | 'waiting')` and `H.terminal(name, verdict)` declare states. A verdict has no default.
- **No active states.** A kind declares none. An active unit's place is its attempt's current step.
- **Where an ending attempt leaves the unit:**
  - **Exit.** The lane's exit map sends it to a state of the kind, optionally with a `bound`.
  - **Failure.** A failed attempt returns the unit to pending under the lane's `retry`. When retries are exhausted, the unit moves to `retry.exhausted`.
  - **Signal reaction.** A reaction with `enter` cancels the open attempt and moves the card.
- **Dead ends.** A waiting state no one can leave fails `start()` (rule 24).

## Startup validation

`start()` fails, before any supplier starts, on any of:

1. Two descriptors with one name in an entity sort.
2. A lane with no `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state or bound state outside the kind, a flow path reaching no exit, or a `bound.times` below 1.
4. A kind whose `initial` state is missing.
5. A lane in no class of service, or in two.
6. A lane, journal or metric referenced by a trigger, scheduler entry, spawn or WIP group but not registered.
7. A signal routed or triggered into a lane without a reaction, or `workCancel` granted on a lane without a cancel reaction.
8. A reaction `at` or `restart` naming a missing step.
9. A seat without a pool.
10. An `H.batch` on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A guarded workspace on a driver with `honorsGuards: false`.
12. A grant naming a halt no flow, seat or ceiling uses.
13. A halt policy whose halt or kind differs from its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet named like a column, or with no values.
17. `Scheduler.order` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name.
20. A lineup shared by fewer than two seats, or with fewer candidates than seats.
21. A timer `reads` field absent from the kind's schema.
22. A `Scheduler.lease` or `Scheduler.order` on an unregistered lane, or two lease declarations for one lane.
23. A loop carry whose `initial` fails its schema.
24. A reachable waiting state that no reaction, sweep, order release or `workMove` grant can leave.

## What changed and why

### Added

- `Metrics.outcomes({ seat, model })`, with verdict attribution to the ending attempt.
- `ExitTarget` with `bound`; `Flow.exit(name, { when, update })`; `UnitRecord.exitCounts`; `attemptEnded.exitCount` and `bounded`.
- `Scheduler.lease` (one lease or several, `heldWhile`) and `Scheduler.order` (`after`, `onPredecessorFailed`).
- `Ledger.takeLeases`; `LeaseRequest`; the `orderReleased` event; `LeaseWaits.heldWhileBlockedHours`.
- `H.ops.workMove`, and `transition.by`.
- `LineupCtx<V, B>` with `candidates`; `current` that always returns a model; the initial assignment rule.
- `claudeCode.apiKey`.
- `SessionGuard`, `SessionAction`, `ModelDriver.honorsGuards`, `WorkspaceBackend.targetsOf`, `Guard.leaseEdits`.
- Startup rules 22 and 24.

### Removed

- `Lane.on(halt, DecisionReaction)`, `DecisionReaction`, the `decisionReacted` event and `UnitRecord.decisionMatches`.
- `Lane.lease` and `Lane.after`, moved to the scheduler.
- `ModelDriver.enforce` and `Guard.leaseFiles`.
- The cross-adapter vendor literal in `claude-code`.

### Why

Each change repairs one of three things:
- a named defect of scenario 01: TDZ, wrong success measure, dead end, or hardcoded service;
- the three sharpest critiques;
- the inexpressible scenario 13: multi-resource locks held through a halt.

### Open

- **Pool serves models (weakness 5).** It is type-checked through each adapter's own vendor.
- **Memory capture still needs an author-written trigger (weakness 10).**
- **Mapping edit targets to resources (weakness 4)** lives in the workspace backend.

## Principles broken

None knowingly.

- **Attempt outcome (principle 12).** An attempt that reaches an exit has succeeded even when the unit's verdict is failure (for example, Declined after a bound). This is principle 12's separation of track record from the kind's outcome, not a second record of one event.
- **Seats and agents (principle 8).** A seat with a fixed model is the principle's agent. A lineup is a seat's choice policy shared across seats, and it earns its place in scenario 06.
