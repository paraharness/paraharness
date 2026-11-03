# harness-dsl: inference pass (child of g02-minimal-al-0-2-0)

The operator for this child is **inference**. I went through every parent scenario looking for:

- casts;
- explicit type arguments;
- annotations that exist only because the surface lost a type;
- untyped strings standing in for typed entities.

For each one I changed the surface so that inference carries the type. The adversary's three sharpest critiques are repaired here as well, and so is its scenario-07 finding, because all of them turned out to be inference failures:

- an untyped clock;
- an untyped track record;
- untyped scope;
- an untyped quota anchor.

## Inference audit (parent → child)

| Where | What the scenario had to write | Surface change |
|---|---|---|
| 02, 09 `H.policy.rule` | Annotated the input parameter `(input: { category: string; … }, metrics)` | `H.policy.rule(name, { input, output }, decide)`. Both schemas infer `I` and `O`. `decide` is `NoInfer`-checked against them. The ledger records typed rule inputs and outputs. |
| 08 judge | Return annotation `: ExperimentOutcome` so the literals did not widen to `string` | `output: z.enum([...])` fixes `O`. `ctx.decide` returns exactly the state union, so a phase can `return ctx.decide(judge, …)`. |
| 06, 09 `rateBy(...)[k]` | `const a: Rate \| undefined = …` | `rateBy` returns `Grouped`, and `of(value)` returns a zero-sample `Rate` for an absent group. This is honest (absent means 0 samples) and needs no `undefined` branch. |
| 03 `sum(...).value ?? 0` | Null-coalescing a sum | `sum` returns `Total`, whose `value: number` is 0 for no samples. `Mean` keeps `value: number \| null`. This also fixes "`Mean` misdescribes a sum". |
| 02, 03, 06 `result.model ?? 'unknown'` | Fallback strings for the model that served a call | `ctx.run(agent, …)` and `ctx.batch` return `AgentResult<O>` with `model: ModelRef` required. `Result` lost its optional `model`. |
| 03, 06 `tag.is(model.name)`, `ctx.tag(t, m.name)` | `.name` plumbing | `Tag.is` and `ctx.tag` accept `string \| Named`. |
| 03 `citationPassRate` | A hand-written structural type for `Metrics` | Deleted. `Metrics` is exported, and the policy closure receives it typed. |
| 10 `ctx.children()` | `child.state === 'passed'` on `UnitView<unknown, string>` | `ctx.children(lane)` returns `UnitView<T2, S2>[]`, so a misspelt child state is a compile error. |
| 04 Slack `message` | Re-narrowing `entry.entry === 'transition'` after filtering on it | `EntryFilter<E>` is generic over the entry type. `slack.notify` infers `E` from `on.entry`, so `message` receives `TransitionEntry`. `Halt.raised/resolved` return `EntryFilter<'halt'>`. |
| 02, 06, 09 memory scope | `roles: ['critic']`, `resources: ['section:sports']` as strings | `Scope` takes `KindRef[]`, `RoleRef[]` and `TagMatch[]`. A misspelt role is a compile error. See rule 5. |
| 06, 09 `ctx.run(..., { scope })` | A per-call scope object duplicating a tag | Removed. Tags set by `ctx.tag` are the attempt's recall scope. |
| Lane handler params | `params: P` was inferred from the argument and could widen | `handler(flow, params: NoInfer<P>)`. The flow's schema alone fixes `P`. `act.create` and `spawn` data use `NoInfer<T2>`, so the lane fixes the data type. |
| 07 shared quota | Repeated string path `'~/.harness/shared-quota.db'` | `sqlite.quota(path)` returns a `QuotaPartition` instance, carried by the **account**. See rule 10. |
| `ctx.fail` with a move | Not expressible, so rejections were written as succeeded attempts | `Kind<T, S, F>` carries its declared failure states. `failsTo(first, ...more)` infers `F`, and `ctx.fail(reason, to?: F)` is checked against it. See rule 1. |

Scenario helper functions may still annotate their own parameters (`(unit: PendingView) => number`, `(event): SupplyOf<typeof Draft> => …`). That is ordinary TypeScript, not a lost type. No scenario needs `as`, `!`, an explicit type argument, or an annotation that recovers a type the DSL dropped.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A named, shareable position in a lifecycle. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(first, ...more?)` | Data shape, states, and the states a failed attempt may move a unit to. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decisionSchema)` | A named outside decision with a typed answer. |
| Kind | **tag** | `H.tag(n)` | A named dimension: for metrics, recall scope, and resources and skills. |
| Instance | account, model, runner, store, memory store, quota partition, supplier, ledger, guard, observer, client | adapters only | Specific resources, each with its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?).suppliers().store().wip().maxUsdPerUnit().retry()` | A work queue: kind × suppliers × store × handler. |
| Pivot | **archive** | `H.archive(n, memory, store)` | Where items of one memory kind live. |
| Pivot | **briefing** | `H.briefing(n, archives, ranking?)` | What a call is told: archives × recall policy. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy?)` | The account that serves a call, with this harness's shares. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(body).phase(state, body)` | Handler bodies, one per lifecycle phase. |
| Composite | **command** | `H.command(n).input().output().argv().on(...runners).recovers(how)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, recall, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

Plain values, not entities: `H.clock`, `H.operator`, `H.env`, `TimeSpec`, `Scope`, `Bound`, `SupplyOf<K>`.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of one flow phase for one unit.
  - Its states are `running`, `blocked` and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable. A retry is a new invocation. Each batch item is one invocation.
- **Phase**: the flow body selected by the unit's state when the attempt starts.

"Step" is not a word in this design.

## Rules

### 1. Skeleton (principle 12) and the honest attempt outcome

The parent's critique was that every returned state counted as `succeeded`. A rejected draft therefore scored as a success, and items recalled into it rose. The child separates the two meanings.

**What a phase can return:**

| The phase returns | Attempt outcome | What happens to the unit |
|---|---|---|
| A state | `succeeded` | Moves to that state. The phase did what it set out to do. |
| `ctx.wait(state, { at \| children, then })` | `succeeded` | Parks in a waiting state, with a wake that moves it to `then`. |
| `ctx.fail(reason)`, or it throws | `failed` | Stays pending under the lane's retry policy. |
| `ctx.fail(reason, to)` | `failed` | Moves to `to`. |
| Interrupted by a move, a preemption or a cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

**Rules for `ctx.fail(reason, to)`:**

- `to` must be one of the kind's declared `failsTo` states. This is principle 12's "a kind may declare a move for a failure, and only then does an attempt's failure move the unit".
- The retry policy is not consulted.
- The transition is recorded with `cause: 'failure'`.

**Rules for `failsTo` and retry:**

- `failsTo(first, ...more)` declares the failure states. `first` is where retry exhaustion (`'stop'`) sends the unit.
- `start()` refuses a lane with a retry policy whose kind declares no `failsTo`.
- With no `.retry()`, the default is exponential backoff: 1 minute, doubling, capped at 1 hour, unbounded.
- `RetryView.failures` counts consecutive failures without a move.

**Applying the rules to the critique's examples:**

- A rejected draft is now `ctx.fail('rejected by reviewer', 'classifying')`, a failed attempt. Its recalled items fall.
- An hourly Experiment measurement that returns `resting` is a succeeded attempt, because the measurement was taken.
- A Tenancy review that ends in a decision is succeeded, because the review happened.

These are not lies. The attempt outcome is the track record of the work the phase did. The unit's terminal verdict, a separate quantity, is the track record of the work unit.

`trackRecord` on recalled items is computed over attempt outcomes (principle 14). Metrics for kinds use terminal verdicts (principle 18).

### 2. Phases

- `.does(body)` handles any state without its own phase.
- `.phase(state, body)` handles a unit picked up in `state`.
- Each phase is its own attempt, with its own fingerprint.

### 3. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions. Neutral states are excluded.
- Neutral outcomes are counted by state entity.
- Every `Rate` carries `hits` and `samples`. `value` is `null` at 0 samples.
- `Grouped.of(absent)` is `{ value: null, hits: 0, samples: 0 }`.

### 4. Named halts and tags

- `ctx.halt(h, show)` returns the halt's typed decision.
- `h.resolved(match)` is an `EntryFilter<'halt'>` whose keys are checked against the decision schema.
- `ctx.tag(tag, value)` sets a dimension on the attempt and on every entry it writes.
- `tag.is(value)` is a filter.
- `rateBy({ by: tag })` returns `Grouped`.
- Filters take entity references, never names.

### 5. Memory scope and recall (principle 14)

**Scope.** `Scope` is `{ kinds?: KindRef[]; roles?: RoleRef[]; tags?: TagMatch[] }`. The kernel stores it as `ScopeRecord` (names), because a memory store is a backend.

**Resources and skills are tags.** Principle 14's "resources and skills an item applies to" are dimensions. The tag entity already names dimensions. A `section` tag, a `category` tag, a `service` tag and a `skill` tag are each `H.tag(...)`. This removes the parent's two words for one dimension (`resources: ['category:x']` beside `Tag category`) and the path-shaped strings of seed weakness 4.

**Recall scope.** A call's recall scope is computed by the kernel from three things:

- the unit's kind;
- the agent's role;
- the attempt's tags at the moment of the call.

Because tags are recorded, the scope a call used is reproducible from the ledger.

**Ranking and writes:**

- The kernel decorates candidates with `sort`, `ageDays`, `specificity`, `similarity` and `trackRecord`.
- The briefing's `ranking` orders them. With no ranking, the default orders by similarity, then specificity, then track record.
- Every recall is a `decision` entry listing the excluded items with their samples.
- Writes go to one archive.

### 6. Supply and keys

- A `create` whose key belongs to a non-terminal unit is ignored.
- `update` addresses the open unit with that key.
- The ledger keeps every unit's snapshot, so storeless kinds still appear in telemetry.

### 7. Triggers

**Sources:**

- `on.enters`, `on.streak` and `on.deadline` are unit sources. A deadline is re-evaluated on every data update, so a moved deadline re-arms and the old one never fires.
- `on.metric(read: Rate, bounds)` is a single latch.
- `on.metric(read: Grouped, bounds & { group })` keeps one latch per group.
- Each latch fires `tripped` once when it crosses `trip` with at least `minSamples`, and `reset` once when it crosses `reset`.

**Effects:** `create`, `move`, `remember`, `pause` and `resume`.

**Records:**

- Every firing is a `firing` entry carrying the metric reads that caused it.
- Pause and resume are `lane` entries. A resume entry carries the paused `durationMs`.
- A grouped firing carries its group as a tag under the group tag's name (`tags: { category: 'refunds' }`).
- Every entry a firing's effects write carries the firing's tags. This covers the transition that creates or moves a unit, the memory write and the lane entry. So `rateBy({ by: groupTag })` over those entries counts per group.

### 8. Scheduler and placement

These are unchanged from the parent:

- One policy returns `start` and `preempt`.
- Blocked attempts free runner slots but count toward lane WIP.
- Waiting units count toward nothing.
- `Command.on(...runners)` means any one of these runners, with `preflight`.

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts. Passing it raises the kernel halt `cost-ceiling`.
- Daily budgets read `metrics.sum`, which returns a `Total`.

### 10. Accounts and quota (principle 15; the scenario-07 critique)

**Where quota lives.**

- Quota is an append-only partition of `QuotaEvent`s (usage, cooldown), folded per account at read time.
- The partition is an instance (`QuotaPartition`, for example `sqlite.quota(path)`).
- The **account** carries it: `cc.subscription(name, { token, quota })`. An account declared without `quota` uses its harness ledger's own partition (`Ledger.quota`).

**Why the account is the anchor.**

- Quota state is the account's state (principle 8: instances carry their backend).
- Two harnesses that import the same account definition share its partition by construction.
- A typo cannot split the quota, because no path is repeated.

**Exclusion and shares.**

- Each harness appends its own events.
- No harness takes the other's single-writer lease, because the lease is on `harness:<name>` in the run ledger, not on the partition.
- Shares live in pools, one per harness: A's pool says 0.6, B's says 0.3.
- `AccountState.byHarness` folds each harness's usage so a share cap is checked against that harness's own consumption.

**Why this is not a second store.** The partition is part of the ledger's state, split by backend, as principle 15 permits ("it may be partitioned by backend"). It holds only append-only quota events and is never under the ledger's lock.

**The shared module.** The format rules forbid scenario files from importing each other. Scenario 07 therefore defines the shared module as one exported block of entities (accounts, quota partition, taste archive). Both harness definitions use that block by identity. The kernel's duplicate-name rule is per harness: one descriptor imported twice is one descriptor, while two distinct descriptors with one name are refused at `start()`.

### 11. Durability (scenario 10) and determinism (critique 1)

**Everything is sequenced.** Every context call is a sequenced ledger entry:

- `now`, `tag`, `move`, `update`, `decide`, `remember`, `spawn` and `children` are `CallEntry`s;
- `run` and `batch` are `InvocationEntry`s;
- `halt` is a `HaltEntry`.

Each entry carries `seq` and an `argsHash`.

- `ctx.now()` is `Promise<Date>`. On replay it returns the recorded time, so `await ctx.now()` cannot branch differently after a restart.
- On restart the phase is re-executed against the recorded entries. Completed calls return their recorded results and cost nothing.

**Nondeterministic code is detected, not trusted.** A replayed call whose kind or `argsHash` differs from the recorded entry at that `seq` marks the attempt `diverged` and raises the kernel halt `definition-changed` with reason `diverged`.

This covers code that bypasses the context, such as `new Date()` or `Math.random()` in a flow. It is caught the moment it changes what the flow asks for. It never silently reruns an effect. This is the answer to "Temporal's footgun without `workflow.now()`": the child has `workflow.now()` (`ctx.now`) and a divergence check.

**The invocation that was running at the crash** follows its executable's recovery:

| Recovery | Behaviour |
|---|---|
| `'rerun'` | Run it again. |
| `'park'` | Raise the kernel halt `interrupted`. This is the default for commands. |
| A check executable | `true` continues, `false` reruns. |
| `'ask-driver'` (always, for agents) | Ask `Model.recover`. `'unknown'` parks. |

**State that moved while the harness was down.**

- A batch records its handle before waiting and is collected, not resubmitted.
- Halt resolutions made during downtime are `operation: requested` entries, applied on start.
- Children are re-read from the ledger, and the `wait(children)` wake is re-evaluated.

**The attempt record.**

- A resumed attempt keeps its id.
- The crash is an `attempt: interrupted` entry.
- Interrupted invocations are excluded from model and agent rates.

**Changed definitions.**

- A changed phase fingerprint raises `definition-changed`, which the supervisor resolves with `restart` or `abandon`.
- A divergence raises the same halt.

**Single writer.** A lease is held on `harness:<name>`. A second process refuses to start while the lease is live, and takes over after it expires.

The author writes no resumption code.

### 12. Control API and observers

- Clients are granted operations.
- `ItemDraft` is the wire shape of memory, using names. `MemoryDraft` is the DSL shape, using references.
- An observer may filter with `EntryFilter<E>`, and its message is typed by `E`.

### 13. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names within a harness;
- a lane/flow state mismatch;
- a phase on a missing or terminal state;
- a `ctx.fail(_, to)` target or retry policy without a matching `failsTo`;
- unknown trigger states or lanes;
- an agent no pool can serve;
- a command without argv or runner;
- a batch on a model without `submit` and `collect`;
- a memory scope naming an unregistered kind or role.

A harness with no pools, agents or models is valid.

## What changed and why

**Inference (the operator).** Every row of the audit table above:

- `rule` takes `{ input, output }` schemas;
- `Grouped` and `Total`;
- `AgentResult` with a required `model`;
- `Tag.is` and `ctx.tag` accept `Named`;
- typed `ctx.children(lane)`;
- generic `EntryFilter<E>` and the typed Slack message;
- `NoInfer` on handler params and on create/spawn data;
- `Kind<T, S, F>` with typed `ctx.fail(reason, to)`.

**Critique 1 (replay versus "no resumption code").**

- `ctx.now()` and `ctx.tag()` are now sequenced.
- Every sequenced entry carries an `argsHash`.
- A divergence parks the attempt instead of branching silently.

**Critique 2 (attempt outcome lies, and the lie feeds recall).**

- `failsTo` now declares a set of failure states.
- `ctx.fail(reason, to)` ends an attempt as failed with a declared move. A rejected draft is a failed attempt, so recalled items fall.
- The design argues that a measurement or review phase that completes really did succeed.

**Critique 3 (entity references stop at memory scope).**

- `Scope` takes `KindRef`, `RoleRef` and `TagMatch`.
- Resources and skills are tags.
- The per-call `scope` option is removed in favour of attempt tags.
- `children` is typed.
- `sum` returns `Total`.

**Scenario-07 critique.**

- `QuotaPartition` is an instance carried by the account. The `sharedQuota` string option on `sqlite.ledger` is removed.
- Scenario 07 includes the full scenario-1 harness, with the API fallback inside the pool.

**Scenario 09 (counting per group).**

- **The gap.** Writing scenario 09 showed that "how many Audits were opened per category this month" had no honest query. A grouped latch knew its group, but neither the `firing` entry nor the transition that created the Audit carried it as a tag. `rateBy({ by: category })` therefore had nothing to group on.
- **The fix.** Rule 7 now states that a grouped firing tags itself with its group, and that every entry its effects write inherits the firing's tags.
- **What did not change.** Neither `h.d.ts` nor `kernel.d.ts` changed: `EntryBase.tags` already existed. Only the kernel's obligation is new.
- **What it enables.** A policy counts opened Audits by kind, state and category, with sample counts, and needs no reference to the trigger itself.

**Scenario 11 (halt clocks).** Not adopted. It is not in the battery, and principle 21 forbids surface no battery scenario calls. The natural extension is a halt-scoped trigger source, `on.unresolved(halt, interval)`, which needs no change elsewhere, because halts are already entities with raised timestamps on the ledger.

**Removed:**

- `RunOptions.scope` and `RecallScope`;
- `Result.model` (optional);
- the `sqlite.ledger` `sharedQuota` option;
- the quota methods on `Ledger` (moved to `QuotaPartition`);
- `Scope.skills` and `Scope.resources`;
- `Kind.failure` (now `failureStates`).

**Added:**

- `Kind` generic `F` and `failsTo(first, ...more)`;
- `ctx.fail(reason, to?)`;
- `Grouped`, `Total`, `AgentResult`, `RoleRef`, `ScopeRecord`, `ItemDraft`;
- `QuotaPartition`, `QuotaEvent`, `Account.quota`, `sqlite.quota`;
- `CallEntry`, `argsHash`, `AttemptEntry.status: 'diverged'`;
- `TransitionEntry.cause: 'failure'`;
- `EntryOf` and `EntryFilter<E>`;
- `RulePolicy.input/output`;
- group tags on grouped firings and their effects.

## Principles broken

None.

- **Principle 12** holds. A failure moves a unit only to a state the kind declares in `failsTo`, and retry exhaustion goes to the first of them.
- **Principle 14** holds. Scope names kinds, roles and resources (as tags), and recall is an owner-authored deterministic policy whose track record now reflects honest attempt outcomes.
- **Principle 15** holds. Shared quota is an append-only partition of ledger state placed by its backend and carried by the account instance, never under the run ledger's single-writer lease.
