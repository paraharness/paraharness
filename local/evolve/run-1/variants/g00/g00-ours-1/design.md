# harness-dsl: variant "ours" (seed)

`h.d.ts` is the DSL that authors write against. `kernel.d.ts` (module `harness-dsl/kernel`) holds two things: the interfaces a backend implements, and `define.*`, which wraps an implementation as a descriptor.

`kernel.d.ts` imports from `harness-dsl`. `h.d.ts` imports nothing from the kernel. The DSL therefore compiles without any backend, which is the delete test applied at the type level.

## Vocabulary of execution (one word each)

- **Run**: one lifetime of a harness process, from `start()` to `stop()`. The ledger records it so restart recovery can tell old runs from the current one.
- **Attempt**: one execution of a lane's handler flow for one unit. A unit may have many attempts: retries, Epic re-entry after children, negotiation rounds, monthly tenancy reviews, hourly experiment samples.
- **Step**: a named node of a flow (`step`, `batch`, `halt`, `loop`, `parallel`, `spawn`). It is a definition, not an execution.
- **Invocation**: one execution of an executable inside an attempt. A retried step produces several invocations. A batch produces one invocation per item. A loop produces one invocation per iteration.

There are no other execution words. "Job" and "task" are not used. `AgentTask` in the kernel is the driver's request payload for one invocation.

## Entities

### Kinds (vocabulary only, no backend)

- **Work kind**: `H.work(name).schema(z).states(...).key(fn).resources(fn)`.
  - `key` is the unit's identity. Suppliers use it to update existing units. Identity is a property of the kind, not a relationship.
  - State names are carried in the type. `transition`, `enters` and `move` reject, at compile time, states the kind does not own.
- **State**: `H.state(name).pending()|active()|dormant()|succeeded()|failed()|ended()|cancelled()`. A named state mapped onto the skeleton. States are shareable across kinds.
- **Memory kind**: `H.memory(name).content(z).taste()`. A kind of memory item; without `.taste()` it is experience. The kernel owns the envelope: id, kind, createdAt, `when`, status (`candidate | active | dropped`), mergedInto.
- **Role**: `H.role(name).prompt().tools(...intents).recall(...).record(...)`.
  - Tools are kernel **intents** (`read | edit | execute | search | fetch | ask`). Drivers map them to their own tool names (known weakness 3).
  - `ask` lets the agent halt its attempt for an owner decision.
- **Skill**: `H.skill(name).input().output().prompt().assert().maxRetries()`. A typed contract for one model invocation.

### Instances (carry a backend)

- `H.account(name, driver).quota(quotaStore?)`.
- `H.model(name, accountOrPool, modelId).pricing(p)`.
- `H.command(name).input().output().runner().env().run(fn)`. A command body may record memory through `context.record(journal, draft)`.
- Runners come from `harness-dsl/runners` (`local`, `ssh`) and are configured with `.slots(n).env().preflight(check)`.

### Pivots (each with a noun)

| Pivot | Connects | Produces |
|---|---|---|
| `pool` | candidates (accounts, models **or runners**) × pick policy, with optional `maxShare` and `fallback` | a choice |
| `agent` | role × model (or model pool) × plugins | an executable per skill (`agent.perform(skill)`) |
| `lane` | work kind × suppliers × store × handler flow (+ params, WIP, per-unit cost ceiling) | units and their attempts |
| `journal` | memory kind × memory store × recall policy | recalled items |
| `trigger` | source × consequence | a firing |
| `supervisor` | endpoints × granted operations | a control surface |
| `harness` | ledger × lanes × journals × triggers × scheduler × supervisor × projections | a run |

Account quota shares are per harness. They therefore live on the pool (`pool.maxShare(account, 0.6)`), not on the account, which keeps the account reusable across harnesses (scenario 7).

## Lifecycle skeleton (changed: seven outcomes)

| Outcome | Terminal | In the queue | Holds capacity |
|---|---|---|---|
| pending | no | yes | no |
| active | no | no | yes, while an attempt runs |
| dormant | no | no | no |
| succeeded | yes | no | no |
| failed | yes | no | no |
| ended | yes | no | no |
| cancelled | yes | no | no |

**Meaning of the two new outcomes**

- **dormant** is a non-terminal state that waits for the world: the next monthly review, the vendor's reply, the next hourly sample, or the children of a spawn. A dormant unit leaves its state only through a trigger `move`, a supplier `update`, or the spawn rule.
- **ended** is a terminal state that is neither success nor failure: parked, inconclusive, A wins, B wins, churn, walk-away, rejected by the approver, expired.

**Metrics on the skeleton**

- **Success rate** = succeeded / (succeeded + failed). It is `null` when that denominator is zero.
- `samples` counts every terminal transition. `ended`, `cancelled` and `byState` are always reported beside the rate.
- "How often are experiments inconclusive" is `byState.Inconclusive / samples`.
- **Loaded with warnings** is a second succeeded-mapped state. The scheduler and the success rate treat it as success; `byState` and the board distinguish it.
- A unit counts as one sample per terminal transition. A reopened unit (a recurring Topic) contributes again.
- When `step` is given in an outcome query, the sample is that step's invocation pass/fail instead. Owner-defined pass rates (the citation check) are expressed this way.
- `model` filters to attempts that invoked that model.

**Transition rules**

- Blocked remains an attempt state, not a unit state.
- Transitioning to a non-active state ends the attempt immediately.
- An uncaught step failure moves the unit to the kind's first failed-mapped state.
- A cancellation moves the unit to the kind's first cancelled-mapped state.
- A preempted attempt returns the unit to the pending state it held before the attempt started.

## Supply, store, scheduling

**Suppliers** offer `create`, `upsert` or `update` (patch by key).

- Typed suppliers are `Supplier<D>` and are checked against the lane's kind.
- Raw suppliers (folder, manual) are `Supplier<Unparsed>` and are validated by the kind's schema at intake.
- `webhook.update({ kind, ... })` is a supplier that only updates existing units (Negotiation, Tenancy).
- Updates are recorded as `unit.updated` and are visible to triggers through `lane.updated()`.

**Stores** hold domain state. A lane with no store keeps only the ledger's envelope and the payload as offered. A flow with `.update` on a storeless lane fails at `start()`.

**Scheduler**: `H.scheduler(name).concurrency(n).policy(p)`.

- The schedule policy sees pending and running units. Through `ctx.of(lane)` it sees them with typed data, which is how it orders by SLA.
- It returns `{ start, preempt? }`.
  - `start` is ordered and may be a subset. The subset is how the daily budget and "no Backup while an Incident is active" are expressed.
  - `preempt` cancels running attempts with the actor `scheduler`.
- After the policy, the kernel applies lane `wip`, runner slots, preflight checks and account eligibility, in that order.
- Account eligibility is re-read from the quota store at every decision.

## Triggers

`H.trigger(name).on(source).where(pred)` followed by exactly one consequence:

- `.create(lane, fn)`
- `.move(state)`
- `.run(executable, fn)`
- `.record(journal, fn, { candidate })`

Lanes produce the sources:

- `enters(...states)`: a transition.
- `updated()`: an external change to an existing unit.
- `deadline(unit => Date | null, { during })`: time, computed from unit data.
- `streak(state, n, { by })`: a pattern of n consecutive terminal transitions within one group.

Time is not a side channel. The clock records `deadline.passed` in the ledger, and the trigger fires from that event, so principle 13 holds.

`move` on a unit with an active attempt cancels the attempt first. That covers external cancellation (scenario 2) and expiry (scenario 8).

Alerting is a trigger that runs an executable (`slack.message`); it is not an observer. What remains of observers is **projections** (board, telemetry), which render ledger snapshots.

## Memory

- Writes go to exactly one journal per memory kind per harness. Registering two journals of one kind fails at `start()`, which removes the asymmetry of known weakness 12.
- Roles `recall` kinds, and recall goes through the journal's deterministic policy. The store supplies `similarity` when it can (`lancedb`); the policy decides with it.
- Items injected into an attempt are recorded (`memory.injected`). Track record is computed from that record.
- `record(..., { candidate: true })` creates candidates. Recall ignores them until the `memory.curate` operation accepts, merges or drops them.
- Memory is written by four writers:
  - an agent's role (`record`);
  - a trigger consequence;
  - a command body (`context.record`);
  - the supervisor (`memory.write`).
- The supervisor reads memory through `memory.read`.

## Human in the loop and restart

- `.halt(name, { ask, decision })` is a step whose output is the typed decision.
- Blockers are created by three things:
  - a `halt` step;
  - an agent's `ask` intent, resumed through the driver's `resumeToken`;
  - the lane's `maxUsdPerUnit`, when the next invocation's projected cost would cross the ceiling.
- Every step output, the cursor and the blocker are in the ledger.
- On restart, open attempts whose status is `blocked` stay blocked. On resolution they resume at the recorded cursor using recorded outputs, so earlier steps are not re-executed.
- Running attempts of a dead run are failed with reason `run-lost`, unless the step's `retry` allows re-invocation.

## Startup validation (`start()` fails on)

- Two descriptors with one name.
- A state used by a flow, trigger or lane that the kind does not own.
- A trigger on an unregistered lane.
- Two journals of one memory kind.
- `.update` on a storeless lane.
- A kind with no failed-mapped state whose flow has steps that can fail.
- A pool `fallback` that is not of the pool's candidate sort.
- An endpoint granted an operation that has no executable.
- A `context.record` journal that is not registered on the harness.

## Accounts across harnesses

Account quota state is **a backend of the account instance**. It is not part of the ledger and not a second kernel store.

- `H.account(...).quota(store)` selects it.
- Without `.quota`, the harness's ledger serves it, because `Ledger extends QuotaStore`.
- Two harnesses that share accounts give them one `sqlite.quota(sharedPath)`. `reserve` is atomic against `maxShare` per harness.
- Runs, attempts and telemetry stay in each harness's own ledger.

## Choices where the brief was open (less obvious option taken)

1. **The skeleton grows by two outcomes** (`dormant`, `ended`) rather than adding attempt-level tricks. Perpetual units and neutral endings are first-class, so no named state has to lie.
2. **Spawn ends the attempt.** The parent moves to `wait` (dormant). When all children are terminal, the kernel moves it to `resume` (pending), and the flow re-enters with `scope.children`. No slot is held (known weakness 2).
3. **Flows declare the kinds they serve** (`H.flow(n).of(Bug, Feature)`).
   - Input is the union of their data.
   - Transitions are limited at compile time to the states common to all of them.
   - Per-lane differences are typed flow **params** (`lane.handle(flow, { rounds: 3 })`).
4. **Retry is a step option**, `{ retry: { maxRetries, backoff, initialDelayMs } }`, not a policy entity.
5. **Pools also hold runners**, so "two SSH hosts" is a pool with a pick policy rather than a new noun.
6. **Plugins attach to agents, not roles.** Worktree and file lease are execution relationships, and roles stay vocabulary.
7. **The supervisor serves endpoints** (`claudeCode.endpoint`, `http.endpoint`) instead of owning one client. Transport is the endpoint's business (known weakness 15). One owner session can attach to the endpoints of two harnesses.
8. **Flow scope carries read-only `metrics`.** An approval gate ("halt unless this category is proven safe") is therefore a deterministic predicate over the ledger.
9. **Batch steps take `deferred: true`.** The driver may then submit one discounted cloud batch; each invocation records `batched`, and pricing applies the batch rate.
10. **Loops carry one typed value between iterations** (`carry`). The next iteration sees the previous one's carry under the loop's name in `scope.steps`, and `null` on the first iteration.

## What changed and why

Versus the brief:

- **Skeleton**: added `dormant` and `ended` (scenarios 3, 5, 8).
- **Kinds**: added `.key()` on work kinds, so suppliers can update units and triggers can re-open them.
- **Triggers**:
  - Added sources `updated`, `deadline` and `streak` (scenarios 2, 4, 5, 8).
  - Added the consequence `move`.
  - Consequences became trigger methods (`create/move/run/record`) instead of `lane.add(...)` values, which gives inference without relying on contextual return-type inference.
- **Accounts and quota**:
  - Added `quota(store)` on accounts and the `QuotaStore` interface, which `Ledger` extends (scenario 7).
  - `maxQuotaShare` moved from the account to `pool.maxShare(account, r)`.
  - `quotaPolicy` was removed.
- **Lanes and scheduling**:
  - Added `maxUsdPerUnit` on lanes (scenarios 2, 3).
  - The schedule policy returns `{ start, preempt }` (scenario 4).
- **Flows**:
  - Added flow `params`, and replaced `.input(zod)` with `.of(...kinds)`.
  - `haltIf` became `halt`, a typed decision step, used inside `when`.
  - Removed `branch`, `onError` and `finally`, because the battery does not need them.
  - Added `update` (patch unit data in its store) and `spawn` with `{ wait, resume }`.
- **Memory**: added memory status, candidates and the `memory.curate` operation (scenario 6); memory kinds got `.taste()`.
- **Supervisor**:
  - `supervisor.client()` became `supervisor.endpoint()`, with a new `http` adapter (scenario 4).
  - `contextNotice` and `tool` were removed; custom tools are `H.operation`.
- **Harness**: `observe(...observers)` became `projections(...)`, and alerting moved to triggers that run executables.
- **Policies**: `H.policy(name, fn)` became `H.policy.pick|schedule|recall`. It is one `Policy` entity whose context is typed per decision site.
- **Adapters**:
  - `H.runner.local/ssh` moved to `harness-dsl/runners`, because a runner has a backend (principle 7).
  - `gitWorktreeIsolation` became `harness-dsl/git` `worktree`.
  - `stopCommandHook` became `plugins.stopCheck(command)`.
  - `folder` moved to `harness-dsl/folder`, which is both supplier and store (frontmatter).
  - Added `harness-dsl/rest`, `harness-dsl/webhook`, `harness-dsl/lancedb` and `harness-dsl/slack`.
- **Naming**: `H.model` takes a name first, because every descriptor is named; `H.scheduler` also takes a name.
- **Removed from skills and roles**: `handoffWhen` and `promptFile`.

### Changes found while writing the scenario battery

- **`loop` gained `carry`** (scenario 1).
  - The builder of round n must see the auditor's deficits from round n−1. The body's builder only knew the steps before the loop, so the previous round's output was unreachable without a lie, such as an empty deficits list.
  - `carry: { schema, from }` declares one typed value that is fed forward.
  - The body sees it as `scope.steps[loopName]: Carry | null`.
  - The loop name became a literal type parameter.
  - No new entity was added.
- **`CommandContext.record(journal, draft)`** (scenario 6). The fact-check command records experience when it finds a repeat mistake. Before this change only roles and triggers could write. A command is an executable like an agent invocation, so it gets the same capability, directed at one journal.
- **`H.ops.memory.read`** (scenarios 4, 6). The supervisor reads the operational experience journal (scenario 4) and must see candidates before curating them (scenario 6). Operations are what a client is granted (principle 17), and reading memory was missing.
- **Expression choices** (no surface change):
  - **Scenario 3**: the weekly re-open of recurring topics is a `deadline` trigger over terminal states that `move`s the unit back to pending. A schedule supplier only creates units and cannot see existing ones; re-opening is a consequence over a known unit.
  - **Scenario 2**: "returns to classifying" is `move(New)`. A trigger may only move a unit to a pending state; moving it to an active state would leave an active unit with no attempt. The next attempt starts by transitioning to `Classifying` with the new message.

## Principles broken

- **12**: the skeleton is no longer five outcomes; `dormant` and `ended` are added.
  - Without `ended`, parked, inconclusive, churn and walk-away must be mapped onto succeeded, failed or cancelled, which scenario 8 calls a lie.
  - Without `dormant`, a years-long tenancy is either "active", holding capacity, or "pending", queued for work that is not due.
  - Success rate is redefined above as succeeded / (succeeded + failed), with every other terminal count reported beside it.
  - Scheduling is defined on the seven outcomes: only `pending` is schedulable, and only `active` holds capacity.
