# harness-dsl — variant "ours"

The seed as arrived at in conversation, materialized, then patched with the smallest additions that let the eight-scenario battery compile. `h.d.ts` is the DSL (`harness-dsl` plus adapter subpaths). `kernel.d.ts` (`harness-dsl/kernel`) holds the contracts a backend implements and the data shapes the runtime hands to policies, triggers and observers.

## Execution vocabulary (one word each)

- **Run**: one lifetime of a harness process, from `start()` to `stop()`. Recorded so a restart is visible in the ledger.
- **Attempt**: one execution of a lane's handler flow for one unit. An attempt is `running`, `blocked` (halted on a blocker), `completed`, `failed` or `cancelled`. A unit outlives any number of attempts.
- **Invocation**: one call of an executable (a command run or a model call) inside an attempt. A retry is a new invocation. A provider batch is one invocation per item, each marked `via: 'provider-batch'`.
- **Step**: a named node of a flow. A step is declaration, not execution. Checkpoints name step paths.

## Entities

### Kinds (pure vocabulary, no backend)

| Builder | Produces |
|---|---|
| `H.work(name).schema(z).states(...).resources(fn)` | `WorkKind<T>` |
| `H.state(name).pending() / active() / succeeded() / failed() / cancelled() / ended()` | `State` (shareable) |
| `H.memory(name).content(z)` | `MemoryKind<C>` (the kernel adds the envelope) |
| `H.role(name).prompt().tools(...intents).recall(...kinds).record(...kinds).use(...plugins)` | `Role` |
| `H.skill(name).input(z).output(z).prompt(fn)` | `Skill<I, O>` |
| `H.blocker(name).resolution(z)` | `Blocker<R>`: the vocabulary of a halt and its typed answer |

### Instances (carry a backend)

| Builder | Backend |
|---|---|
| `H.account(name, driver).ledger(quotaLedger?)` | `ModelDriver`, plus optionally the `QuotaLedger` that holds its quota state |
| `H.model(name, accountOrPool, modelId)` | via the account |
| `H.runner(name, backend).slots(n).env({...}).preflight(command)` | `RunnerBackend` (`harness-dsl/local`, `harness-dsl/ssh`) |
| `H.command(name).input(z).output(z).runner(...).env({...}).run(fn)` | runs on a runner, or in-process when no runner is given |

### Pivots (each has a noun)

| Pivot | Connects | Produces |
|---|---|---|
| `H.pool(name, accounts).policy(p).maxShare(account, r).fallback(a)` | accounts × choice policy × per-harness share caps | an account to bill |
| `H.pool(name, models).policy(p)` | models × choice policy | a model to call |
| `H.agent(name).role(r).model(m)` | role × model | something that can perform a skill: `skill.by(agent)` is an executable |
| `H.lane(name).of(kind).from(...).store(s?).handle(flow, settings?).wip(n).deadline(fn).maxUsdPerUnit(usd, {onExceed})` | work kind × suppliers × store × handler | units, scheduled |
| `H.journal(name).of(memoryKind).store(s).recall(p)` | memory kind × store × recall policy | recalled items |
| `H.trigger(name).on(source).add(lane, fn) / .transition(state) / .record(journal, fn)` | ledger source × consequence | a recorded firing |
| `H.metric(name).over(source).sample(fn)` | ledger source × owner-defined sampling | a rate with samples |

### Execution and wiring

- `H.flow(name).for(...kinds)` yields `Flow<U, V, S>`: unit data `U` (a union over the kinds), current value `V`, settings `S`. Methods: `settings`, `step`, `map`, `patch`, `parallel`, `batch`, `loop`, `when`, `transition`, `halt`, `haltIf`, `spawn`, `onError`. Sub-flows (loop body, `when` branch, parallel branches) are builder callbacks, so values infer end to end.
- `H.policy.schedule / choose / recall(name, fn)` all produce one entity, `Policy<Ctx, Out>`. The three constructors exist only so the context type infers.
- `H.scheduler(name).concurrency(n).policy(p)`.
- `H.supervisor(name).client(c).grant(...ops)`, `H.ops.*`, `H.operation(name, command)`.
- `H.harness(name).ledger().lanes().journals().triggers().metrics().scheduler().supervisor().observe()`, then `await start()`.
- References: `H.env(name)`, `H.slot.port(n)`. Both are resolved by the runtime only.

## Rules

1. **Skeleton.** The six unit outcomes are pending, active, succeeded, failed, cancelled and ended. `ended` is a terminal outcome that carries no verdict (parked, inconclusive, churn, walk-away, expiry). Kinds refine outcomes with named states. A transition to a terminal state ends the current attempt.
2. **Success rate** = succeeded / (succeeded + failed). `samples` is exactly that denominator. Cancelled and ended are counted in `byOutcome` and never move the rate. `byState` separates states that share an outcome, for example `loaded` from `loaded-with-warnings`, or `a-wins` from `inconclusive`.
3. **Capacity is held by running attempts, never by units.** A unit in an `active` state with no attempt (a tenancy between reviews, a negotiation awaiting the vendor, an epic waiting on children) occupies nothing. Scheduler concurrency and runner slots count only `running` attempts. Lane WIP counts units with an open attempt, whether running or blocked.
4. **Scheduling.** Only units in a `pending` state are candidates. The schedule policy orders them and may name running attempts to preempt. A preempted attempt is cancelled and its unit returns to pending; the unit's state is unchanged. The kernel then enforces WIP, runner slots, account eligibility and concurrency, in that order.
5. **Supply is upsert.** A supplier emits `{ key, data }` (create, or replace if the key exists) or `{ key, patch }` (update an existing unit only; an unknown key is dropped and recorded). Either form may carry a `state`. Every update is a recorded `update` event and a trigger source. Scenario 8's vendor reply and scenario 3's weekly reopen are both supplier patches.
6. **Trigger sources** are `lane.enters(...states)`, `lane.updated()`, `lane.overdue()` (the lane's `deadline` has passed while the unit is non-terminal) and `lane.resolved(blocker)`. Any source can be narrowed with `.where` and made into a pattern with `.streak(n, { matches, groupBy })`. Sources are built only from ledger records. Overdue events are written to the ledger by the kernel's clock before any trigger reads them, so time-based firings are also recorded.
7. **Trigger consequences** are `add` (create a unit in a lane), `transition` (move the source unit; this cancels its open attempt if there is one) and `record` (write a memory item, with `{ candidate: true }` for curated memory). One trigger may chain several consequences, and each firing writes one trigger record per consequence. A trigger that names a lane, state or journal not registered in the harness fails at `start()`.
8. **External cancellation** is `trigger.on(lane.updated().where(...)).transition(state)`. The kernel cancels the open attempt, records the cancellation and moves the unit.
9. **Unit cost ceiling.** `lane.maxUsdPerUnit(usd, { onExceed })` is checked before every invocation against the unit's ledgered spend. `halt` blocks the attempt on the kernel blocker `cost-ceiling`; `fail` fails the attempt.
10. **Deadlines.** `lane.deadline(unit => Date | null)` feeds both `PendingUnit.deadline` for the scheduler and the `overdue` source.
11. **Retry** is declared on a step (`{ retry: { maxRetries, backoff } }`). Each retry is a new invocation inside the same attempt.
12. **Halts survive restarts.** Every step completion and every halt writes a checkpoint (step path, value as JSON). On `start()`, the kernel reads `ledger.openAttempts()`. Blocked attempts stay blocked. When resolved, they resume at the checkpointed step with the resolution as the value. Running attempts resume from their last checkpoint.
13. **Spawn ends the attempt.** `spawn(name, lane, items, { waitIn, resumeIn })` creates children, moves the parent to `waitIn` and ends the attempt without holding a slot. When every child is terminal, the parent moves to `resumeIn` (a pending state) and its flow runs again with `ctx.children`.
14. **Lane settings replace per-kind duplication.** `flow.settings(z)` declares the parameters a flow needs, and `lane.handle(flow, settings)` supplies them. Bug and Feature share one flow with `maxRounds` 3 and 5.
15. **Memory.** Roles recall and record by memory *kind*. Recall unions every registered journal of that kind, each ranked by its own recall policy. A role, trigger or command that writes a memory kind needs exactly one registered journal of that kind, or names the journal explicitly (`trigger.record(journal, …)`, `ctx.record(journal, …)`). An ambiguous write fails at `start()`. Candidate items are never recalled until curated through `H.ops.memory.curate`. A journal with no recall policy is valid: its items are read through `H.ops.memory.read` and never injected into a prompt.
16. **Recall stays deterministic.** A store may implement `similar()`. The kernel passes the store's similarity scores into `RecallContext` as data, and the recall policy only ranks and cuts.
17. **Account state.** An account's quota state lives in a `QuotaLedger`: by default the harness's own ledger, or another one named with `account.ledger(...)`. Any `Ledger` is a `QuotaLedger`, so a dedicated SQLite file shared by two harnesses is just a second ledger used only for quota. Two harnesses that import the same account definition share quota state through that ledger and re-read it before every invocation. Share caps (`pool.maxShare`) and runtime share changes are per harness and live in each harness's own ledger as `share` records.
18. **Metrics** are synchronous reads over a ledger snapshot taken at decision time. Owner metrics must be registered with `harness.metrics(...)`. Every result carries `samples`. Rates are `null` at zero samples, never 0.
19. **Startup validation** (`start()` rejects): two descriptors with one name; a transition to a state the lane's kind does not declare; an unregistered lane, journal or metric referenced by a trigger, spawn or metric; an ambiguous memory write; a lane without a handler; a harness without a scheduler.
20. **Roles name intents, not tools.** Examples are `read-files`, `edit-files` and `run-commands`. Each driver maps intents to its own tools.

## What changed and why

Compared with the brief:

- **Added `ended()` as a sixth outcome.** Scenarios 3 and 8 need terminal outcomes that are neither success nor failure. Mapping them onto succeeded or failed would be a lie. See *Principles broken*.
- **Trigger sources beyond transitions:** `updated()`, `overdue()`, `resolved(blocker)`, and the `.where` / `.streak` combinators. These cover external events (scenario 2), time (scenarios 2, 5, 8), patterns (scenario 4) and editor actions (scenario 6), with no new entity.
- **Trigger consequences moved onto the trigger:** `.add(lane, fn)`, `.transition(state)`, `.record(journal, fn)` replace `lane.add(...)` passed into `.do(...)`. The event type now infers without generics flowing backwards. `transition` covers external cancellation and time cancellation. Running an arbitrary executable as a consequence was dropped because no scenario needs it.
- **Supply became upsert**, with the `patch` form for update-only suppliers (scenario 8).
- **`lane.deadline` and `lane.maxUsdPerUnit`**: deadlines and unit cost ceilings are lane relationships. They are not kind properties (principle 10).
- **`H.metric(name).over(source).sample(fn)`** gives owner-defined rates (citation pass rate, approval rate by category, editor acted-on), with samples.
- **`H.blocker`** gives halts a typed resolution, so a resolution can be both a flow value and a trigger or metric source.
- **Flow changes.**
  - `.for(...kinds)` replaces `.input(zod)` (weakness 11).
  - `.settings` plus lane-supplied settings handle per-lane parameters.
  - `.map` reshapes values and `.patch` writes unit data.
  - `step(name, exec, { input, retry })` replaces the positional `mapInput`.
  - `spawn` ends the attempt (weakness 2).
  - Callback sub-flows give full inference.
  - Dropped, because nothing in the battery calls them: `use`, `branch`, `finally`, and the skill methods `assert`, `maxRetries`, `handoffWhen`.
- **Runners became `H.runner(name, backend)`.** "ssh" is a tool name and may not appear in `H.*`. Local and SSH backends now live in subpaths, consistent with `H.account(name, driver)`.
- **Account changes.** `maxQuotaShare` moved from account to `pool.maxShare`, because a share is a per-harness relationship and the account is a shared instance. `account.ledger(quotaLedger)` names where quota state lives (scenario 7). `quotaPolicy` was dropped; drivers report windows.
- **`H.model` takes a name**, so one model id on two accounts yields two distinct entities. `.pricing` was dropped; the driver reports cost, including any provider-batch discount.
- **Role `.tools` takes intents** (weakness 3). `promptFile` was dropped.
- **Supervisor changes.** `.tool` was dropped in favour of `H.operation`. `contextNotice` was dropped. `H.ops.memory.curate` was added for scenario 6. Transport is the `Client`'s concern: `harness-dsl/http` for plain HTTP, `harness-dsl/claude-code` for a session.
- **`harness.metrics(...)`** registers owner metrics, so the kernel can compute them.
- **The scheduler takes a name** (every entity has one). The decision may preempt running attempts.
- **New adapter subpaths:**
  - `zendesk` (helpdesk)
  - `ghost` (CMS)
  - `lancedb` (vector memory store)
  - `folder` (markdown supply and frontmatter store)
  - `slack` (observer)
  - `http` (control client)
  - `local` and `ssh` (runner backends)
  - `supply.webhook` (generic webhook supplier)
- **Execution vocabulary defined**, and checkpoint, quota, share and recall records specified (weaknesses 10 and 16).
- **Added `H.ops.memory.read`** while writing the battery. Scenario 4's operational-experience journal is read by the supervisor and by no agent. Without a read operation, a memory kind that no agent recalls is unreachable, and granting `memory.write` to obtain reads would over-grant (principle 17: operations, not capabilities, are granted).
- **Recorded authoring pattern (no surface change).** When a policy inside a lane's handler reads an owner metric whose source is that same lane (scenarios 2, 3, 6), the policy body references the metric from a function declaration with an explicit signature. This avoids a circular initializer. The dependency is real: the metric describes the lane's history, and the lane's handler reads it at decision time. Making `Metrics.rate` accept the metric's name alone would hide the reference from startup validation, so the typed reference is kept.

## Principles broken

- **12.** The skeleton has six outcomes, not five. `ended` is a terminal outcome with no verdict. The battery requires terminal outcomes that are neither success nor failure (parked, inconclusive, churn, walk-away, expiry), and principle 12's own wording ("success is defined on the skeleton") cannot hold if those must be filed as succeeded or failed.

  What success rate means afterwards: succeeded / (succeeded + failed), with `samples` equal to that denominator. Ended and cancelled units are counted separately in `byOutcome` and distinguished by state in `byState`. The scheduler treats every terminal outcome identically: the unit is no longer a candidate.
