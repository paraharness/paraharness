# Generation 2 front

- g02-minimal-al-0-2-2 (minimal, surface-cut, pareto): bt 2.0534, compile errors 0, escapes 0, any-in-dts 0, surface 186, coverage 10/10, cannot: none, strikes: none
- g02-durable-le-0-2-0 (durable, surface-cut, by rank): bt 1.5399, compile errors 0, escapes 0, any-in-dts 0, surface 288, coverage 10/10, cannot: none, strikes: none
- g02-minimal-al-0-2-0 (minimal, rename, by rank): bt 0.9503, compile errors 0, escapes 0, any-in-dts 0, surface 208, coverage 10/10, cannot: none, strikes: none
- g02-durable-le-1-2-1 (durable, lens, by rank): bt 0.395, compile errors 0, escapes 0, any-in-dts 0, surface 254, coverage 10/10, cannot: none, strikes: none

## Critiques

### g02-minimal-al-0-2-2

## 1. Worst scenario: 4 (operations)

**Placement is wrong, not merely loose.**

- `backupDatabase` is declared `.on(dbHostA, dbHostB)`, and rule 8 places each invocation "on the first listed runner with a free slot." The `orders` backup therefore runs on whichever host is free, not on the host that holds `orders`.
- The design deleted host data from the kind as a "principle-10 leak". It left no way to say that a unit has affinity to a runner. The scenario wants per-host concurrency over host-bound work; the variant gives anonymous load-balancing.
- `renewCertificate` is also `.on(dbHostA, dbHostB)`, so a certificate renews on a database box picked at random.

**The preflight is attached to the wrong thing.**

- `diskPreflight` is a raw shell string (`test "$(df ...)" -ge 50`) inside an `ssh.host` option.
- Because it sits on the runner, every renewal is gated by backup disk space.
- The preflight belongs to the backup, but it lives on the host.

**Triggers rest on a guess and an optional field.**

- `slowBackupNoted` reads `event.attempt?.durationMs ?? 0`. If `attempt` is missing, a slow backup is silently not noted.
- `on.streak(..., 3, group)` does not say whether a `heartbeat-ok` between failures resets the streak. "Consecutive" is a guess.

**Preemption is underspecified.**

- `incidentsFirst` preempts every active heartbeat and renewal whenever any Incident is pending.
- A renewal that is mid-`renew-certificate` is cancelled. No `recovery` is declared, so the default is `'park'`.
- So every incident leaves parked renewals for the supervisor.

## 2. New scenario: fleet patching

**Kind and supply.** Kind `Patch`, one unit per host per week, supplied by a schedule. Each unit must run on its own host's SSH runner, with one patch per host at a time.

**Retry and outcome.**

- A failed attempt retries twice, at 10 and 30 minutes.
- On the third failure the unit moves to `quarantined`, a terminal state with verdict `failure`.
- Ordinary failures must not quarantine on the first try.

**Rate limit.** The `patches` lane retries at most 6 units per hour across the fleet.

**Why this variant cannot express it:**

- **No lane retry policy.** `Lane.retry` was deleted, and the kernel retry is fixed: unbounded, 1 minute to 1 hour.
- **`failsTo` fires on the first failure.** There is nothing in between.
- **The failure count is gone.** `UnitView.failures` was deleted, so a flow cannot count attempts either. The only way through is reading the ledger from a flow via `ctx.decide`, which is the hand-written branch the design boasts of removing.
- **No host affinity.** `Command.on(...runners)` cannot pin to `data.host`.

## 3. Three sharpest critiques

**a. Unbounded fixed retry is a principle-12 dodge.**

- Principle 12 says "under the lane's retry policy," yet there is no lane policy to author. The kernel hardcodes "no limit on retries."
- In scenario 1, a Bug whose builder errors every time retries forever, burning subscription quota. Only `exhausted` (rounds out) ends it, and a `ctx.fail` path never reaches it.
- In scenario 2, a failing Conversation loops until the SLA trigger rescues it.
- Deleting the method under principle 21 created a behaviour no owner would choose.

**b. The string discipline is half-done and inconsistent.**

- `EntryFilter.kind` takes a descriptor, but `Scope.kinds` and `Scope.roles` take strings: `when: { kinds: [Topic.name], roles: [critic.name] }`.
- `EntryFilter.state` and `status` are `string`.
- Kernel halts `'cost-ceiling'` and `'definition-changed'` are not `H.halt` entities, despite rule 6.
- Metric grouping runs on magic tags: `byTag: 'group'` in scenario 9, `byTag: 'model'` fed by `drafted.model ?? 'unknown'`, and `byTag: 'modelA' | 'modelB'`. The policy key is only coincidentally `opus.name`.
- The scheduler compares `unit.kind === Feature.name` despite having `is()`.
- The adversary's critique (a) was repaired for halts and nothing else.

**c. Flows are still coupled to state entities (known weakness 1, unrepaired).**

- `FlowDraft.for(k1, k2)` types states as `S1 & S2`. Bug and Feature must therefore share `queued`, `building`, `done`, `exhausted` and `abandoned` by name.
- A Feature that wants a `needs-design` state cannot be handled by `ticket-work`.
- Scenario 7 shows the cost: `abandoned` becomes a `failure` verdict where scenario 1 had `neutral`, because both kinds had to accept one shared state set.

**Also: two vendors for one model.** `claude.model('claude-opus-4-1')` and `anthropic.model('claude-opus-4-1')` are separate instances for one model. Metrics keyed by `model.name` merge them, while price and recovery differ. That is two words for one thing at the instance layer.

### g02-durable-le-0-2-0

**(1) Worst scenario: 3, research pipeline**

- **Failure leads to livelock.**
  - A failing `cite-check` (non-zero exit) fails the attempt.
  - `Topic` declares no `.onAttemptFailed`, so the unit returns to pending "under the lane's retry policy".
  - `Lane` has no retry method in `h.d.ts`, and `UnitView.attempts` was cut. Nothing bounds re-attempts, and the author cannot write the bound.
  - Worse, `.ceiling({ maxUsd: 3, onExceed: 'fail' })` counts cumulative unit cost. Once a topic has spent its $3, every later attempt fails before its first invocation and goes back to pending. The scheduler picks it again forever, and `admit` still passes because a zero-cost attempt adds no `dailySpend`.
  - The scenario's outcomes are delivered, parked or cancelled. There is nowhere honest for "citations never resolve" to land.
- **"Findings" are forced into the wrong kind.** `H.memory('finding', 'experience')` has only two trust values. Prior report findings are neither experience (fallible advice) nor taste.
- **The embedding model is a raw string.** `embeddingModel: 'text-embedding-3-small'` is an untyped vendor id inside a backend option. Every other model is an instance with a driver.
- **The projection measures the wrong thing.**
  - The scenario asks for the mean cost of *succeeded attempts*.
  - `deliveredCost` sums `event.unit.costUsd`, which is the whole unit's spend, including failed earlier attempts.
  - So the metric the scheduler reads is not the one specified.

**(2) New scenario: 11, spend guardrail with give-up**

A translation harness. Kind `Document` is supplied from a folder and handled by a translator agent and a terminology check command.

- A document whose attempt fails three times moves to `GaveUp` (terminal, failure). The first two failures retry after 10 and 40 minutes.
- When today's model spend across the harness exceeds $25, the `documents` lane pauses. It resumes at local midnight, or when the owner raises the budget through the control API. Both events are recorded with the spend figure.
- A policy must be able to ask "what fraction of units gave up after exactly two retries".

**Why the variant cannot express it:**
- **Give-up after N failures.** `.onAttemptFailed(GaveUp)` fires on the *first* failure. The alternative is pending with an undeclared retry, and nothing in between. `Retry` exists only on steps, not attempts. The author could fake it with a step loop, but that collapses three attempts into one and corrupts the attempt metrics.
- **Spend threshold.** `H.when.crossing` over a `total` metric is a startup error ("a crossing over a non-rate metric"). A dollar threshold cannot be a trigger source.
- **Midnight resume.** `H.when.timer` is per unit, so there is no lane-scoped timer to resume on.
- **Retry counts.** These are not queryable. `AttemptCounts` has no per-unit breakdown, and `UnitView.attempts` was removed.

**(3) Sharpest critiques**

1. **Principle 12 cites a mechanism the DSL deleted.**
   - "By default a failed attempt leaves the unit at pending under the lane's retry policy." No such policy exists in the surface.
   - The surface cut removed `UnitView.attempts`, so an `admit` gate cannot approximate one either.
   - Every kind without `onAttemptFailed` loops forever on a deterministic failure: Bug, Feature, Topic, Experiment, DocPage.
   - The failure default is the one rule principle 12 says was added to stop dead-end and loop states. This variant reintroduces the loop.

2. **Stores couple to kinds through stringly state maps.**
   - `linear.store({ states: { Queued: 'Todo', ..., Incomplete: 'Canceled' } })` is a `Record<string, string>` keyed by state names. One store instance serves Bug, Feature and Epic, and the map is unchecked: rename `Exhausted` and the tracker silently stops moving.
   - The lane's exit map is compile-checked; this map is not.
   - Raw strings stand in for entities elsewhere too, and they feed memory scope (principle 14):
     - `resources: ['section/sports']`;
     - `skills: [category]`;
     - supervisor `endpoint: 'coding'`.

3. **`during` makes position lie, and the scheduler reads the lie.**
   - `approval: AwaitingApproval` declares an `active` position for a unit whose attempt is blocked and holds nothing. Principle 12 defines the board and scheduler on positions, yet `AdmitCtx.active(lane)` counts these blocked units.
   - **Scenario 4.** `admit(backups, ctx => ctx.active(incidents) === 0)` misses two cases:
     - an Incident still `Open` (pending, before paging) does not block a Backup;
     - an Incident whose step is unmapped stays at whatever state it last had.
   - **Scenario 8.** An `Experiment` sits at `Observing` (active) for two weeks while blocked on `wait`. It inflates `active(experiments)`, which the inconclusive gate reads.
   - Partial consequences add a smell. `.create(... event.edge === 'entered' ? … : undefined)`, repeated per consequence, is a filter hand-written into every lambda. It shows that a crossing trigger is really two triggers named as one.

### g02-minimal-al-0-2-0

## 1. Worst-handled scenario: 07, two projects with shared subscriptions

The file does not express the scenario. It writes a smaller one in its place.

- **"Harness A is the coding team of scenario 1" is not met.** `coding` has no Epic, no ServiceHeartbeat, no planner, no trigger and no scheduler. It has no model policy either: the builder uses a fixed `.model(sonnet)`. It has no API fallback. `apiFallback` is exported at the bottom of the file and belongs to no pool, so it is an orphan.
- **There is no shared module.** Both harnesses sit in one file. The hostile aspect "the same entity definitions … imported by two harness files from a shared module" is never exercised. Because of that, the duplicate-name refusal across harness files is never tested.
- **Shared quota is an untyped string.** `const sharedQuota = '~/.harness/shared-quota.db'` is passed to each `sqlite.ledger(...)`. Two harnesses agree on account state only because they happen to repeat the same path. No entity owns the partition. A typo silently splits the quota, and nothing at `start()` can detect it.
- **Shares are expressed as copies of each pool.** `subscriptions.map(... share: 0.6)` and `share: 0.3` are typed separately in each pool. That works, but it shows that the "60% / 30%" caps live in two places with no common anchor.

## 2. New scenario: approvals with a clock on the halt

**Scenario 11: escalating approvals**

A procurement harness raises a halt `approve-spend` for every Purchase. Three rules apply to that halt:

- **2 hours unresolved:** the halt is re-routed to a second approver role, and the reason is recorded.
- **24 hours unresolved:** the attempt is cancelled and the unit returns to pending, with a note on the unit.
- **Re-raised later:** each new halt gets its own clocks, measured from its own `raised` time.

A policy elsewhere asks: "what fraction of `approve-spend` halts needed the second approver, by approver role, with samples?"

**Hostile aspects:**
- A deadline measured from a halt, not from unit data.
- A trigger consequence that acts on a halt or an attempt rather than on a unit's state.

**Why the variant cannot express it.** `H.on.deadline(kind, due: (data) => Date, whileIn)` reads only unit data.

- The author must write `ctx.update({ haltRaisedAt })` into domain data. That puts ledger timing into the owner's store, which is the lie scenario 5 already told with `night`.
- `Actions` offers only `create | move | remember | pause | resume`. There is no effect to re-route or annotate a halt. The only way to cancel is `move` to a state, which invents a fake state to carry the cancel.
- `HaltEntry` has no route or assignee field, so the metric needs a raw `decision` key as an escape hatch.

## 3. Sharpest critiques

**1. Replay contradicts the "no resumption code" claim.**
- §11 says "the current phase body is re-executed against recorded results", and lists the sequenced calls: `run, batch, halt, decide, move, update, remember, spawn`.
- `ctx.now()` and `ctx.tag()` are not on that list. In scenario 08, `if (now.getTime() < Date.parse(ctx.unit.data.endsAt))` and `firstOfNextMonth(ctx.now())` can take a different branch on replay.
- The phase fingerprint will not catch this, because the code did not change, only the clock did.
- The author must know about an unstated determinism rule. That is Temporal's footgun without Temporal's `workflow.now()`.

**2. Attempt outcome lies, and the lie feeds recall.**
- Any returned state yields `succeeded`. So these all count as succeeded attempts:
  - a rejected draft (`if (review.approved === false) return 'classifying'`, scenario 02);
  - every hourly Experiment measurement;
  - every Tenancy review.
- Principle 14 ranks memory by presence in succeeded attempts. A taste item recalled into a draft the reviewer rejected therefore *rises*. The `trackRecord` on `Recalled` is computed from a track record that does not mean success.

**3. The entity-reference claim stops at memory scope.**
- `Scope` is still `kinds?: string[]`, `roles?: string[]`, `resources?: string[]`. The scenarios fill it with raw strings: `when: { kinds: ['Draft'], roles: ['critic'], resources: [`section:${...}`] }` and `resources: [`category:${cat}`]`.
- Design §4 says "never names", yet a misspelt role in a memory envelope is silent here, while a misspelt halt is a compile error.
- Seed weakness 4 (resources are path-shaped strings) survives as `'section:'` and `'category:'` prefix conventions. These overlap with `Tag`, which already names category, so there are two words for one dimension.
- Related problems:
  - `children()` returns `UnitView<unknown, string>`, so `child.state === 'passed'` is an untyped string comparison.
  - `Metrics.sum` returns `Mean`, a type name that misdescribes a sum.

### g02-durable-le-1-2-1

# Adversary report: g02-durable-le-1-2-1

## (1) Worst scenario: 2, support triage

**Human approvals hold lane capacity.** `AwaitingApproval = H.state('AwaitingApproval', 'active')`, and `.wip(10)` is set. Per the design, "Active-position units hold lane WIP." A halted attempt sits in an active state, so ten conversations waiting on the reviewer stop all classification and drafting. Principle 12 says human waits are an *attempt* state and holding capacity belongs to positions. This variant makes a blocked attempt occupy the unit's capacity anyway. Scenario 5 (`AwaitingApproval` active) and scenario 10 (`Approving` active, `wip(1)`) repeat it.

**Unbounded rejection loop.** The handler maps `rejected: New`. A rejection is not a failed attempt, so `.retry(...)` never counts it. The design notes say "the lane's retry intensity bounds loops." It does not: New is pending, so the unit is redrafted and re-halted forever.

**Raw strings standing in for entities.** The SLA trigger filters with `e.stateBefore !== Sent.name && e.stateBefore !== ClosedByCustomer.name && ...`. It compares state names as strings, and it repeats the reaction's `from` list, which already encodes the same condition.

**Overlapping customer events.** `customerReplied` reacts `from([... Sent])` and reopens a sent conversation. A `ticket.solved` webhook arriving afterwards then races it. Nothing orders the two events.

## (2) New scenario: contract counsel

Contracts are drafted by an agent and reviewed by external counsel, who takes days.

**Must express**
- Drafting WIP is 3. Forty contracts awaiting counsel must not consume any of it.
- Counsel may return a contract. After the second return, the contract ends in `Declined` (failure).
- A counterparty redline arriving while a draft is being written must not cancel the draft and must not be dropped. It is applied in the next round.
- Counsel's decision is a recorded decision, so its approval rate is a decision metric.

**Why this variant cannot express it**
- A `halt` keeps the unit in an active state and so holds WIP.
- The workaround is to end the attempt at a waiting state and resume on an event. That turns counsel's decision into a supplier event rather than a `Decision`, and `H.metric(...).of(decision)` is lost.
- Counting returns needs `c.attempt.number` arithmetic inside the flow. That is resumption logic in a flow, which principle 2 forbids.
- A redline during `Drafting` either needs `.cancels()` (wrong) or matches no reaction and is recorded as `event.ignored`. After the round ends at `AwaitingCounsel`, nothing re-triggers it. Scenario 8's `vendorReplied` has the same hole: `from([AwaitingVendor])` only, so a reply that lands mid-draft stalls the negotiation until `expires`.

## (3) Three sharpest critiques

**1. Shadow statuses beside the skeleton.**
- `UnitView.parked: boolean` overrides the state's declared position: a unit "in" `Todo` (pending) "reads `waiting`."
- `AttemptView.receiving: ReceiveView` is a third attempt status in all but name: "not a third status", yet it has its own view type and reasons.
- With `position`, `parked`, `blocked` and `receiving`, there are now four words around "not progressing." The board must reconcile a state's position with a flag that contradicts it, which violates principles 12 and 22.

**2. Flows are still coupled to the kind's state names (known weakness 1, unrepaired).**
- `.mark('drafting')`, `.mark('awaitingApproval')`, `.mark('approving')` and `.mark('smoking')` mirror kind states one-to-one. The `states:` map in every handler is then a rename table.
- The marks exist only to move the unit between *active* states. Those states exist only because principle 12's single active position could not show where a conversation is.
- The result is a second lifecycle authored in the flow, with types like `unitDoesNotSatisfyFlowInput: never` patching mismatches.

**3. Events are dropped silently, and reactions are the only routing.**
- `event.ignored` is the default for any event without a reaction from the current state.
- There is no deferral and no "apply on next entry." Every author must enumerate every source state per event, as in the four-line `from([...])` lists in scenarios 2, 8 and 9, or lose data.
- The selective-receive claim ("whole mailbox in arrival order") is only half true: the payload is readable, but the *transition* it should cause is gone.
- Related problem: `per: 'service'` / `per: 'category'` and `outlet: 'feature'` are untyped string keys where entities or typed attribute references belong.
