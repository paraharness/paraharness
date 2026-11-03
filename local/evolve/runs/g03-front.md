# Generation 3 front

- g03-durable-0-2-0-1--0-1-2-1 (durable-0-2-0-1, lens, pareto): bt 1.2398, compile errors 0, escapes 0, any-in-dts 0, surface 386, coverage 12/12, cannot: none, strikes: none
- g03-minimal-0-2-2--2-1-2-2 (minimal-0-2-2, rename, pareto): bt 1.2095, compile errors 0, escapes 0, any-in-dts 0, surface 227, coverage 12/12, cannot: none, strikes: none
- g02-minimal-0-2-2--2-2-1-0 (minimal-0-2-2, rename, pareto): bt 0.8405, compile errors 0, escapes 0, any-in-dts 0, surface 225, coverage 12/12, cannot: none, strikes: none
- g03-durable-0-2-0-1--1-2-2-2 (durable-0-2-0-1, rename, by rank): bt 1.2398, compile errors 0, escapes 0, any-in-dts 0, surface 406, coverage 12/12, cannot: none, strikes: none

## Critiques

### g03-durable-0-2-0-1--0-1-2-1

# Adversary report: g03-durable-0-2-0-1--0-1-2-1

## (1) Worst scenario: 09-self-watch

This file typechecks, but it **crashes at module load**:

```ts
const modelErrorRate = H.metric('model-error-rate', H.when.invocation({ lanes: [conversationsRef()] }))
function conversationsRef() { return conversations; }
```

- `conversationsRef()` is called eagerly, before `const conversations` is initialised. That is a TDZ `ReferenceError`.
- The hoisted function exists to dodge a forward reference. That is an escape hatch the type system cannot see.
- `design.md` says the "forward-reference thunk the parent needed is gone". It moved here.

The rest of the file is also weak:

- **One concept, two entities.** Category is both `H.facet('category', …)` and `H.resources('conversation-category', …)`. The drafter is scoped through one, and the approval metric is keyed by the other.
- **`Sent` is not terminal.** It is a `'waiting'` state, so a sent conversation is never terminal. The SLA timer then needs `u.state === Sent ? undefined : …` to stop a sent reply from escalating. That is lifecycle state papering over a timer.
- **An invented policy.** `drafterModel` reads `metrics.paused` to swap models. Nothing in the scenario asks for this. It is there only to show that "how long was the lane paused" is queryable. `design.md` promised to drop exactly this kind of filler. Scenario 8's `admit` gate, also promised dropped, remains too.
- **SLA extension is implicit.** It relies on a generic `workUpdate` rewriting `slaDueAt`. No reviewer operation names the extension, and nothing on the ledger distinguishes it.

## (2) New scenario: one question, two desks

> **Scenario 13: tiered legal review.** Kind `Filing`. Flow: `draft` (agent), halt `legal-review` asked at `first-pass`, `revise` (agent), the same halt `legal-review` asked at `final-pass`.
>
> - Juniors resolve `first-pass` through an HTTP dashboard.
> - Only a partner resolves `final-pass`, through the supervisor.
> - `first-pass` times out after 4 hours to "approve"; `final-pass` never times out.
> - Metrics: median time to decision per address, with sample counts; the share of `final-pass` reversals of a `first-pass` approval.
> - The question and its decision schema are one entity. Duplicating it into two halts breaks the metric "legal-review decisions this month".

This variant cannot express it honestly:

- `H.ops.resolve(...halts)` grants by halt entity, so a junior could resolve `final-pass`.
- `Metrics.decisions({ halt })` has no address dimension.
- `DecisionEvent` carries no step.

The only way out is two halt entities, which is the lie that known weakness 3 claims to have fixed ("two things, two nouns"). The address is a noun in the flow but invisible everywhere else.

## (3) Sharpest critiques

1. **Capability strings survive in the kernel (principle 17).**
   - `kernel.d.ts`: `Client { readonly grants: readonly string[]; endpoint: { transport: string } }`.
   - The DSL hands a client `Grant` objects. The kernel interface every client backend implements receives bare strings.
   - The transport is a free string, so known weakness 8 (the client hides its transport) is unaddressed.
   - `claudeCode.session` is an `endpoints` bag with no grants of its own, and no kernel noun owns it.

2. **The store map couples a backend to a flow's step names.**
   - `StoreMap.steps?: { [K in N]?: M }` lets `linear.store` map `audit: 'In Review'` (scenario 7).
   - A tracker workflow column now depends on a flow's internal step names, and the lane stitches them together. Rename a step and the external store silently stops moving.
   - Principle 12 says an active unit's whereabouts are the attempt's current step, read from the ledger. This projects that step into the domain store under the lane's name.
   - `inFlight` does the same for the active position. The kind declares no active states, so the store map invents one.

3. **`maxAttempts` means two things.**
   - **On a step,** it counts the first try: `threeRetriesWithBackoff = { maxAttempts: 4 }` in scenario 5. The unit hides in the variable name, not the field (principle 19).
   - **On a lane,** `retry({ maxAttempts: 1, exhausted })` means "no retry". There `maxAttempts` counts attempts of the unit, not invocations of a step.
   - One `Retry` type is reused for invocation retries and attempt retries. That is two words collapsed into one (principle 22), and readers will get one of them wrong.
   - The lane form is mandatory (startup rule 2). So zero-retry lanes in scenarios 1, 2, 4, 9 and 12 must write a "retry" of 1 attempt with an `exhausted` state. Scenario 9's `EscalationStalled` and `AuditStalled` exist only to satisfy it: dead-end states the scenario never asked for.

### g03-minimal-0-2-2--2-1-2-2

## 1. Worst scenario: 02 support triage

- **The rejection loop has no bound.** The flow says `if (!decision.approved) return 'drafting';`. `drafting` is pending, so the attempt ends `succeeded` and the unit requeues for a fresh draft. Nothing caps it: there is no `H.on.enters(conversation, 'drafting', { times })`. Under rule 1, a rejection "never consumes lane retries". So a reviewer who keeps rejecting loops the unit until `maxUsdPerUnit(0.4)` blocks it on `H.halts.costCeiling`. The cost ceiling becomes the de facto retry bound. That is a lie about why the unit stopped.
- **`escalated` means two things.** Retry exhaustion lands in `exhausted: 'escalated'` (verdict failure), and an SLA breach also moves to `escalated`. The trigger then has to reconstruct which one happened: `event.unit.data.slaDue.getTime() <= event.at.getTime() ? 'SLA breached' : 'retries exhausted'`. Unit data stands in for a recorded cause, and two outcomes share one state.
- **"Approval rate by category and by model" cannot be asked.** `rateBy` takes either `by: Facet` or `by: { modelOf }`, never both. `drafterModel` silently drops category.
- **The `new` state is decorative.** No flow, supplier or trigger ever distinguishes it from `classifying`.

## 2. New scenario: localisation desk

- **Kind.** Kind `Doc`, polled from a CMS. One unit per document; its `locales` field lists eight target languages. Flow: `translate` (an agent per locale, as one batch), `glossary-sync` (a command), `publish` (a command), `qa` (a halt).
- **Model choice by locale and model.** The translator's model is picked per locale. The policy reads the QA-acceptance rate broken down by locale *and* model, with sample counts, and keeps a model on a locale only while its rate is above 0.9 over 30 samples.
- **A lock for one step.** `glossary-sync` takes an exclusive lock on the `glossary` resource for that step only. Other Docs keep translating while one syncs.
- **A deadline an operator can change.** The `qa` halt times out after 4 hours to "publish, flagged". A reviewer may extend that timeout once through the control API. The extension is recorded and moves the clock; the old deadline never fires.
- **A bounded loop on a decision.** A QA "redo" re-enters `translate` at most twice. The third redo ends the unit in `abandoned` (neutral).

This variant fails four of these:

- **Two dimensions at once.** `rateBy` cannot group by `{ modelOf }` and a facet together.
- **Step-scoped lock.** `lane.locks` holds the lock for the whole attempt. The design concedes that `Command.locks` was cut.
- **Extending a halt's timeout.** `.timeout(after, …)` is fixed on the halt descriptor. Deadline re-arming exists only for `H.on.deadline` over unit data. Principle 17 forbids moving the halt's deadline into unit data, so the honest version cannot be written.
- **Bounding the redo loop.** This needs a pending re-entry state plus an `enters` trigger. Nowhere is it stated whether a trigger moving the unit to `abandoned` races the requeue.

## 3. Sharpest critiques

1. **"Retry" has three mechanisms and two meanings (principles 22 and 21).**
   - The mechanisms are `lane.retry({ times, exhausted, reopenAfter })`, `command.retries(times, backoff)`, and `H.on.enters(kind, state, { times })` for decision loops.
   - The vocabulary table admits "Retry" means both attempt retry and invocation retry.
   - `reopenAfter` is a timer bolted onto retry so that Tenancy can survive. Meanwhile `.sequence(f, 'blocked-by-predecessor')` reintroduces exactly the dead-end waiting state that typing `exhausted` was meant to kill. Nothing exits `blocked-by-predecessor` when 0041 is retried or fixed.

2. **A string stands in for a resource (principle 8), and the vendor owns the lease.**
   - `GuardContext.leasePath(path: string)` makes file leases path strings that never touch `H.resource`.
   - The only file-lease guard is `claudeCode.fileLeases()`.
   - So scenario 1's "two attempts may not write the same file" lives in a vendor subpath, outside the kernel's lease ledger (`LeaseEntry.resource`). It is invisible to `lockWaitMs` and to the resource facet.
   - Kernel locks and vendor leases are two lease systems.

3. **The ledger is a kernel work store (principle 15).**
   - `Ledger.putUnit(unit: UnitRecord)` stores `data`, `deferredPatch`, `spentUsd` and `facets` for every unit.
   - So scenario 1's Linear-stored Bugs keep a second copy of their data in SQLite.
   - "Deadlines read recorded data, including deferred patches" means the kernel is the source of truth for timer inputs, not the owner's store.
   - The heartbeat "has no store" only nominally: its unit lives in `putUnit`.

**Hidden coupling as well: scenario 6's halt schema encodes seats.** The halt's decision schema hard-codes `actedOnA` and `actedOnB`, and `swapWeaker` hard-wires `reviewerB` into `reviewerA`'s policy. Rename a seat and the metric series breaks, which is the opposite of what seats exist for. The policy also oscillates:

- After a swap the incumbent stops accruing samples.
- About 90 days later its samples fall below 50.
- The guard then returns `mine.incumbent`, the model it swapped out.

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

### g03-durable-0-2-0-1--1-2-2-2

## 1. Worst scenario: 07, two projects with shared subscriptions

The scenario says "Harness A is the coding team of scenario 1." This variant does not import scenario 1. It re-declares a smaller harness instead:

- **Missing pieces.** It has no Epic lane, no heartbeat lane, no `heartbeatFailureFilesBug` trigger, no `ownerDecision` halt, no planner and no custom operation.
- **No shared module.** The hostile aspect "the same entity definitions imported by two harness files from a shared module" is dodged. Both harnesses, the accounts and `tasteJournal` all sit in one file.
- **A banned cast.** The file contains this:
  ```
  const trackerStates = { ... } as const satisfies object;
  export const trackerStateNames = trackerStates;
  ```
  That is an `as`, which principle 20 forbids. It is also dead code: both lanes repeat the store map inline, and the export exists only so the binding counts as used.
- **Loose scope.** `builder` has no `.output`, so it falls back to the default `string`.
- **Shared accounts are not shared values.** Sharing happens only because a literal path string, `'/home/owner/.harness/quota.sqlite'`, is identical in both harnesses. Neither ledger is told the partition is shared.

This scenario is where the variant's claim of "full inference, nothing else" is actually false.

## 2. New scenario 13: spend watch and discovered locks

A migration-assistant harness.

**Must express:**
- Kind `SchemaChange`, supplied by the operator. Flow:
  - `analyse` (agent): names which database(s) the change touches, which is only known after this step;
  - `apply` (command, wrong to repeat): must hold an exclusive lease on exactly the databases `analyse` named;
  - `verify` (command).
- A lane-level spend trigger: when today's total model spend in the `changes` lane crosses $25, the lane pauses. It resumes at the next calendar day, or when an operator raises the cap. The pause is recorded with the dollar figure that caused it.
- A metric of hours paused per week, by cause.

**Hostile aspects:**
- **A lease chosen from a step's output, taken mid-attempt.** `Lane.lease(pick: (unit: UnitView<A,S>) => …)` sees only unit attributes at admission. Either the author writes `analyse`'s output into attributes through a signal round-trip (a lie about what a signal is), or locks every database.
- **A threshold on a total, not a rate.** Startup rule 15, "A crossing over a total metric", forbids it. `Band` takes only `below`/`above` on a `MetricRef<'rate'>`. The author has to fake a rate with `hit: spent > 25` samples. That turns dollars into a boolean ratio and still crosses on the wrong edge.
- **A trigger source that is a calendar boundary for a lane.** `H.when.sweep` iterates units in states. A lane-level clock source does not exist.

## 3. Sharpest critiques

**1. File leases bypass the resource entity (principles 8, 18).**
- Scenario 1's guard is `git.worktree(...).guard({ leaseFiles: true, beforeStop })`, and the kernel's `Guard.leaseFiles?: boolean` plus `WorkspaceGuardHooks.beforeWrite(path)` implement it.
- Principle 8 names "a file pattern" as a resource that leases reference by identity. Here a file lease is a boolean plus a raw path string.
- So it never shows up in `Metrics.leases({ resource })`, `leasesTaken`, or `Lease.hold`.
- The design removed `enforce('leaseFiles')` from the driver and claims the file concept left the kernel. It only moved to `Guard`, which is still in `harness-dsl/kernel`.

**2. Facet and ResourceFamily are two words for one thing (principles 22, 8).**
- Scenario 9 declares both of these:
  ```
  H.facet('category', [...5 values])
  H.resources('support-category', [...the same 5 values])
  ```
- Nothing checks that the two lists agree. The metric dimension uses `category.of(v)` while memory scope uses `categories.get(v)`, so the same thing has two identities.
- Scenario 2's `skills: [ctx.steps.classify.category]` puts a third raw string in its place.
- Scenario 6 uses `H.resources('sections')` for a value that scenario 9 would model as a facet. A stranger cannot tell which one to reach for.

**3. Panel is a one-use entity, and its seats are not sealed (principles 21, 9, 8).**
- Choosing a model now has three nouns: `H.seat().model(m)`, `H.policy.model`, and `H.panel`. Panel is used in scenario 6 only.
- `reviewers.seat('reviewer-a')` returns a full `Seat<O,V,B>`. That type still exposes `.model()`, `.pool()` and `.role()`, so `reviewerA.model(haiku)` type-checks.
- That call silently detaches the seat from the panel's distinctness rule and its joint policy, and nothing at startup catches it.
- The "net smaller by one type" claim ignores that the `Seat`/agent overlap (known weakness 1) widened to three.
