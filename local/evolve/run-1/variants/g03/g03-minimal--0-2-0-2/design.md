# harness-dsl: facet (child of g02-minimal-al-0-2-0)

The operator for this child is **rename**. The weakest noun in the parent was **tag**, which fails in two ways.

1. **It names a mechanism, not a thing.** Anything can be "tagged". The word does not tell a reader what is being tagged.
2. **It had a twin.** `Scope.resources` and `Scope.skills` named the same idea a second time, as untyped strings with prefix conventions such as `'section:sports'` and `'category:billing'`. The adversary called this two words for one dimension (principle 22), and it was also where seed weakness 4 survived.

The new noun is **facet**: a named dimension along which work varies. Section, category, the model used for a slot and a database are all facets. A facet is pure vocabulary, a kind in the sense of principle 8. One facet now does three jobs that were previously split:

| Job | Expression |
|---|---|
| Set a value during an attempt | `ctx.facet(section, draft.section)` |
| Filter or group metrics | `section.is('sports')`, `rateBy({ by: section })` |
| Scope memory | `when: { facets: [section.is('sports')] }` |

Setting a facet in an attempt also places that value in the attempt's recall scope. So `RunOptions.scope` and its string resources are gone. A flow that knows the draft is about sports says so once, and recall, metrics and the board all see it.

`H.facet(name, values)` accepts a literal list. When it does, the facet is typed:

- `ctx.facet(section, 'sprots')` is a compile error.
- `rateBy({ by: section })` returns `Partial<Record<'news' | 'sports' | 'opinion', Rate>>`.

Everything that touched `tag` has been adjusted:

- `H.tag` is now `H.facet`, and `ctx.tag` is now `ctx.facet`.
- `TagRef` is now `FacetRef`, and `TagMatch` is now `FacetValue`.
- `EntryFilter.tags` and `EntryBase.tags` are now `facets`.
- `on.metric({ group })` now takes a `Facet<V>`.
- `ModelChoice.facets` is new: a model policy may read the attempt's facets, but not agent names.
- `Scope` is now `{ kinds, roles, facets }`, built from entity references.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...).failsTo(state?)` | Data shape, states, and an optional failure move. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decisionSchema, routes?)` | A named outside decision with a typed answer and named routes. |
| Kind | **facet** | `H.facet(n, values?)` | A named dimension of work, shared by metrics and memory scope. |
| Instance | account, model, runner, store, memory store, quota partition, supplier, ledger, guard, observer, client | adapters only | Specific resources, each with its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?)…` | A work queue: kind × suppliers × store × handler. |
| Pivot | **archive** | `H.archive(n, memory, store)` | Where items of one memory kind live. |
| Pivot | **briefing** | `H.briefing(n, archives, ranking?)` | What a call is told: archives × recall policy. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(body).phase(state, body)` | Handler bodies, one per lifecycle phase. |
| Composite | **command** | `H.command(n).input().output().argv().on(...runners).recovers(how)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, recall, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

The following are values, not entities:

- `H.clock`, `H.operator` and `H.env`;
- `TimeSpec`, `Interval`, `Scope`, `Bound` and `SupplyOf<K>`.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of one flow phase for one unit.
  - Its states are `running`, `blocked` and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable. A retry is a new invocation, and each batch item is its own invocation.
- **Phase**: the flow body selected by the unit's state when the attempt starts.
- **Observation**: a recorded read of the world made inside an attempt: the clock, a facet value, or the list of children. It is not an invocation and costs nothing.

"Step" is not a word in this design.

## Rules

### 1. Skeleton and honest outcomes (principle 12; critique 2)

The four positions and the verdicts are unchanged from the parent. A phase ends in one of these ways:

| The phase ends with | Attempt outcome | Unit |
|---|---|---|
| Returns a state | `succeeded` | Moves to that state. |
| Returns `ctx.wait(state, { at \| children, then })` | `succeeded` | Parks in a waiting state, with a wake. |
| Returns `ctx.fail(reason)`, or throws | `failed` | Stays where it is, under the lane's retry policy. |
| Interrupted by a move, preemption, cost ceiling or `act.cancel` | `cancelled` | Returns to the state it held when the attempt started. |

**Critique 2: rejected work counted as success.**

The adversary showed that the parent counted a rejected draft as a succeeded attempt, which then raised the track record of the memory recalled into it. The fix is a rule, not new surface: **returning a state means "this attempt did its job"**. Work that a human or a check rejects is a failure of the attempt.

- The author writes `await ctx.move('classifying'); return ctx.fail('reviewer rejected the draft')`.
- The move is a committed transition, so the unit sits at `classifying` (pending). That is exactly where the failure default of principle 12 leaves a failed attempt: at pending, under the retry policy.
- The `RetryView` carries the reason, so the lane's policy can return `{ retryInMs: 0 }` for a rejection and back off for errors.
- No new outcome and no new mechanism.
- Track record now drops for memory that was present in a rejected draft.

The other two examples from the critique are argued, not changed:

- **Hourly Experiment measurements** succeed honestly: the measurement was taken.
- **Tenancy reviews** succeed honestly: the review happened and the human decided.

Neither is a lie. In neither case does memory ride on an outcome the attempt did not achieve.

The failure move is also unchanged:

- `lane.retry(policy)` returning `'stop'` moves the unit to the kind's `failsTo` state.
- `start()` refuses a retry policy on a kind without `failsTo`.

### 2. Phases

Unchanged from the parent:

- `.does(body)` handles any state that has no phase of its own.
- `.phase(state, body)` handles a unit picked up in `state`.
- Each phase is its own attempt, with its own fingerprint.

### 3. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions. Neutral states are excluded.
- Every rate carries `hits` and `samples`. `value` is `null` at 0 samples.

Two aggregates are now named apart (critique 3):

- `Metrics.mean` returns a **`Mean`**, whose `value` is `null` when there are no samples.
- `Metrics.sum` returns a **`Total`**, whose value is a number (0 when there are no samples).

Counting is the `hits` of a `rate` whose `among` and `count` are the same filter, for example "Audits opened per category this month".

### 4. Entity references end to end (critique 3)

**Filters and memory scope.**

- `EntryFilter` takes entity references.
- Memory scope `Scope` now does too: `kinds: KindRef[]`, `roles: RoleRef[]`, `facets: FacetValue[]`.
- A misspelt role or kind in a memory envelope is now a compile error, exactly like a misspelt halt.
- The kernel converts a `Scope` to a `ScopeRecord` (names) at write time. Stores and the control API see `ScopeRecord`. This is the backend boundary, where names belong.

**Facets replace skills and resources.** Principle 14 lists "kinds, roles, skills and resources" in the envelope. Kinds and roles stay as they are. Skills and resources are both facets: a skill is a facet such as `H.facet('skill')`, and a resource is a facet such as `H.facet('database')`. One noun, typed values, and no prefix strings.

**Typed children.** `ctx.children(lane)` takes the child lane and returns `UnitView<T2, S2>[]`. So `child.state === 'passed'` is now checked against the child kind's states.

**Halts.** `Halt<D, R>` carries a typed decision (`resolved(match)`) and typed routes (`routed(route)`).

**Unit facets.** Facets given to a unit at creation (`act.create(lane, data, key, facets)`) are stamped on every ledger entry of that unit, starting with the transition that created it. Facets set by `ctx.facet` are stamped on the entries of that attempt from the point they are set.

### 5. Recall

Unchanged mechanism:

- The kernel queries each archive in the briefing and drops candidate items.
- It decorates the rest with `sort`, `ageDays`, `specificity`, `similarity` and `trackRecord`.
- The briefing's ranking orders them. Every recall is a recorded `decision` entry, with excluded items listed.

What is new:

- The recall scope is `{ kinds: [unit kind], roles: [agent role], facets: [unit facets and facets set so far in the attempt] }`.
- Agent-recorded memories (`ModelResponse.memories` are `ItemFields`) inherit that scope. The driver cannot write a scope string.

### 6. Supply and keys

Unchanged. A `create` on the key of an open unit is ignored, and `update` addresses the open unit with that key. This gives per-group deduplication. An `update` whose `state` differs from the unit's current state is a move. If an attempt is active, that move cancels it.

### 7. Triggers

**Sources:**

- `on.enters`, `on.streak`, `on.deadline` (re-armed on every data update, so an extended deadline replaces the old one, which never fires) and `on.metric` (ungrouped, or grouped by a `Facet<V>` with one latch per value).
- New: **`on.halted(halt, after: Interval)`**.

`on.halted` fires once per raised halt entry when that halt is still unresolved `after` its own `raised` time. A re-raised halt has a new entry and therefore its own clocks. This answers the adversary's escalating-approvals scenario: the deadline is measured from ledger time, never from unit data.

**Effects:**

- `create` (with an optional key and optional unit facets), `move`, `remember`, `pause` and `resume`, as before.
- `act.route(to, reason)`, on halt triggers. It appends a `halt: routed` entry carrying the route. The supervisor lists halts by route.
- `act.cancel(reason)`, on halt triggers. It cancels the attempt, records the reason on the attempt entry (shown on the board), and returns the unit to its starting state. No fake state is needed.

"What fraction of `approve-spend` halts needed the second approver" is:

```ts
rate({ among: approveSpend.raised(), count: approveSpend.routed('second') })
```

It is a plain `Rate`, with samples.

Every firing is a `firing` entry with the metric reads that caused it. Pause and resume are `lane` entries, and a resume carries the paused `durationMs`. So "how long was the lane paused" is `sum({ of: 'durationMs', among: { entry: 'lane', status: 'resumed', lane } })`.

### 8. Scheduler and placement

Unchanged:

- One scheduler policy returns `start` and `preempt`.
- `Command.on(...runners)` lets the kernel pick a runner with a free slot whose preflight passes.
- Blocked attempts release runner slots but count toward lane WIP.
- Waiting units hold nothing.
- A paused lane starts nothing, whatever the policy returns.

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts. Passing it raises the kernel halt `cost-ceiling`.
- Daily budgets are scheduler reads of `metrics.sum` (a `Total`).

### 10. Accounts and quota (principle 15; scenario 7 critique)

**The partition is an instance.** The parent's shared quota was an untyped path string repeated in two files. Now:

- `sqlite.quota(path)` returns a **`QuotaPartition`**: an instance holding append-only `QuotaEvent`s.
- `sqlite.ledger(path, { quota })` places the ledger's quota partition there. With no `quota`, the partition lives inside the ledger file.

**It stays inside the ledger.** The `Ledger` interface exposes `quota: QuotaPartition`. It is a partition of the ledger by backend, not a second store under the ledger's name.

- Each harness appends only events stamped with its own `harness`.
- The kernel folds the window at read time.
- No lock is taken. The ledger's single-writer lease covers `harness:<name>` only.

**Sharing it.** Two harnesses that share accounts import the same `QuotaPartition` value. A typo can no longer split the quota silently.

**Shares** are per pool, and therefore per harness. Writing 60% and 30% in two places is correct: they are two harnesses' caps over one shared state.

The scenario rules forbid relative imports. Scenario 7 therefore defines the shared accounts, the quota partition and the taste archive once, as values, and both harness descriptors in the file reuse those same values. That is the same object identity a shared module would give. The duplicate-name check is per harness, so two harnesses holding one descriptor is allowed.

### 11. Durability (scenario 10; critique 1)

**Replay is deterministic by construction.**

- Every `ctx` method that reads or changes the world is a sequenced ledger entry: `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember` and `spawn`, as before. New in this list are `now()`, `facet()` and `children()`, which are recorded as `observation` entries.
- On replay, `ctx.now()` returns the recorded clock, not the current one.
- Flows read time only through `ctx.now()`. A flow that calls `Date.now()` directly is outside the DSL.
- Replay also checks every call against the record: its sequence number, its entry type, the entity name and (for invocations) `inputHash`.
- A mismatch means the body took a different path, which the fingerprint cannot catch. The kernel then raises the kernel halt `cannot-resume` with reason `diverged`; the supervisor resolves it with `restart` or `abandon`.
- So the critique's footgun becomes a recorded park with a reason, never a silent different branch. The author writes nothing for this.

**The invocation running at the crash** follows its executable's `recovery`:

| Recovery | Behaviour |
|---|---|
| `'rerun'` | Run it again. |
| `'park'` | Raise `interrupted`. This is the default for commands. |
| A check executable | `true` continues, `false` reruns. A check that itself fails parks. |
| `'ask-driver'` (always, for agents) | Ask `Model.recover`. `'unknown'` parks. |

**State that moved while the harness was down:**

- Batches record their handle before waiting, and are collected rather than resubmitted.
- Halt resolutions made during downtime are `operation: requested` entries, applied on start.
- Children are re-read from the ledger.

**The attempt record:**

- A resumed attempt keeps its id.
- The crash is an `attempt: interrupted` entry. Interrupted invocations are excluded from model and agent rates.

**Changed definitions.** A changed phase fingerprint raises `cannot-resume` with reason `definition-changed`.

**Single writer.** The lease on `harness:<name>` lets a second process refuse to start, or take over once the first is dead. Never both.

**What the scenario 10 author writes:** the `recovers(...)` declaration on each command, and nothing else.

### 12. Control API and observers

- Clients are granted operations. `claude-code.supervisor` and `http.control` are two clients.
- `halts.list({ route })` lets an approver see only its route.
- Observers filter with `EntryFilter` references.

### 13. Startup validation

`start()` fails on any of these:

- duplicate descriptor names within a harness (state names included, across all kinds);
- a lane/flow state mismatch;
- a phase on a state the kind lacks, or on a terminal state;
- an unknown state in a trigger;
- an unregistered lane in a trigger or in `children(lane)`;
- a retry policy without `failsTo`;
- an agent no pool can serve;
- a command without argv or runner;
- a batch call on a model without `submit` and `collect`;
- a facet value outside its declared `values`;
- `act.route` to a route the halt lacks.

A harness with no pools, agents or models is valid.

## What changed and why

**Rename (the operator).** `tag` is now **facet**, and it absorbs the memory scope's `skills` and `resources` strings. The reasons are given at the top. `RunOptions.scope` is removed, because the facets set in an attempt are its recall scope.

**Critique 1 (replay determinism).**
- `ctx.now`, `ctx.facet` and `ctx.children` are now recorded `observation` entries, returned from the record on replay.
- Every replayed call is checked against the record, and divergence parks with `cannot-resume: diverged`.
- `InvocationEntry.inputHash` is added for that check.

**Critique 2 (outcomes that lie into recall).**
- Rejection is expressed as `move` plus `fail`: a failed attempt left at a pending state, as the principle 12 default already says.
- The Experiment and Tenancy cases are argued to be honest successes.

**Critique 3 (strings at memory scope; typed children; `Mean` for a sum).**
- `Scope` takes `KindRef`, `RoleRef` and `FacetValue`.
- `ctx.children(lane)` is typed.
- `Metrics.sum` returns `Total`.
- `rateBy` returns a record keyed by the facet's value type.

**Scenario 7 critique.**
- `QuotaPartition` is an adapter instance (`sqlite.quota`), exposed as `Ledger.quota`, replacing the path string. Two harnesses share it by sharing the value.
- The scenario expresses the full coding team as harness A, with the API account inside its pool.

**The adversary's new scenario (escalating approvals).**
- `H.halt(..., routes)`, `Halt.routed(route)`, `on.halted(halt, after)`, and `act.route` / `act.cancel` (in `HaltActions`).
- `HaltEntry` gains `route`, `reason`, and the `routed` and `cancelled` statuses.
- `EntryFilter.route` and `HaltView.route`.

**Scenarios 6–10 written against the surface: unit facets on create.**

*The gap.* Scenario 9 asks "how many Audits were opened per category this month". An Audit is created by a metric trigger. Its creating transition carried no category, because facets could only be set by `ctx.facet` inside an attempt. The query would have had to count `firing` entries and assume that trips equal openings. That is an approximation, and it is wrong when an Audit is closed by a human and a later crossing reopens one.

*The fix.*
- `Actions.create(lane, data, key?, facets?)` takes optional unit facets.
- These facets are stamped on every entry of the unit, including its creating transition, and are part of its recall scope.
- No new entity and no new method.
- The count becomes a plain `rateBy` over the transitions entering the Audit's initial state, grouped by the category facet; its `hits` are the counts.

*Other rules made explicit while writing the scenarios.* Neither changes the surface.
- State names are unique per harness.
- A check recovery that itself fails parks the attempt.

**Removed.**
- `H.tag`, `Tag`, `TagRef` and `TagMatch`.
- `Scope.skills` and `Scope.resources`.
- `RecallScope` and `RunOptions.scope`.
- `Ledger.accountState`, `recordUsage` and `recordCooldown`, now replaced by `Ledger.quota` events folded by the kernel.

**Added.**
- `Facet`, `FacetValue`, `RoleRef`, `ScopeRecord` and `ItemFields`.
- `Total`, `ObservationEntry`, `QuotaPartition` and `QuotaEvent`.
- `HaltSource`, `HaltEvent` and `HaltActions`.
- `ModelChoice.facets`.
- The `facets` argument of `Actions.create`.

## Principles broken

None.

- **Principle 12.** Rejection uses the failure default: a failed attempt leaves the unit at pending.
- **Principle 14.** The envelope's "skills and resources" are expressed as facets. The envelope still names the kinds, roles, skills and resources an item applies to; skills and resources are typed facet values rather than free strings.
- **Principle 15.** The shared quota partition is a backend partition of the ledger, exposed as `Ledger.quota`. It is append-only per harness, takes no lock, and is not a second store.
