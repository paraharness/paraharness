# harness-dsl: the rename pass, Lineup → Panel (child of g02-durable-0-2-0-1--0-1-2-2)

The parent's engine is unchanged:
- one ledger;
- replay at zero cost;
- per-step crash rules;
- jobs collected rather than resubmitted;
- lanes as swimlanes, with named states as columns outside the flow;
- classes of service.

This child applies one operator, **rename**. It finds the weakest noun in the parent and gives it the right one. It also answers the adversary's three sharpest critiques, its worst-scenario findings and its scenario 13.

## The rename: Lineup becomes Panel

**Why `lineup` was the weakest noun.**
- `H.policy.lineup(name, candidates, choose)` was filed under policies, but it was named after its output.
- What it actually governed was a set of seats of one role that share a pool of candidate models and must hold distinct ones. It did not own those seats.
- Each seat opted in with `.model(lineup)`. The policy then had to:
  - find the seats at startup;
  - be handed `LineupCtx` and `Assignment` types the author imported by name;
  - fall back to `seat === reviewerA ? opus : sonnet` for its first assignment. That is a closure over a seat declared later in the file, which is the rival-seat thunk under another name.
- A noun that cannot name what it owns is the absence of a concept (principle 9).

**The right noun is Panel.** A panel is a pivot (principle 8): role × seat names × candidate models × pool × choice policy. It produces seats whose models are compared side by side and kept distinct.

```
const reviewers = H.panel('reviewers', reviewerRole)
  .seats('reviewer-a', 'reviewer-b')
  .candidates(opus, sonnet, haiku)
  .pool(reviewPool)
  .output(critique)
  .choose(ctx => …ctx.swap(weakest, spare) or ctx.keep());
const reviewerA = reviewers.seat('reviewer-a');
```

How the panel works:
- **Seats come from the panel.** No seat refers to another seat or to the policy. The seat names are a literal union `K`, so `seat('reviewer-c')` is a type error.
- **Initial assignment is positional.** Seat *i* starts on candidate *i*, so the policy needs no fallback and no closure.
- **The choice context is typed by the panel.**
  - `ctx.current` is `{ [seat in K]: Model<V, B> }`.
  - `ctx.seat(name)` gives the `SeatRef` that metrics key on.
  - `ctx.swap(seat, model)` and `ctx.keep()` build the result.
  - Everything is inferred inline, with no imported type and no annotation.
- **Distinctness.** The kernel checks it and records a rejected change on `policyDecision.rejected`. When it rejects a change, it keeps the current assignment.

**What stays the same.**
- `H.seat` stays for a single seat. With a fixed model it is principle 8's *agent*. With `H.policy.model` it is a seat whose model a deterministic policy picks at attempt time.
- Metrics still key on the seat (`reviewers.seat('reviewer-a')`), so a model swap never breaks a series.

**What it removes:** `Lineup`, `LineupCtx`, `Assignment`, `H.policy.lineup`, and the `Seat.model(lineup)` overload.

**What it adds:** `Panel`, `PanelCtx`, `PanelChange` and `H.panel`. The surface is net smaller by one type.

## Execution vocabulary (one definition each)

- **Unit**: one card.
  - It has a stable id and a `key`.
  - At most one non-terminal unit per lane holds a key.
  - It outlives its attempts.
- **Attempt**: one pull of a unit through the lane's flow.
  - It ends with exactly one outcome: `succeeded` (the flow reached an exit), `failed` (a step failed beyond its step retry), or `cancelled` (a signal or the operator ended it).
  - While open it is either *running* (position `active`) or *blocked* (position `waiting`).
  - A running attempt holds WIP, runner slots, account reservations and leases.
  - A blocked attempt holds none of these, except leases declared `hold: 'attempt'`.
- **Step**: a named column of a flow. Its name is the address used by reactions, triggers, metrics and halts.
- **Invocation**: one call of an executable within a step.

"Run" is not used.

## Lifecycle (principle 12)

- **States.** `H.state(name, 'pending' | 'waiting')` and `H.terminal(name, verdict)` declare states. The verdict has no default. A kind declares no active states.
- **Exits.** The lane's exit map sends each flow exit to a state of the kind. An exit is either a state or an **exit rule**:
  ```
  exits: { returned: { to: Returned, update: (a, steps) => …, limit: { count: 2, then: Declined } } }
  ```
  - `update` writes attributes as the unit leaves. It is recorded as `attributesUpdated`.
  - `limit` counts how often this exit has been taken over the unit's whole life. The count is kept in `UnitRecord.exitsTaken`, derived from `exitApplied`. When the count reaches `count`, the unit enters `then` instead of `to`.
- **Failure.** A failed attempt returns the unit to pending under the lane's `retry`. When retries are exhausted, the unit moves to `retry.exhausted`.
- **Signals.** `Lane.on(signal, reaction)` is the only `on`. A reaction may update attributes, restart the flow at a step, or enter a state. `enter` cancels the open attempt, with outcome `cancelled`.

## Answers to the adversary

### Critique 1: the inference audit was false

The claim "nothing else" is withdrawn.

Fixed:
- Scenario 06's imports of `LineupCtx` and `Assignment`, its annotated helper, and the seat-identity closure are gone: the panel's `choose` is inline and fully inferred.
- Scenario 01's `features()` thunk was a TDZ defect, not a type issue. The feature lane does not depend on `decompose`, so it is declared before the epic flow that spawns into it. No thunk remains anywhere.

What remains, stated honestly:
- Plain helper functions keep their parameter annotations, which TypeScript requires. Scenario 11's per-region lane factory keeps `(name: string, laneRegion: …, retry: Retry)`.
- Importing a kernel shape type (`Retry`) to annotate such a helper is part of that same category. A shared descriptor is one honest way to make two lanes differ only in retry.

The audit now lists exactly this category and nothing else.

### Critique 2: `Lane.on` named two concepts; the lane had ten concerns; one event was recorded twice

- **`on(halt, DecisionReaction)` is removed.** Its two jobs were carrying counsel notes and bounding returns. Both are properties of *leaving through an exit*, so they become the exit rule's `update` and `limit`.
- **`on` now has one meaning:** a signal arrived.
- **The double record is gone.** Under the parent, a second counsel return cancelled the attempt and gave the unit a failure verdict. Now the attempt reaches exit `returned`, so its outcome is `succeeded`: the flow did its work, the agent did not fail. The exit limit sends the unit to Declined, a failure. Attempt outcome measures execution, and the unit's verdict measures the work. Each has one definition (principle 22).
- **The lane's concerns** drop from ten to nine: kind, suppliers, store map, flow with exits and params, retry, leases, order, ceiling, signal reactions. Every one of them answers "what happens to a card in this swimlane". The ones the critique called foreign (lease, order, ceiling) are admission rules the scheduler reads per lane. Splitting them into a separate pivot would give each lane a one-use entity (principle 21). This is argued, not hidden; see Open.

### Critique 3: vendor strings coupled subpaths; a file concept sat in the kernel's driver contract

- **No vendor literal crosses a subpath.** Each adapter brands only its own accounts and models:
  - `claude-code` uses `'claude-code'`. It ships `claudeCode.apiAccount` for a pool that falls back from subscriptions to an API key.
  - `anthropic` uses `'anthropic'`.
- **One API key can back both.** It becomes two account descriptors with distinct names over one quota partition.
- **Deleting a subpath** leaves the other subpath's types intact (principle 6).
- **`ModelDriver.enforce(guard: 'leaseFiles' | 'beforeStop', …)` is removed.** Two things replace it:
  - A driver declares `readonly workspaces: boolean`.
  - A request to a seat with a workspace carries `WorkspaceGuardHooks { path, beforeWrite, beforeStop }`. These are kernel callbacks the driver calls.
- **Drivers without workspaces.** Drivers in scenarios 2 and 4 set `workspaces: false` and implement nothing about files. A seat or panel with a workspace whose model's driver declares `workspaces: false` is a startup error.

### Worst scenario (01)

- **TDZ:** fixed by declaration order, as described under Critique 1.
- **Wrong success:** `Metrics.outcomes` now accepts `seat` and `model`.
  - An outcome is attributed to the seat and model of the attempt that moved the unit to its terminal state.
  - The builder policy reads `outcomes({ of: ctx.kind, seat, model: sonnet, window: { lastDays: 14 } })`, with `samples` beside `successRate` (principle 18).
  - `PolicyCtx.kind` is now a `WorkRef`, so it can be passed straight to `outcomes`.
- **Dead-end NeedsOwner:** new startup rule 24 forbids a waiting state that nothing leaves. A waiting state must be left by a signal reaction, a sweep, an exit `then`, or a trigger. Scenario 01 gets an `owner-replied` signal granted through `workSignal`.
- **Hardcoded service:** the heartbeat clock route maps over the service enum, one unit per service.

### The adversary's scenario 13: two locks, held across a halt

- **Two resources at once.** `Lane.lease` returns `Lease | readonly Lease[]`. The kernel takes the set atomically (`Ledger.takeLeases`, one `leasesTaken` event) or waits.
- **Holding across a block.** `Lease.hold` is `'running'` (the default: released when the attempt blocks, retaken on resume) or `'attempt'` (held from first step to attempt end, including while blocked).
- **Capacity while blocked.** A blocked attempt still holds no WIP and no slot.
- **Metric.** `LeaseWaits.heldWhileBlockedMs` gives the lock-held-while-waiting figure.

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

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow (exits, params) × retry × leases × order × ceiling × signal reactions | a swimlane of managed units |
| Seat | role × model or model policy × pool × workspace × raisable halts | a model-call executable (an *agent* when the model is fixed) |
| Panel | role × seat names × candidate models × pool × choice policy | seats with distinct models, compared side by side |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Trigger sources (all from recorded ledger events)

- `transition`
- `pattern`
- `timer` (with declared `reads`; it re-arms on change)
- `sweep`
- `step`
- `decision`
- `invocation`
- `crossing` (hysteresis, once per crossing, optionally per facet)

## Unchanged from the parent

- **Halts:** a halt entity versus its flow address; `when`, `skip`, `timeout` and `escalate`; grants name halts.
- **Jobs:** they hold no capacity and are collected on restart.
- **Quota:** quota partitions on accounts, with per-harness share caps.
- **Order:** `Lane.after`.
- **Restart:** a writer claim; `afterCrash` with `rerun`, `park` or `askDriver`; `alreadyDone`; `definitionChanged` parking.
- **Loops:** loops with carries.

## Startup validation

`start()` fails, before any supplier starts, on any of:

1. Two descriptors with one name, within an entity sort.
2. A lane with no `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state (`to` or `limit.then`) outside the kind, or a flow path that reaches no exit.
4. A kind whose `initial` state is missing.
5. A lane in no class of service, or in two.
6. A lane, journal or metric referenced but not registered.
7. A signal routed or triggered into a lane without a reaction, or `workCancel` granted on a lane without a cancel reaction.
8. A reaction `at` or `restart` naming a missing step.
9. A seat or panel without a pool.
10. `H.batch` on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A seat or panel with a workspace whose models' driver declares `workspaces: false`.
12. A grant naming a halt that nothing uses.
13. A halt policy whose halt or kind differs from its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet named like a column, or a facet with no values.
17. `Lane.after` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name.
20. A panel with fewer than two seats, or fewer candidates than seats.
21. A timer `reads` field absent from the attribute schema.
22. An exit `limit.count` below 1, or a `limit.then` equal to its `to`.
23. A loop carry whose `initial` fails its schema.
24. A waiting state that no signal reaction, sweep, trigger or exit rule leaves.
25. A lease set naming one resource twice.

## What changed and why

### Renamed

- `Lineup` → `Panel`, from a policy to the pivot that owns its seats (see "The rename").

### Added

- `H.panel`, `Panel`, `PanelCtx`, `PanelChange`.
- `ExitRule` and `Exits`, with exit `update` and `limit`.
- `Lease.hold` and `LeaseHold`.
- Multi-resource `Lane.lease`.
- `Ledger.takeLeases`, with ledger events `leasesTaken` and `exitApplied`.
- `LeaseWaits.heldWhileBlockedMs`.
- `seat` and `model` filters on `Metrics.outcomes`.
- `ModelDriver.workspaces` and `WorkspaceGuardHooks`.
- `claudeCode.apiAccount`.
- `UnitRecord.exitsTaken` and `StoredAttempt.leases`.

### Removed

- `Lineup`, `LineupCtx`, `Assignment`, `H.policy.lineup`.
- `Seat.model(lineup)`.
- `Lane.on(halt, …)` and `DecisionReaction`.
- `ModelDriver.enforce`.
- `decisionReacted`, `UnitRecord.decisionMatches`, `takeLease`, `leaseTaken`.
- `ModelPolicy.choice`.
- The cross-subpath vendor literal.

### Why

Each change repairs a named defect:
- the rename fixes the weakest noun;
- the exit rule fixes the two meanings of `on` and the double record;
- the vendor and driver changes fix the subpath coupling and the file concept in the kernel;
- outcome filters and rule 24 fix the worst scenario;
- lease sets and holds fix scenario 13.

### Open

- **The lane still carries nine concerns.** This child argues they all belong to one swimlane. A future split into a separate "admission" noun (lease, order, ceiling) is possible if the battery ever shares those across lanes.
- **Pool serves models (known weakness 5).** It is type-checked through vendor brands, and the driver still decides.
- **Memory capture still needs an author-written trigger (known weakness 10).**

## Principles broken

None knowingly.

- **Principle 8.** It names *seat* and *agent*. Here an agent is a seat with a fixed model, written with `H.seat`. A panel is the seat pivot widened to several seats of one role whose choice policy is joint. It has a noun (principle 9) and appears only where models are compared side by side (scenario 6).
- **Principle 12.** The exit rule leaves it intact: failure still goes through the lane's retry and `exhausted`, and the kind declares nothing about failure.
