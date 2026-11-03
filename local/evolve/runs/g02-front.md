# Generation 2 front

- g02-minimal-0-2-2--2-2-1-0 (minimal-0-2-2, rename, pareto): bt 1.2653, compile errors 0, escapes 0, any-in-dts 0, surface 225, coverage 12/12, cannot: none, strikes: none
- g02-minimal-0-2-2--2-2-1-2 (minimal-0-2-2, surface-cut, pareto): bt 0.9078, compile errors 0, escapes 0, any-in-dts 0, surface 220, coverage 12/12, cannot: none, strikes: none
- g02-durable-0-2-0-1--0-1-2-2 (durable-0-2-0-1, inference, by rank): bt 0.6204, compile errors 0, escapes 0, any-in-dts 0, surface 401, coverage 12/12, cannot: none, strikes: none
- g01-durable-0-2-0-1--2-0-1-2 (durable-0-2-0-1, lens, by rank): bt 0.5665, compile errors 0, escapes 0, any-in-dts 0, surface 350, coverage 12/12, cannot: none, strikes: none

## Critiques

### g02-minimal-0-2-2--2-2-1-0

## 1. Worst scenario: 10, the power goes off

- **The batch is a fake model.** `const batchSonnet = apiModel('claude-sonnet-4-5-batch')` invents a model id so that `ctx.batch(summarizer, …)` has a model with `submit`/`collect`. Batch-ness is a call mode of a real model, not a separate model. A metric on "sonnet" now splits into two series, so the same model's track record is broken in two.
- **Which pool serves which model is guesswork.** The harness registers `release-claude-pool` and `release-api-pool`, and nothing says which serves `sonnet` and which serves `batchSonnet`. The design lists "a seat model … that no pool serves" as a startup error, but `H.pool(name, members, policy?)` has no way to declare what a pool serves. That check cannot be computed, so the account a crash-recovered `review` reconnects through is undetermined.
- **The batch has to be unpacked by hand.** The flow writes `summaries[0] === undefined` to read a one-item batch. That is a batch standing in for a submit-and-collect model call.
- **The recovery probe has no recovery of its own.** `wasAnnounced` is itself a command with no `.recovery`. If the crash lands during the probe, the behaviour is unspecified.

## 2. New scenario: confidential lanes

### Scenario 13: confidential lanes

A legal-ops harness. It has kinds `PublicFaq` and `PrivilegedMemo` and two accounts:

- a shared Claude subscription pool;
- a zero-retention API account under a DPA.

#### Must express

- `PrivilegedMemo` invocations must never be served by the subscription pool, whatever its eligibility. `PublicFaq` drains the subscription first and falls back to the API account.
- One seat, `drafter`, serves both kinds. Its model policy picks between `sonnet`, which both accounts serve, and `opus`, which only the API account serves.
- Startup fails if `opus` is chosen for a kind whose permitted accounts do not serve it.
- Telemetry reports cost per account per kind, with sample counts.

#### Hostile aspects

- The account choice depends on the unit's kind and on the model.
- Model availability is a property of the pool.

This variant cannot express it:

- `AccountChoice` is `{ accounts }`, with no kind, seat or model in it.
- `H.pool` declares no models.
- The only workaround is two seats per kind and an author-side convention, which is a lie about one seat.

## 3. Three sharpest critiques

1. **The pool × model pivot is missing, which is a hidden coupling (principles 8, 9 and 16).**
   - Pools carry accounts and a policy but no models. Seats carry models but no pool.
   - The kernel must therefore match `Model.provider` against `Account.provider` strings. That is an unnamed relationship resolved by string equality, and it is the "pool serves" question the seed left open, now answered silently.
   - `AccountPolicy` cannot see what is being served (see scenario 13).

2. **Seat identity is smuggled through decision fields (principles 8 and 18).**
   - Scenario 6 encodes "which reviewer the editor acted on" as `actedOnA: z.boolean()` / `actedOnB` in the halt's decision schema. It is queried with `editorial.resolved({ actedOnA: true })` via `EntryFilter.decision: Record<string, unknown>`.
   - The seat is a typed ledger column, yet the metric that drives the A/B keys on a field name that merely mentions the seat. Renaming `reviewerA` breaks nothing at startup and silently orphans the series.
   - Both `reviewerModel` policies fall back to the same `spare` model. The two "different models" in one flow can therefore converge, and nothing checks for it.

3. **Moving a unit mid-attempt is undefined, and state and position disagree (principle 12).**
   - `UnitActions.move` is used on units with live attempts in four places:
     - `slaBreach`, `whileIn ['new']`, while the attempt is blocked on `approval` (scenario 2);
     - `approvalWindowCloses`, `whileIn ['loadDue']`, during `loadApproval` (scenario 5);
     - `act.move(auditLane, …, 'audit-cancelled')` on an Audit blocked on `auditFindings` (scenario 9);
     - `negotiationExpiry` (scenario 8).
   - Nothing says whether this cancels the attempt. `cancelledBy: 'trigger'` implies it may, but rule 1 only lists it.
   - The trigger matches on state `new`, declared `pending`, while the board shows the unit at `waiting`. One unit has two answers to "where is it".
   - Separately, `tenancyLane.retries(3, { exhausted: 'review-stalled' })` exhausts into a *waiting* state that nothing ever wakes: a declared dead end. Startup accepts it because the design only checks that the `exhausted` state belongs to the kind, never what position it has.

**Bonus, principle 22.** `retries` names two different policies:

- `Lane.retries(n, {exhausted})` re-runs attempts and moves the unit.
- `Command.retries(n, backoff)` re-runs invocations inside one attempt.

They share one word with different scope, different bounds and different recovery.

### g02-minimal-0-2-2--2-2-1-2

## 1. Worst scenario: 9 (a harness watching itself)

- **SLA extension can fire the old deadline.** Rule 2 defers any patch to a unit with a live attempt at `active` until the attempt ends. The reviewer extends the SLA through `H.ops.writeWork` → `work.update(key, { slaDue })`. If the conversation is drafting, the patch waits. Meanwhile `H.on.deadline(conversation, data => new Date(data.slaDue), [...])` keeps reading the old `slaDue` and fires `sla-breach`. The scenario says "the old deadline never fires". The variant's own deferral rule breaks that, and nothing re-arms a deadline when its input changes.
- **`sent` is a dead end.** `H.state('sent', 'waiting')` has no wake, timer or exit. Every answered conversation sits at `waiting` on the board forever.
- **`escalated` has two verdicts.** It is `'neutral'` here and `'failure'` in scenario 2, for the same harness.
- **"Audits opened" counts trips, not audits.** The count uses `count({ of: { entry: 'firing', trigger: approvalRateAudit, status: 'tripped' } })`. `FiringEntry.status` is one field holding `'tripped' | 'deduped'`. A trip whose `create` was deduped is either counted as an opened Audit or hidden as a non-trip. Which one is unspecified.
- **Human rejection counts as a failed attempt.** `if (!decision.approved) return 'needs-human'` is fine. But scenario 2's twin uses `return ctx.fail('reply rejected by reviewer')`. That retries the lane twice, re-drafting and re-asking the human, then exhausts to `escalated`. The metric source becomes ambiguous.

## 2. New scenario: release train with a deploy window

Kind ReleaseTrain, supplied by the operator, stored in the harness store. Its flow:

- `build`: a command running 2 hours. Up to 6 trains build concurrently.
- `deploy`: takes an exclusive lease on resource `production` for its few minutes only.
- `verify`: a command.

Ten trains may build at once, but only one may deploy at a time. A train waiting for `production` holds no build runner slot. Metrics: lock wait on `production` per train, with sample counts.

The variant cut `Command.locks` and put all locks on `lane.locks(data => Lock[])`, "held from before the attempt starts until it ends". Declaring `production` on the lane serializes every two-hour build. Not declaring it lets two deploys overlap. The only escape is to split one unit of work into two kinds and two lanes (BuildTrain spawns DeployTrain). That is a lie about the unit's identity, and its metrics split across two kinds.

## 3. Sharpest critiques

1. **`handler(flow, { retries, exhausted })` forces invented dead-end states.** `exhausted` must be a state of the kind, so authors mint parking lots with no exit:
   - `analysis-stalled`, `review-stalled`, `negotiation-stalled` and `audit-stalled` are all `'waiting'` positions that nothing leaves.
   - `retries: 0, exhausted: 'unhealthy'` appears where retry is meaningless.

   This is exactly the "invented states that loop or dead-end" failure that principle 12's amendment cites. Making the bound mandatory traded an unbounded loop for an unbounded wait. The handler options now carry three unrelated concerns (retry, end state, params), which worsens known weakness 6.

2. **Human decisions are routed through `ctx.fail`.** Examples:
   - Scenario 2: `ctx.fail('reply rejected by reviewer')`.
   - Scenario 4: `ctx.fail(confirmation.note)` after an unresolved incident.

   A human "no" becomes a failed attempt. The lane retries it: scenario 4's `retries: 2` re-runs `page-on-call` and re-pages on-call. The rejection also lands in the track record of models and seats (principle 12: metrics on models and agents come from attempt outcomes). The kernel offers no way to end an attempt on a human verdict without inventing a terminal state or lying with `failed`.

3. **`H.library` has no recall policy.** Principle 8 defines journal = memory kind × store × **recall**. Principle 14 makes recall a deterministic policy ranked by specificity and track record. In this variant:
   - `H.library(n, memory, store)` and `seat.recalls(...libraries)` have no slot for recall.
   - Scenario 3's "recall by semantic similarity" is invisible: the only trace is `qdrant.memory({ embedder: 'text-embedding-3-small' })`, and the ranking lives inside `MemoryStore.search`.

   Recall has moved from a kernel policy into a backend. This breaks principles 4 and 5: the store decides what a call remembers.

**Further hidden coupling (scenario 6).** The editorial halt's decision schema hard-codes `actedOnA` and `actedOnB`, so the halt knows the seats' slot positions. Each reviewer's model policy compares `rateBy(...).of(incumbent)` for itself against an unkeyed `rate(...)` for the other seat. After a swap, the incumbent's frozen samples keep deciding.

### g02-durable-0-2-0-1--0-1-2-2

## 1. Worst scenario: 01 coding team

- **The file throws on load.** `decompose` calls `.spawn('features', features(), …)` at definition time. `function features() { return featureLane; }` reads `const featureLane` before it is initialized, so the module raises a ReferenceError (TDZ) before `start()` runs. This is the "forward-reference thunk" the design claims to have removed, and it is now a runtime defect instead of a type annotation.
- **The model policy measures the wrong success.** `builderModel` reads `ctx.metrics.attempts({ of: ctx.kind, … }).successRate`. That is the attempt outcome rate. The scenario asks for success "on this kind of work", and principle 18 defines success by the kind's terminal states (`metrics.outcomes`). An attempt that ends at exit `unfinished → NeedsOwner` counts as succeeded.
- **NeedsOwner is a dead end.** It is a `waiting` state reached by `unfinished` and by `retry.exhausted`. The `bugs` and `featureLane` lanes declare no `.on(...)` reaction, signal or halt that leaves it. Principle 12's amendment exists to forbid exactly these invented dead-end failure states.
- **The heartbeat probes one service.** It is hardcoded: `to.create({ service: 'payments-api' })`. The kind's `service` attribute is decorative.

## 2. New scenario: cross-database copy under a held lock

**Scenario 13: archive copy with a held lock**

Kind ArchiveCopy, supplied by the operator. Its flow:
1. `snapshot` (command) reads table T from database `orders`.
2. Halt `confirm`: a DBA checks the row counts.
3. `write` (command, wrong to repeat) inserts into database `archive`.

The copy holds a **shared** lock on `orders` and an **exclusive** lock on `archive`, acquired together. The locks are held from `snapshot` through `write`, **including while the attempt is blocked on `confirm`**, because a migration landing between snapshot and write corrupts the archive. While blocked, the attempt holds no WIP and no runner slot.

Metrics: lock wait per database, and lock-held-while-waiting hours.

**Why this variant cannot express it:**
- `Lane.lease(pick: (unit) => Lease)` returns one `Lease`, so the two-resource acquisition has no expression.
- design.md says a blocked attempt is "holding nothing". It is defined as holding "WIP, slots, leases and account reservations" only while running, so the lock is released at `confirm`.
- The only workaround is to fold both databases into one fake resource: a string standing in for an entity, or a lie about which lock is held.

## 3. Sharpest critiques

1. **The inference audit is false on its own scenarios.** It ends "Two kinds of annotation remain… nothing else". Yet the scenarios contain:
   - in 06: `import { H, LineupCtx, Assignment }`, `function chooseReviewerModels(ctx: LineupCtx): readonly Assignment[]` and `const current: readonly Assignment[]`;
   - in 11: `import { H, type Retry }` and `laneRegion: 'eu' | 'us'`;
   - in 01: the `features()` thunk.

   Lineup also couples to seats by identity inside the policy (`seat === reviewerA ? opus : sonnet`). That is the rival-seat thunk the redesign claimed to eliminate, moved into a closure that references a seat declared below it.

2. **`Lane.on` names two concepts, and the lane has ten concerns.**
   - `on(signal, SignalReaction)` and `on(halt, DecisionReaction)` share one verb but have different fields (`restart/at` versus `when/count`) and different semantics.
   - The design admits that a decision reaction ending at `Declined` records the attempt as `cancelled` while the unit's verdict is `failure`: "two records of one event". Principle 22's single meaning of attempt outcome is broken.
   - The lane is kind × suppliers × store map × flow × params × retry × lease × order × ceiling × reactions. Known weakness 6 got worse, not better.

3. **Vendor strings couple subpaths and leak into kernel shapes (principles 5, 7).**
   - `claudeCode.model(...)` returns `Model<'claude-subscription' | 'anthropic-api', false>`, so the claude-code subpath hardcodes the anthropic subpath's vendor literal. Delete `harness-dsl/anthropic` and the claude-code types still name it.
   - The kernel's `ModelDriver.enforce(guard: 'leaseFiles' | 'beforeStop', …)` and `Guard.leaseFiles` put a file/worktree concept into the kernel driver contract. Scenario 2 and scenario 4 drivers must implement `enforce` for files they never touch.
   - Startup rule 11 ("a workspace guard the driver cannot `enforce`") makes the coupling official.

### g01-durable-0-2-0-1--2-0-1-2

## 1. Worst-handled scenario: 1, coding team (the founding scenario)

The build-and-audit loop is the core of the scenario, and the variant cannot feed the auditor's deficits back to the builder.

- **The builder never sees the deficits.** The builder's `task` in round N reads only `ctx.unit.attributes` and `ctx.iteration`. Yet `builderRole.instructions('…Address every deficit the auditor listed in earlier rounds.')` promises otherwise. The prompt says one thing and the types forbid it.
- **The design admits it.** Under Open it says: "In scenario 1, the builder learns the auditor's deficits from the attempt's session and memory." In practice that means the vendor session state or journal writes. Hidden state in a driver session breaks principle 1, and recording round-local deficits as memory breaks principle 14 (memory is forward-phrased, not history).
- **The loop runs on steps it cannot pass forward.** `until: ctx => ctx.steps.audit.deficits.length === 0` reads the audit output, but the next `build` cannot.
- **Smaller wounds in the same file:**
  - "Heartbeats first" is written as `.standard(heartbeatLane, …)` here but `.expedite(heartbeats)` in scenario 7, so the battery has two encodings of one requirement.
  - `.share(subscriptionC, 0.3)` beside two shares of 0.5 is never explained.
  - Bugs filed by the heartbeat trigger go through `create` into the Linear store. That works, but nothing types or checks it.

## 2. New scenario: Grant application, bounded returns across re-entry

- **Kind and flow.** Kind `Application`, supplied by webhook. Flow: `assess` (agent), halt `panel`, `notify` (command, wrong to repeat).
- **Returns.** The panel may return the application with notes, at most twice over the unit's whole life. The third return ends in `Rejected`, a failure.
- **Applicant revisions.** The applicant may submit a revision at any time. A revision during `panel` re-enters at `assess`, and that re-entry does **not** reset the return count.
- **Prompt content.** Each `assess` prompt must contain every prior panel note, verbatim.
- **No ledger reads.** The flow reads nothing from the ledger, and no notes are stored in memory.

**Why this variant cannot express it:**
- **The bound resets.** The bound lives in `loop(…, { max: 2 })`, which is per attempt. `on(revision, { restart: 'assess', at: ['panel'] })` cancels the attempt and pulls a new one, so the count starts again. Scenario 11 ships this exact hole.
- **The notes have no path.** `Reaction.update` sees only the signal payload, and no reaction exists for "decision recorded". Notes can reach attributes only through a trigger that `signal`s the unit back to itself, or through `unit.failedAttempts`-style arithmetic. Both are escape hatches.

## 3. Sharpest critiques

1. **Strings stand in for entities, against principle 8.**
   - `event.unit.state === 'AwaitingCustomer'` (s02 trigger).
   - `stored.state === 'Customer'` (s08 scan).
   - `assignment.seat.name === drafter.name` (s02).
   - `sectionsOf(section: string)` and `resourcesFor(name: string)`, which look resources up by name (s06, s09).
   - `PatternEvent.group: string` and `CrossingEvent.value?: string`, which leave the facet value untyped. Scenario 9 must guard `event.value === undefined` on every consequence.
   
   States are entities, yet `UnitView.state` is `SN` (a name), so every comparison is a string. Facets were made entities, and their values came back as free strings.

2. **Timer re-arm is a hidden coupling.**
   - `H.when.timer` "re-arms it after every `attributesUpdated`". Any reaction `update` therefore re-arms every timer on that lane, including timers whose deadline does not depend on the changed field.
   - The scenario 11 redline `update` would re-arm an expiry timer. The scenario 2 `customerReplied` update re-arms the SLA timer.
   - Scenario 9's SLA extension works only by accident of this rule, and nothing declares which attribute a timer depends on.

3. **The seat is an overloaded pivot, and batch-ness leaks onto it.**
   - **Too many concerns.** `Seat` carries role, model or policy, pool, workspace, guard, raisable halts, output schema and `.batch()`. Weakness 6's "eight concerns" complaint has moved from the lane to the seat.
   - **Batch is a property of the executable.** `seat.batch()` returns a `Job`, so batching belongs to the executable, not to the step. Scenario 10's `summarizerSeat` pairs an `anthropic.model` with a pool containing a `claudeCode.subscription`, and only startup rule 9 catches the mismatch. This is weakness 5 unresolved; the design admits as much.
   - **The A/B can collapse in scenario 6.** `reviewerModel(…, challenger, …)` can swap both seats to `challenger`. Once swapped, `mine` still measures the old `incumbent` series, so the policy never swaps back. Two seats then end up on one model, against "two agents of the same role on different models".
   - **Rival seats need a thunk.** The rival seat is reached through `(): SeatRef => reviewerB`, a forward-reference workaround the surface forces on the author.

Also of note:
- **Economy.** `admit` lambdas re-implement scheduling rules, such as `ended.byState.Inconclusive / ended.terminal` in s08 and the `paused` gate in s09, that no scenario asked for.
- **Scenario 12.** "GPU hours in flight per day" is computed at step end from `durationMs`. A job running at midnight is counted on the wrong day, and jobs still in flight are invisible.
