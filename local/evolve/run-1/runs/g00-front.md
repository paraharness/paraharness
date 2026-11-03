# Generation 0 front

- g00-durable-0 (durable, materialize): bt 1.0659, compile errors 0, escapes 0, any-in-dts 0, surface 292, coverage 8/10, cannot: none, strikes: none
- g00-durable-1 (durable, materialize): bt 0.7174, compile errors 0, escapes 0, any-in-dts 0, surface 238, coverage 8/10, cannot: none, strikes: none
- g00-minimal-0 (minimal, materialize): bt -0.4142, compile errors 0, escapes 0, any-in-dts 0, surface 175, coverage 8/10, cannot: none, strikes: none

## Critiques

### g00-durable-0

## 1. Worst scenario: 8 (lifecycles that do not fit)

The variant claims to pass Scenario 8. It gets there by mapping states onto outcomes they do not mean, which is what the scenario forbids.

- **Failure is hidden.** Tenancy declares `failure: Customer`. A crashed usage review leaves the unit in the healthy `Customer` state, so a failure records nothing a metric can count.
- **Suspended counts as running work.** `Suspended = H.state('Suspended', 'active')` gives a suspended tenancy the same outcome as a running one. The monthly clock then signals it, because its route only checks `unit.outcome === 'active' && unit.attempt === undefined`. Suspended tenants get upsell reviews.
- **"Waiting" is also labelled active.** `AwaitingVendor` is `'active'`, while rule 8 says waiting units hold nothing. The outcome named "active" now means "waiting on the outside world", so active-unit counts on the board are lies.
- **No `initial` mapping.** Onboarding (`pending`) is picked up by the scheduler at once. The first attempt is a usage review, run before the tenancy has any usage.
- **Negotiation misnames the send step.** `send: Drafting` labels the send step as drafting, because `during` has no idle state to map it to.
- **Inconclusive is queried by a raw string.** `history.byState['Inconclusive']` is untyped, so a misspelling compiles and returns `undefined`. The division then yields `NaN`.

## 2. New scenario: drift guard

**Scenario 9: drift guard.** The support harness from Scenario 2 watches itself.

### Must express

- When a category's 7-day approval rate drops below 0.9 with at least 50 samples, the harness creates one `Audit` unit for that category. It does not create another while one is open.
- It also records a candidate experience item: "when drafting for {category}, recall stricter phrasing, because approvals fell to {rate}".
- When the rate recovers above 0.95, the open Audit is cancelled.
- Each conversation's SLA can be extended by the reviewer, and the breach timer must move with it.

### Hostile aspects

- **A metric-threshold source.** `H.when` offers `transition | pattern | timer | step` and nothing else. The only workaround is a lie: an `H.clock` supplier polling metrics inside a route. Routes receive no `Metrics`, and the firing would not come from a recorded ledger event, which breaks principle 13.
- **A timer that must re-arm.** `H.when.timer(... at: unit => ...)` is evaluated once into a `timerSet` event. Nothing declares that `attributesUpdated` re-sets the timer. Either the deadline extension is silently ignored, or the semantics are unspecified.
- **Dedup by group.** Avoiding a second open Audit per category needs a per-group key on `create`. Only `pattern.per` has one.

## 3. Three sharpest critiques

**(a) `ended` is a junk drawer that inflates success rates.**

These states all map to `ended`:

- `Rejected` (approver refused the load)
- `Returned` (the editor sent the draft back)
- `Escalated` (helpdesk gave up)
- `ClosedByCustomer`
- `Parked`, `Churned`, `Inconclusive`

`successRate = succeeded / (succeeded + failed)` excludes every one of them. A reviewer whose drafts are always returned never lowers any success rate. Principle 18 ("honest metrics") is broken. The design notes justify adding the outcome, but they never justify excluding negative human verdicts from the denominator.

**(b) Lanes, triggers and metrics are coupled to flow step names by raw strings.**

The design claims "flows know no states" fixes known weakness 1. It only moves the coupling into raw strings:

- `restart: 'classify'`
- `H.when.step(conversationLane, 'approval')`
- `e.models['draft']`
- `e.models['critiqueA']`
- `during: { nextHour: Measuring }`

Rename a step and the policy-relevant metric `editor-acted-on` silently returns empty groups, because `models` is typed `Record<string,string>`. The same pattern appears in `of: { name: ctx.unit.lane }` in Scenario 1, where an object literal stands in for a lane entity. That is an escape hatch typed as `Named`, and `Named` is so loose that `budget.lanes(...lanes: Named[])` accepts anything.

**(c) Instances carry relationships, violating principles 8 and 10.**

- **Model carries a pool.** `claudeCode.model('sonnet', { id, pool })` binds a model instance to a pool. Scenario 7 therefore has to fabricate `docs-sonnet`, a second model with the same id, purely to change share caps. Agent is supposed to be the pivot of role × model, and pool should be chosen there or at the harness level, not baked into the model.
- **Account carries a ledger.** `subscription(..., { ledger: sharedAccounts })` puts a storage relationship on the account. Two harnesses that import the same account must agree on its ledger in code.
- **Roles stand in for owner and humans.** `editorRole` and `reviewerRole` are human roles appearing in `writtenBy`, while the owner, who writes taste in Scenario 1, has no role at all. "Who may write" is therefore split between `writtenBy` roles and the `H.ops.memoryWrite` grant: two mechanisms for one permission, contradicting principle 22.

### g00-durable-1

## 1. Worst-handled scenario: 02 support triage

The rules hold up in the other scenarios. Here three of them collide.

- **The new message never reaches the redraft.** `customerReplied: H.move(New).from([...AwaitingApproval...])` cancels the attempt and requeues the unit. But `conversationFlow` reads `c.input.latestMessage`, and that comes from store fields. It never reads `c.signals`. The design says signals "only move states", so nothing writes the payload into `latestMessage`. The scenario's "returns to classifying *with the new message*" holds only if Zendesk's store happens to reload. That is a backend accident, not a kernel guarantee.
- **The gate feeds itself.** `skip: { when: safeCategory, decision: { approved: true } }` records a synthetic decision as the `approval` step output. `replyApproval` is defined as `.step(conversationFlow, 'approval').hit(d => d.approved)` and never checks `status: 'skipped'`. So once a category is marked safe, every auto-approval counts as another human approval, and "zero rejections over 200" can never be broken again. A deterministic policy that reads its own output is self-modification by another route (principle 4), and the metric is dishonest (principle 18).
- **Rejection loops forever.** `rejected: New` maps a rejected draft to a pending state. The unit is requeued, re-drafted with no reviewer notes, and rejected again, with no bound.
- **The escalation trigger depends on unstated ordering.** `slaBreachEscalates.where(e => unansweredStates.includes(e.unit.state))` races the lane's own `slaBreach: H.move(Escalated)`. If the move is applied first, `state === 'escalated'` and no Escalation is ever created. The design does not say which runs first.
- **Escalated is excluded from the rate.** `Escalated` is `'concluded'`, so conversation success rate silently drops every escalation.

## 2. New scenario: canary deploy

> **Scenario 9: canary deploy**
>
> Kind Release, supplied by a CI webhook. The handler deploys a canary (command), then samples the error rate for 30 minutes. If the rate exceeds 1%, it runs `rollback` (command), records an experience item, and then halts for a human. Otherwise it runs `promote`, then `verify`.
>
> A Release spawns one Smoke unit per region. The parent proceeds as soon as **any two of three** succeed, and cancels the third.
>
> A trigger whose source is a **metric threshold**: when the Release success rate over 7 days (n ≥ 20) drops below 0.9, a Freeze unit is created. Freeze blocks all new Release starts until it is resolved.
>
> **Hostile aspects:** a branch that runs different steps on each side; a quorum join; a metric as a trigger source.

Why this variant cannot express it:

- **Branching.** The flow has only `.exit(label, when)`, which ends the attempt. A branch where each side runs further steps needs a command that pretends to be the branch, or a second lane reached through a label round-trip.
- **Quorum join.** `spawn` "suspends until all children are terminal". Two-of-three is not possible.
- **Metric trigger.** `H.on` has `transition | streak | step | signal` and nothing metric-based, although principle 13 names metric thresholds explicitly. A schedule-policy hack can block starts, but it cannot *create* the Freeze unit.

## 3. Sharpest critiques

1. **`concluded` is a junk drawer, and outcomes are chosen inconsistently.**
   - *Different meanings, one outcome.* `Escalated`, `Returned` (drafts), `Rejected` (loads), `Parked`, `Churned`, `AWins` and `WeWalkedAway` all map to `'concluded'`. A returned draft is effectively a failed review. An escalation is a support failure. Both drop out of `success()`.
   - *Same meaning, different outcomes.* NightlyLoad `Expired` is `'cancelled'` while Negotiation `Expired` is `'concluded'`.
   - *Terminal states that are not terminal.* `Returned` is terminal and there is no `reopen` reaction. A resubmitted draft is deduped by `key(postId)` and never reviewed again.
2. **One word for four things: `signals`.**
   - `WorkKind.signals()` declares events.
   - `Lane.signals()` declares reactions.
   - `Trigger.signals()` is a consequence.
   - Timers "fire as a signal", and cancellation "is a signal like any other".
   - Then `c.signals` arrives as `readonly SignalRecord[]` with `payload: unknown`. Scenario 8 has to re-validate with `vendorOfferPayload.safeParse`, which throws away the kind's typed declaration. That is an escape hatch in spirit (principle 20).
   - The reaction pivot is `H.move(...)`, a verb, which breaks principle 9.
3. **Hidden coupling through string keys and the ledger.**
   - Metrics and triggers address `'approval'`, `'factCheck'` and `'citations'` by step key on a flow or lane. Rename a step and policies in other files change meaning.
   - `.sets({ category })` makes the flow write into the kind's attribute schema. The flow is supposedly "blind to kinds", yet the lane must type-check the kind against the flow's writes.
   - Quota hangs off the ledger interface (`Ledger.quota: Quota`, with `harnessUtilization` on it). The kernel's "only state" thereby owns a second store, which an `Account` instance can redirect. Scenario 7 works only because each account carries `quota: sharedAccountState`. The ownership question is not answered; the answer depends on which object you happen to read.

### g00-minimal-0

## 1. Worst-handled scenario: 8 (lifecycles that do not fit)

Scenario 8 forbids lies. This variant tells several.

**Negotiation maps failure onto a state that means something else.**
- `if (!proposal.ok) return 'vendor-replied';` and `if (!sent.ok) return 'vendor-replied';`
- A model or mail failure is recorded as "the vendor replied." This is a `pending`-mapped state, so the unit loops forever with no failure counted.
- The ledger transition says `cause: 'flow'`, `to: 'vendor-replied'`. Metrics on rounds-per-negotiation are now wrong.

**Tenancy suspension races the wake condition.**
- `ctx.until('current', { at: +30d, then: 'review-due' })` arms a wake.
- The billing webhook then moves the unit to `suspended`. Rule 5 and Rule 7 never say whether a supplier move clears `wakeAt`.
- A suspended tenancy may wake into `review-due` on day 30 and be reviewed while suspended.

**Experiment silently swallows measurement failures.**
- `sample.ok ? [...] : ctx.unit.data.observations` drops a failed hourly sample with no record.
- The experiment can end `inconclusive` from missing data, and nothing distinguishes that from a genuine tie.

**The same pattern recurs in scenario 2.**
- `if (!classified.ok) return 'escalated';` reaches an `ended` state named "escalated", but no Escalation unit is created.
- `escalated` therefore has two meanings: a real SLA escalation, and "the classifier crashed."

## 2. New scenario: canary rollout

*Scenario 9: canary rollout*

A `Deploy` kind is supplied by a webhook from CI and handled by deterministic commands only.

**Must express**
- Rollout runs as 5% → 25% → 100%. Each stage waits 20 minutes, then reads the error rate from a probe command.
- If the error rate of `Deploy` invocations tagged `stage=canary` exceeds 0.02 over the last hour, with at least 30 samples, a trigger:
  - creates a `Rollback` unit in another lane;
  - pauses all pending `Deploy` units.
- The probe command hangs in practice. Any invocation exceeding 10 minutes is killed, counted as failed, and the runner slot is freed.
- A deploy for service X must not start while a `Rollback` for X is active, keyed by service, not by kind.

**Hostile aspects**
- **A trigger whose source is a metric threshold.** `H.on` offers only `enters | streak | deadline | clock`.
  - The only workaround is a schedule policy that filters `start`. That policy cannot create the `Rollback` unit, because policies return orderings and not effects.
  - Faking it with `clock` plus a flow that polls metrics means a flow reading `Metrics`, which `FlowContext` does not expose. Metrics are only reachable through `ctx.decide`, a misuse of the rule policy.
- **A per-invocation timeout.** The design notes list "`timeout`: removed." A hung probe therefore holds its runner slot indefinitely, and nothing in `RunOptions` can bound it.
- **Exclusion keyed by a resource, not a kind.** There is no resource entity ("strings in scopes and leases"). The policy must compare `unit.data.service` strings across kinds by hand.

## 3. Three sharpest critiques

**a. "schedule" names three different things, breaking principle 22.**
- `H.schedule(...)` is a supplier.
- `H.policy.schedule(...)` is the scheduler.
- `.scheduler(policy)` is the harness setting.
- `H.on.clock(..., { daily })` and `TimeSpec` are a fourth time-based mechanism.

A newcomer reading `H.schedule('two-am', ...)` and `H.policy.schedule('daily-budget', ...)` side by side cannot tell which one decides what runs next. Separately, `ctx.halt` and `ModelResponse { status: 'asked' }` with `Intent 'ask'` are two mechanisms for one concept. Scenario 1's builder works around this with an output field `question`.

**b. Kind data carries runner identity, breaking principles 8 and 10.**
- In scenario 4, `databases = [{ database: 'orders', host: hostA.name }]` puts the backup's host into the kind's data.
- `hostFor = input => input.host === hostA.name ? hostA : hostB` then resolves runners by string comparison.
- The kind `Backup` (vocabulary) now knows an instance's name. A typo silently routes to `hostB`, and startup validation (Rule 15) cannot catch it.
- The same raw-string-for-entity pattern appears in `resources: ['section:sports']` and `'payments'`. This is exactly the seed's W4, left unfixed and listed as "cut."

**c. `Ledger extends QuotaBook` conflates two owners of state, bending principle 15.**
- Rule 11 says quota lives "by default" in the ledger and otherwise in `sqlite.quota(path)`. So the ledger is both the kernel's only state and, sometimes, not the home of quota.
- Accounts select their book through a vendor-subpath option: `claudeCode.subscription(..., { quota })`.
- Nothing stops one account from being declared with a shared book in harness A and the default ledger book in harness B. That silently reintroduces scenario 7's double-counting.
- Because `QuotaBook` is an interface the ledger implements rather than a named pivot, principle 9 is also strained. The design never says what account state is part of.
