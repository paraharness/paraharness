# Generation 0 front

- g00-ours-2-1 (ours-2, materialize, pareto): bt 0.6555, compile errors 0, escapes 0, any-in-dts 0, surface 358, coverage 12/12, cannot: none, strikes: none
- g00-ours-2-0 (ours-2, materialize, pareto): bt 0.2704, compile errors 0, escapes 0, any-in-dts 0, surface 303, coverage 12/12, cannot: none, strikes: none
- g00-minimal-0-2-2 (minimal-0-2-2, import, pareto): bt 0.019, compile errors 0, escapes 0, any-in-dts 0, surface 219, coverage 12/12, cannot: none, strikes: none
- g00-durable-0-2-0-1 (durable-0-2-0-1, import, by rank): bt -0.4855, compile errors 0, escapes 0, any-in-dts 0, surface 344, coverage 12/12, cannot: none, strikes: none

## Critiques

### g00-ours-2-1

# Adversary report: g00-ours-2-1

## 1. Worst scenario: 07, two projects with shared subscriptions

**Principle 11 is broken in the scenario file itself.**
- `subscriptionPool(0.6)` and `subscriptionPool(0.3)` each call `account.maxQuotaShare(share)` on the same exported `shared.subscriptions` descriptors. That yields two derived accounts named `claude-max-1`, two pools named `claude-subscriptions`, and so on.
- Design note 23 calls this "legal because each harness registers exactly one derivation".
- But the file exports `start = { product: () => product.start(), docs: () => docs.start() }`, which runs one runtime and one module. That is two descriptors with one name, which is exactly what principle 11 says the runtime refuses.
- The share cap, a per-harness relationship, is stored on the account, an instance. So the "shared" account is not shared.

**The supervisor requirement is unexpressed.**
- The scenario asks for one supervisor session pointed at two endpoints. The variant writes two unrelated clients, `owner-on-product` and `owner-on-docs`.
- Nothing says they are one session, and nothing exposes the cross-harness quota fold to either client. `H.ops.accounts.manage` is per harness.
- This is known weakness 8, left open.

**Harness A is not scenario 1.**
- It drops Epic, ServiceHeartbeat, the trigger and starvation-protected ordering beyond a rank.
- It invents `stuck` and `declined` states that nothing enters except retry exhaustion.

Runner-up is scenario 02:
- `H.time.at(conversations, …).where(position !== 'terminal')` escalates conversations already `sent`, because `sent` is `.waiting()`.
- `rejected: { to: fresh, atMost: 2, then: escalated }` reaches `escalated` without creating an Escalation unit. That is a lie about the state.

## 2. New scenario: jurisdictional counsel

> **Scenario 13: one flow, partitioned resolvers.** The contracts flow of scenario 11 serves `contracts-eu` and `contracts-us`. EU counsel (HTTP dashboard) may resolve `counsel` only for EU contracts; US counsel (a different HTTP dashboard) only for US contracts. Above $50,000, `signoff` needs two distinct finance approvers. Either may reject alone, and the second approval must come from a different person than the first. The flow is not duplicated. Metrics: time to quorum per halt, with sample counts.

The variant cannot express this honestly:
- `Grant` is `client × operations`, and `H.ops.resolve(counsel)` has no lane or unit scope. The only way to split counsel by region is two halt entities, which means two flows: duplication, or an escape through `when` on lane name inside the flow.
- `DecisionEvent` carries one `resolver` and one `client`, and `Halt` resolves on the first decision, so a quorum has no vocabulary.
- The workaround, two sequential `.halt` steps with a `when` comparing approver names, puts approver identity in decision data and checks it in flow code. That is policy in the flow and a string standing in for a person.

## 3. Three sharpest critiques

**a. Required `retry.exhausted` manufactures dead-end states.**
- Principle 12's generation-1 failure is back. The kinds invent waiting states whose only purpose is to absorb retry exhaustion, and none has an exit:
  - `stalled` in scenarios 4, 10 and 11;
  - `auditStalled` and `escalationStalled` in scenario 9;
  - `evalStalled` and `backfillStalled` in scenario 12;
  - `measuring` reused as the exhaustion target in scenario 8.
- Exhaustion of an attempt that `.order` parked shares the waiting position with "awaiting vendor". The board cannot tell "nothing will ever happen" from "someone outside will reply".

**b. Facet entities degrade to strings at the read site.**
- In scenario 11, `metrics.read(counselApprovals, { 'contract-category': context.category })` keys the reading by the facet's name string. The `MetricsReader.read` key type is `{ [P in Key]?: string }`, built from `DimName`.
- Principle 8 says a string never stands in for an entity. Rename the facet and every policy silently reads an empty series, because the key is optional.
- Scenario 6 compounds this: `actedOn: z.enum(['a','b','both','neither'])` couples the editor's decision schema to the parallel call keys `a` and `b`. The metric is not keyed on seat, so the "A/B on the seat" ruling is bypassed.

**c. `lane.move` is one verb doing four jobs, and its decision semantics are unowned.**
- `move` serves for:
  - cancel (scenario 5, expiry at 09:00);
  - reopen (scenario 3);
  - wake (scenarios 8 and 9);
  - preempting re-entry (scenario 11).
- Every move into a non-terminal state silently cancels a live attempt. In scenario 2, `customer-reply-reclassifies` therefore kills a running classify step, not only a draft awaiting approval as the scenario requires.
- Likewise, the decision `{ continue: boolean }` on `ceiling.onExceed` has no kernel meaning. What does `continue: false` do: fail, cancel, or exit? The kernel never says, so the ceiling's outcome depends on the decision schema the author happens to write (hidden coupling).

### g00-ours-2-0

## 1. Worst-handled scenario: 4 (operations, no model)

**Preemption is faked by metric arithmetic.** The scenario needs "no new Backup while an Incident is active". The scheduler cannot see positions in other lanes. `SchedulePolicyInput.running` lists only running attempts, and an Incident halted on `acknowledge` is not running. So the author derives "active" from two unwindowed, all-time counts:

```ts
(metrics.read(incidentsOpened, …).value ?? 0) - (metrics.read(incidentsClosed, …).value ?? 0)
```

This is a ledger reconstruction written by hand, the kind of thing principle 4 says policies should read directly. The board knows positions, but the policy does not. "Incidents preempt everything" is only a sort order. A full runner slot is never freed for an Incident.

**One kind is split into lanes per host.** `Command.runner(host)` is fixed at definition time. To put Backup on two hosts, the author writes `backupLane(host, …)`, `backupFlow(host)` and `backupCommand(host)`. That gives two lanes, two flows and two commands per Backup, all named by string interpolation (`` `backups-${host.name}` ``). It also forces two copies of each trigger: `backupFailuresOpenIncidents = backupLanes.map(...)`. The lane ranking then matches names with `backupNames.has(c.lane.name)`, a string standing in for an entity.

**Lane priorities are strings throughout the battery.** `laneRank` and `laneOrder.indexOf(lane)` key on `lane.name`. A lane is an entity, yet the scheduler orders it by its name.

## 2. New scenario: 13, parallel gates on chosen hosts

A release-compliance harness.

### Must express

- Kind `Change`, supplied by the operator.
- Flow:
  - `scan`: a command on whichever of three SSH hosts has the most free disk. The choice is made by a deterministic policy at attempt time and recorded with its reading.
  - Then halts `security` and `legal` open **at once**. Either may resolve first. Each has its own resolver grant and its own 4-hour clock.
  - Then `deploy`, only after both halts resolve.
- Metrics:
  - Time from the first resolution to the second.
  - Host-choice distribution, with sample counts.

### Hostile aspects

- Two concurrent halts in one attempt.
- A runner picked per attempt by a policy, as a seat picks a model.

### Why it breaks this variant

- `Flow` has only sequential `step`/`halt` plus `batch`, and `batch` covers model calls only. The author must either serialize the halts (a lie about the requirement) or `spawn` two child units of invented kinds (an escape hatch).
- The `Runner` is fixed on the `Command`, and there is no runner-choice policy. The only option is three lanes, which is the scenario 4 pattern again.

## 3. Sharpest critiques

1. **Raw strings stand in for entities in metrics.**
   - `H.events.steps('checkCitations')` addresses a step by bare string. The design rule itself says a step's address is `flowName/path` plus the flow hash, so a renamed step silently zeroes the metric.
   - In scenario 6, reviewer identity is the decision literal `actedOn: z.array(z.enum(['a','b']))`, not the seat.
   - The A/B policy reads `where: { model: incumbent }`. Principle 8 says A/B metrics key on the **seat**. Here the series breaks on the very swap the policy performs. It also cannot tell the two models apart, because "attempts in which that model was invoked" includes both reviewers in every attempt.
2. **Two words for one pivot (principle 22, weakness 1 untouched).**
   - `Agent extends K.EntityRef<'seat'>`: the design admits an agent *is* a seat, yet `H.agent` and `H.seat` remain separate builders with different methods (`model` vs `models`/`policy`).
   - `Column` quietly grows to include `'resolver' | 'account' | 'runner' | 'step'` beyond principle 18's list.
   - `Effect` declares `'external'`, which no scenario uses (principle 21).
3. **The lane is a god object, with hidden coupling.**
   - `Lane` carries about 21 methods. It is a pivot (`of/from/store/handle`), a policy holder (`exits/retry/wip/ceiling/after`), a facet writer, a source (`enters/streak/due`) and a consequence (`create/move/pause/resume`).
   - On top of that, `unitOf(candidate)` exists only so schedule policies can type-narrow unit data. Every multi-lane policy therefore imports concrete lanes: scenario 9's `timeToBreach` knows `audits`, `conversations` and escalations.
   - `pause(reason: string)` records free text instead of the crossing value that principle-9-scenario-9 demands. The pause payload is `Consequence<unknown>`, so the metric value never reaches the board through the trigger at all.
   - `create(map, key?)` has dedup semantics nowhere specified: is a key reusable after the unit is terminal? The answer decides scenario 9's "one Audit while open".

### g00-minimal-0-2-2

## 1. Worst scenario: 12 (external jobs and locks)

- **The ordering is computed by hand, not declared.** `previous: number > 1 ? String(number - 1).padStart(4, '0') : null` derives the predecessor from file-name arithmetic. A gap in the numbering (0041 → 0043) leaves 0043 waiting forever on a unit that does not exist. `lane.after(data => string | null, ...)` takes a raw key string, so no unit identity is checked at startup.
- **A parked unit has no way out.** `heldByPredecessor` is a `'waiting'` state, so a failed 0041 strands 0042 there. No operation, trigger or declared move leads out of it. The supervisor's grants (`readWork, writeWork, resolveHalts`) only allow a free-form `update`.
- **A parked migration starves its database for good.** `applyMigration.recovery('park')` blocks the attempt on the kernel halt `interrupted`. Rule 9 says "a blocked or waiting attempt keeps its locks". So a crashed migration keeps its exclusive lock on `orders-db` and halts every backfill on that database, which the board will not show as a lock problem.
- **One `failed` state is shared by three kinds, and the retry policy exists only to satisfy the type.** `neverRetry` is written so that `.retry(neverRetry, 'failed')` compiles.
- **A GPU job still holds locks.** It "holds no capacity", yet it keeps its locks, because locks are per attempt, never per invocation.

## 2. New scenario: canary rollout

> **Scenario 13: canary rollout.** Kind `Rollout`, supplied by the operator. The flow runs these steps in order:
>
> 1. `drain` holds an exclusive lock on `host` for that step only.
> 2. A 6-hour `soak` job holds no lock.
> 3. Halt `gate` at 10% traffic.
> 4. `analyze` runs on the analyst seat.
> 5. Halt `gate` again at 50% traffic.
> 6. `promote` holds an exclusive lock on `host` again.
>
> Metrics:
>
> - Median decision time per gate *address*: the 10% gate and the 50% gate, reported separately.
> - The analyst's success rate, keyed on the seat, so that swapping `sonnet` for `opus` mid-month keeps one series.
> - A deputy is paged only for the 50% gate.

This variant fails the scenario at three points:

- **Step-scoped locks.** `lane.locks` takes locks for the whole attempt, so `soak` would pin `host` for six hours.
- **Two gates in one flow.** `ctx.halt(gate, ...)` twice produces `HaltEntry` rows that differ only by `seq`. `EntryFilter` has no address field, and `H.on.halted(gate, ...)` cannot target the second gate. The workaround is two halt entities for one question.
- **A metric keyed on the seat.** No seat exists. The series is keyed by `invocation.model`, or by a tag the flow writes itself, so a model swap breaks the series.

## 3. Three sharpest critiques

1. **The quota partition is an option on the ledger, which principle 15 forbids by name.**
   - `sqlite.ledger(path, { sharedQuota })` is the form the principle rules out: "The account names its quota partition… the ledger carries no option for it."
   - `Ledger.recordUsage` and `Ledger.accountState` put shared account state behind the per-harness ledger interface.
   - In scenario 7 the two harnesses must agree on a path string, `'~/.harness/accounts.db'`. They are not declaring the same account entity's backend.

2. **Strings stand in for entities in memory scope and metric dimensions** (principles 8 and 18, a dividing-line principle, so a double strike).
   - Memory scope takes strings:
     - `when: { roles: [drafterRole.name], resources: [draft.section] }`
     - `RunOptions.scope.resources: readonly string[]`
     - `Scope.kinds: string[]`
   - `H.resource` exists, but memory scope ignores it.
   - Metric dimensions are untyped tags the flow writes itself:
     - `byTag: 'model'`, `byTag: 'synthesizer'`, `byTag: 'modelA'`
     - `ctx.tag({ modelA: first.model ?? 'unknown' })`
   - Principle 18 requires a typed column or a declared facet entity. The A/B in scenario 6 only works if the author tags `modelA` and `modelB` by hand and sums them in `actedOn`. Without a seat, an A/B series is a convention, not a guarantee.
   - The scheduler in scenario 4 compares `unit.kind === Incident.name` even though `.is(kind)` exists.

3. **Retry and failure are expressed three ways, with one word for two things.**
   - **`KindDescriptor.failsTo`.** It is a self-admitted violation of principle 12 (`NightlyLoad...failsTo('load-failed')`).
   - **`lane.retry(policy, exhausted)`.** This is the conforming form.
   - **`RunOptions.retry`.** It is per invocation, uses the same `RetryPolicy` type, and has no exhausted state.
   - The same `RetryView { failures }` means "attempt failures of a unit" on a lane but "invocation failures of a step" inside `ctx.run`. That is one word for two counts (principle 22).
   - The rule in scenario 5 (`failures > 3 ? 'stop'`) returns `Result.ok=false` to the flow. The lane rule moves the unit instead. The same policy value behaves differently depending on where it is attached.
   - Also against principle 22: `SchedulerView.active: ActiveView[]` contains blocked attempts (`blocked: boolean`), which rule 1 places at position `waiting`. "Active" means a position in one place and "has a live attempt" in another.

### g00-durable-0-2-0-1

## 1. Worst-handled scenario: 7 (shared subscriptions)

Principle 15 says: "The account names its quota partition… the ledger carries no option for it." This variant does the opposite:

```ts
.ledger(sqlite.ledger({ path: '…/ledger.sqlite', quotaPath: sharedQuotaPath }))
```

- **The ledger carries the option.** The quota partition is an option on the ledger.
- **The account names nothing.** `Account` is `{ credential: EnvRef }` and declares no partition.
- **Two harnesses can disagree silently.** Harness A and harness B each pass a `quotaPath` string. Nothing checks that both point at the same partition for `claude-subscription-one`. Nothing stops one account's quota from being split across two files.
- **The ledger owns another store's state.** `Ledger.appendQuota` and `readQuota` live on the ledger interface. That is "a second store under the ledger's name", which the principle names as a violation.
- **Share caps are split by pool name, not harness.** `projectPool('coding-pool', 0.6)` and `projectPool('docs-pool', 0.3)` are keyed by pool name. `QuotaEvent.harness` is a free string, and no harness declares its own identity.
- **The supervisor gap is unaddressed.** "One supervisor session pointed at either harness" is two unrelated `claudeCode.supervisor` instances on `H.slot.port(1)` and `port(2)`. Known weakness 8 remains untouched.

Runner-up: scenario 2. It still uses the inline halt form, `skip: (ctx) => isSafeCategory(...) ? {…, auto: true}`, which smuggles the resolver sort into the decision schema. Principle 17 requires a registered policy, and the design notes call this form "debt".

## 2. New scenario: model swap under a seat, scoped to a resource

A localisation harness translates UI strings per locale.

- **Kind.** `TranslationBatch`, one per locale. Each takes a shared lease on resource `glossary-db`.
- **Translator seat.** A seat holds role `translator` with candidates `sonnet` and `opus`. The choice policy picks per attempt.
- **Metric.** "Reviewer acceptance rate per seat per locale" must remain one continuous series across a model swap. It must be keyed on the seat and on a declared `locale` facet entity, with sample counts.
- **Facet check.** A second facet that repeats the `resource` column must fail at `start()`.
- **Experience memory.** Items are scoped to resource `glossary-db`, for example "when the glossary has a pending term, defer the string, because reviewers reject guessed terms". They are recalled only by attempts that lease that resource.
- **Hostile aspects:**
  - the seat as metric key;
  - a typed facet entity;
  - memory scope referencing a resource entity rather than a string.

This variant cannot express it without lying:

- **No seat exists.** Metrics key on `event.models.draft`, a model-name string, so the swap breaks the series.
- **Facets are concatenated strings.** `Sample.group` is a free string, and scenario 9 already concatenates `` `${category}@${model}` ``.
- **Memory scope takes strings.** `Scope.resources: readonly string[]` cannot hold `H.resource('glossary-db')`.

## 3. Three sharpest critiques

1. **Strings stand in for entities, against principles 8 and 18.**
   - **Memory scope.** `Scope.resources: readonly string[]` and `AgentTask.resources` take strings. Scenario 4 scopes memory with `resources: [event.unit.attributes.database]`, a raw string, while scenario 12 uses `H.resource('orders-db')` for leases. These are two identities for one database.
   - **Metric dimensions.** `Sample.group` and `Amount.group` are untyped strings with no facet entity and no column check.
   - **Step addresses.** `restart: { at: ['counsel'] }` and `unit.attempt?.step === 'approval'` inside a supplier route (scenario 2) use step names as strings. The supplier is secretly coupled to the flow's step names, which is hidden coupling under principle 13 as well.

2. **The kind declares failure, against principle 12.**
   - `Kind.onAttemptFailed(state)` puts failure on the kind. The amended principle says "the kind declares nothing about failure"; retry exhaustion belongs to the lane.
   - The variant then needs a startup rule, "a lane that declares `retry` for a kind that already has a failure move", to police two mechanisms for one concept.
   - The result is concrete. `Migration.onAttemptFailed(MigrationFailed)` means a migration with a transient failure never retries, and that decision sits on the kind, shared by every lane that handles it.

3. **The halt and seat vocabulary is unresolved, against standards 21 and 22 and principle 8.**
   - **Two halt forms.** `flow.halt(name, halt, opts)` and `flow.halt(name, { ask, decision, skip })` coexist. Scenarios 1–10 use only the inline form.
   - **Two halt grants.** `H.ops.blockersResolve`, which resolves any halt, sits beside `H.ops.resolve(halt)`. The capability-wide grant principle 17 abolished is the one most scenarios use.
   - **No seat.**
     - Scenario 6 defines `reviewerA` and `reviewerB` as two agents of one role. Each gets its own `H.policy.model` and calls the same `slotModel` helper that swaps the weaker model, and the metric keys on the model name.
     - Principle 8 requires a seat so that a swap does not break the series.
   - **Naming mismatch.** `const Training = H.state('OnGpu', 'waiting')` in scenario 12 shows the vocabulary drifting even inside one file.
