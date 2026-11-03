# Generation 3 front

- g03-durable--1-2-1-1 (durable, lens, pareto): bt 1.9586, compile errors 0, escapes 0, any-in-dts 0, surface 255, coverage 10/10, cannot: none, strikes: none
- g02-minimal-al-0-2-2 (minimal, surface-cut, pareto): bt 1.6009, compile errors 0, escapes 0, any-in-dts 0, surface 186, coverage 10/10, cannot: none, strikes: none
- g03-durable--0-2-0-1 (durable, delete, by rank): bt 1.2816, compile errors 0, escapes 0, any-in-dts 0, surface 288, coverage 10/10, cannot: none, strikes: none
- g02-durable-le-0-2-0 (durable, surface-cut, by rank): bt 0.7932, compile errors 0, escapes 0, any-in-dts 0, surface 288, coverage 10/10, cannot: none, strikes: none

## Critiques

### g03-durable--1-2-1-1

# Adversary report: g03-durable--1-2-1-1

## 1. Worst-handled scenario: 6, content review

The A/B requirement is faked with raw objects and query filters that have no data behind them.

- **Raw objects stand in for agents.** `const firstSlot = { name: 'reviewer-first' }` and `secondSlot` are passed to `swapWeakerAfterFifty` as `own` and `other`, typed `{ readonly name: string }`. The agents themselves (`reviewerFirst`, `reviewerSecond`) cannot be referenced before they are built, because their model policy needs them.
- **The metric cannot be grouped by model.** The policy calls `c.metrics.read(ownMetric, { agent: own, model: incumbent, window: 'all' })` with `ownMetric = H.metric('acted-on-first').of(editorCall)`. A `DecisionFact` carries `unit`, `attempt`, `step`, `actor` and `at`. Nothing attributes an editor decision to an agent or a model. The `agent`/`model` filter on a decision metric is therefore either silently ignored or undefined, so the "which model did the editor act on" rate is not actually per model.
- **The metric is self-reported.** It depends on the editor filling `actedOn: z.enum(['first','second','both','neither'])`. The scenario asks for a metric derived from editor actions recorded as transitions. This one is derived from a self-declared field on one decision.
- **The swap is not a swap.** Both policies fall back to `haiku` as the challenger, so "swap the weaker model" means "demote to haiku". After the swap, `incumbent` is still the variable the policy reads, so the comparison never re-evaluates the new model.

## 2. New scenario: long external jobs

**Scenario 11: model evaluation farm**

### Must express

- Kind `EvalRun`, supplied by the operator, stored in the harness store.
- Flow, in order:
  1. `prepare`: a command.
  2. `submit`: an external GPU job service returns a job id. The job runs 2 to 8 hours.
  3. `collect`: the job is polled every 10 minutes until it is done.
  4. `score`: a deterministic command.
  5. A model writes a summary.
- While the GPU job runs, the unit holds no WIP and no runner slot. The lane has WIP 2 and must keep starting new runs.
- On restart, a submitted job is collected, not resubmitted.
- The job failing remotely is an attempt failure, not an interruption.

### Hostile aspects

- A non-model, non-human, long-running external effect with submit/collect semantics.

### Why this variant cannot express it

- Rule 1 releases capacity only at halt, spawn or `batch` steps.
- `batch` takes `agent: Agent<I, O>` and requires `Model.batch`.
- `External.invoke` is one `Promise<O>`. It holds the slot for eight hours, and it has no `submitted` fact for restart.

The only ways through are lies:

| Workaround | The lie |
|---|---|
| Model the job as a `halt` with a `Decision` | the "decision" is resolved by a poller, polluting decision metrics |
| Wrap it as a fake batch-capable "model" | a GPU job is reported as a model call |

## 3. Three sharpest critiques

### a. One word, two concepts: `Settled`

- `h.d.ts` defines `type Settled<St> = Exclude<St, { position: 'active' }>`, meaning non-active states.
- `kernel.d.ts` defines `Settled<O> = { done: true … } | { done: false } | { done: 'unknown' }`, meaning a driver's report on an invocation. `Driver.settled` and `External.settled` use this one.

This violates principle 22. A reader of `failsTo(state: Settled<St>)` will think of "settled invocations".

### b. Hidden infinite loop and a scattered failure model

- Scenario 7's `Bug` and `Feature` omit `.failsTo`, and their lanes omit `.retry`.
- By the documented default ("no `failsTo`: exponential backoff, 1 minute to 1 hour, unbounded"), a broken ticket retries forever against shared subscriptions.
- Failure is controlled in four places:
  - `WorkKind.failsTo`
  - `Lane.retry`
  - `StepOptions.retry`
  - `StepOptions.onFailure: 'halt'`

  The kind-level `failsTo` is a relationship whose meaning depends on the lane's retry, which violates principle 10.
- Every kind also needs a kernel-only waiting state just so `blocked:` can release capacity: `Held`, `HeldForReview`, `AwaitingOwner`. The kind's vocabulary bends to lane mechanics. Without such a state, design.md admits "the board shows it holding capacity while blocked", which is a second capacity truth.

### c. String coupling the design claims to have removed

The notes say "no policy or trigger compares state names as strings", yet:

- **Scenario 2** has `e.cause.by === 'timer' ? 'sla breached'`.
- **Scenario 2** has `H.on.step(conversations, 'approval')`, which keys a trigger on a flow step name. That couples a trigger to flow internals, and renaming a step silently retargets the trigger.
- **Scenario 10's restart probe** is `findAnnouncement`, a `Command<{done}>` with no input mapper. `restart: { probe: findAnnouncement }` gives the probe no version, attempt or invocation id, so it cannot know *which* announcement to look for. Principle 10's "the harness can tell that the post happened" is unimplementable as typed.

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

### g03-durable--0-2-0-1

## (1) Worst scenario: 8, Tenancy and Experiment

Tenancy is expressed, but the semantics it relies on are undefined, and in places it lies.

- **`enter` into a non-terminal state during an open attempt is undefined.** Rule 2 says "an `enter` reaction into a terminal state" cancels the attempt. `.on(suspend, { enter: Suspended })` arrives while `ReviewingUsage` or `AwaitingUpsellDecision` is open. Neither rule nor type says whether the review attempt is cancelled, whether it continues, or whether the unit sits in `Suspended` with a live attempt. Negotiation has the same gap: `.on(vendorCountered, { enter: OurMove })` can arrive mid-`draft`.
- **`retry(... exhausted: ReviewStalled)` is a dead end.** `ReviewStalled` is `waiting`, and no reaction leaves it except `churn`. One flaky month of `usage-report` makes the customer permanently un-reviewed. The monthly timer still re-arms and signals `reviewDue`, but `ReviewDue` is entered from a stalled unit only by luck of the reaction table. The principle 12 failure default ("leave at pending") is replaced by a sink.
- **The suspended guard is a raw string.** `event.unit.state === 'Suspended'` compares against a string, not the `Suspended` entity. Rename the state and the guard silently stops matching. The same pattern recurs: `unit.attempt?.step === 'approval'` in scenarios 2 and 5, and `event.unit.state === 'Sent'` in 9. `Router` and `UnitView` are not parameterised on step names, so the lane's typed `N` is lost exactly where it matters.
- **The Experiment window resets on retry.** The window is measured by `until: ctx.now - (ctx.unit.attempt?.startedAt ...) >= 14 * dayMs`. After any lane retry (`maxAttempts: 2`), the new attempt's `startedAt` restarts the two weeks. The experiment silently runs up to four weeks.

## (2) New scenario: shared database maintenance

A platform harness runs `Migration` (operator-supplied) and `Backup` (nightly) against the same five databases.

- **Database leases.** A migration and a backup of the same database must never overlap. Two databases on one host may run concurrently.
- **Migration flow.** `plan` (command), then `apply` (command, holds the lease on `orders`), then `verify`.
- **Read-only steps.** A `Report` kind reads a replica. It may run alongside a backup but never alongside a migration of that database.
- **Board and metrics.** The board shows who holds each database lease. A policy reads "mean minutes Migrations waited for a database lease this week", with sample counts.

Hostile aspects:
- The resource is a named database, not a file glob.
- Leases are held by commands, not agents.
- Lease modes are shared and exclusive.
- Lease wait is a metric.

**Why this variant cannot express it.** `Agent.guard({ leaseFiles: true })` is agent-only and boolean. `ModelDriver.enforce('leaseFiles', hook: (path) => ...)` is path-shaped. `Command` has no lease surface at all. `Runner.slots(1)` serialises a whole host, not one database. Two workarounds remain:
- a host per database, which is a lie about topology;
- an `admit` gate that counts units, which is not mutual exclusion over a resource and does not survive a step-level hold.

## (3) Sharpest critiques

1. **`maxAttempts` means two things (principle 22).**
   - `Retry` is one type used by both `StepOptions.retry` and `Lane.retry`.
   - On a step, `maxAttempts: 3` counts *invocations*; on a lane it counts *attempts*.
   - The design's own vocabulary defines Attempt and Invocation as distinct, then names the step bound with the wrong one.
   - Failure destinations are named three ways: `onAttemptFailed`, `retry.exhausted` and a `failure`-verdict `exits` entry. Startup validation must police their mutual exclusion because the surface does not.
2. **Guard deletion moved a coding-tool concept into the kernel driver interface (principles 5 and 7, in spirit).**
   - `kernel.d.ts` makes every `ModelDriver` implement `enforce(guard: 'leaseFiles' | 'beforeStop', hook: (path: string) => ...)`, which is not optional.
   - A batch-only Anthropic driver, a helpdesk-drafting driver, or any non-filesystem vendor must now carry file-lease semantics.
   - `LedgerEvent` `leaseTaken.resource: string` is equally path-shaped.
   - Deleting `Guard` did not delete the concept. It pushed a worktree assumption one layer down, into the backend contract.
3. **The `Lane` pivot has absorbed too much, with hidden coupling at its edges.**
   - `Lane` carries kind, suppliers, store plus state map, handler plus exit map plus `during` plus params, `retry`, `ceiling` and `on` reactions: eight concerns on one noun.
   - `sqlite.scan('recurring-topics', { path: storePath, kind: 'Topic' })` is a supplier that secretly reads the store by a duplicated path string and a raw kind name, not by the `Topic` entity or the lane's store instance.
   - `slotModel` in scenario 6 groups `critiquesActedOn` by model name, not reviewer slot. After a swap, the incumbent's stale 60-day rate keeps the swap until the window ages out, then flips back. The A/B policy oscillates, and nothing in the surface lets the author key the metric by slot.

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
