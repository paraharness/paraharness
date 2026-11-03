# harness-dsl: minimal, without the scheduled supplier (g01, from g00-minimal-0)

**Operator: delete.** The entity removed is the **scheduled supplier** (`H.schedule(name, kind, at, produce)`).

Time is now a trigger source, and making work is a trigger consequence. A schedule is a trigger, `H.on.clock(at)` → `act.create(lane, …)`, exactly as principle 13 describes it.

The rest of this child repairs the parent against the amended principle 12 and against the adversary's critique. It also gains the surface that scenarios 9 and 10 need; the parent had no files for those two.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` | A shareable named state. It declares its position, and its verdict if terminal. |
| Kind | **kind** | `H.kind(n).data(z).states([...], { initial, afterFailure, afterCancel })` | A sort of work: a data shape plus states. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. It names intents, not tools. |
| Kind | **memory** | `H.memory(n, 'fallible' \| 'owner')` | A memory kind. Experience is fallible; taste is the owner's. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each carrying its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params).suppliers(...).store(s).wip(n).maxUsdPerUnit(x)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | A recall source: memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, members, policy)` | The account serving a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Composite | **flow** | `H.flow(n).for(...kinds).params(z).does(async ctx => …)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(runner).restart(rule)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model,account,scheduler,recall,retry,rule}` | Deterministic decisions. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger(l).lanes().pools().triggers().scheduler(p).clients().observers()` | The running thing. |

`H.operator` is the only supplier without a backend, because the control API is kernel. `H.schedule` no longer exists.

## Execution vocabulary (one definition each)

| Term | Definition |
|---|---|
| **Run** | One lifetime of a harness process holding the ledger claim. |
| **Attempt** | One execution of a lane's flow for one unit. It is running, blocked (a halt is open) or parked (needs the supervisor), and it ends `succeeded`, `failed` or `cancelled`. |
| **Step** | One recorded call a flow makes on `ctx`: `run`, `batch`, `halt`, `spawn`, `remember`, `update`, `move` or `decide`. Steps are numbered in order and are the unit of durability. |
| **Invocation** | One execution of one executable within a `run` or `batch` step. A retry is a new invocation of the same step, and each batch item is an invocation. |

## Rules

### 1. Lifecycle (principle 12, repaired)

**States and positions.**
- States are entities and are shared across kinds by import.
- Each state has a position: `pending`, `active`, `waiting` or `terminal`.
- Terminal states must declare a verdict: `success`, `failure` or `neutral`. There is no default.

**Attempts.**
- An attempt has three outcomes: `succeeded`, `failed` or `cancelled`.
- Blocked is an attempt state, not a unit state.

**What moves the unit when an attempt ends.**

| How the attempt ends | Attempt outcome | Where the unit goes |
|---|---|---|
| The flow returns a non-active state | `succeeded` | That state |
| The flow returns `ctx.until(rest, wake)` | `succeeded` | `rest`, which is waiting, with a wake condition |
| The flow returns `ctx.fail(reason)`, or throws | `failed` | The kind's `afterFailure` state |
| Preemption or operator cancel | `cancelled` | The kind's `afterCancel` state |
| An external move (supplier, trigger, operation) | `cancelled` | The move's target |

The kind declares both `afterFailure` and `afterCancel` explicitly. This removes the parent's lie, where a model failure was recorded as "vendor replied".

**Verdicts fixed by the scenarios.**
- Parked, inconclusive, A/B wins, churn, walk-aways, expiry and rejected are `neutral` terminals.
- Loaded-with-warnings is a second `success` terminal, distinct by name.
- Tenancy has no terminal except churn. Between reviews it is `waiting`.

### 2. Success rate

For a kind, success rate is:

> success-verdict terminal entries ÷ (success + failure)

Every rate carries `hits` and `samples`. Neutral entries are excluded from that denominator. They are countable with `rate` and `count` by `state` or by `verdict: 'neutral'`.

Agent, model, runner and account track records are attempt outcomes. A crash-interrupted invocation is marked `interrupted` and is excluded from both success and failure.

### 3. Waiting units hold nothing

- A waiting unit holds no WIP and no runner slots, and it is not schedulable.
- It wakes when its time arrives, when its children end, or when a supplier update, a trigger or an operation moves it.
- Any recorded move clears the wake condition. A suspended tenancy cannot wake into review.

### 4. Durability (scenario 10)

The ledger is the only state.

**Step recording.** Each step records `started` before any effect and `ended` with its output. Drivers record a resumable handle through `InvocationContext.handle` (a session id or a batch id) before they do the work.

**Replay on restart.** The kernel re-executes the flow body. Steps already recorded as `ended` return their recorded output and cost nothing.

**The step that was in flight.** For a step that was started but not ended, the kernel applies the executable's `RestartRule`:

| Rule | Behaviour after restart |
|---|---|
| `'rerun'` | Run it again. |
| `'park'` | Park the attempt for the supervisor. This is the default for commands. |
| `{ verify }` | Run the verify executable. A non-null result is taken as the step's output; null parks the attempt. |
| `'ask-driver'` | Call `recover(handle)`. This is the default for agents. `running` keeps waiting, a result is taken as the output, and `unknown` parks the attempt. |

**Batches.** A `batch` step with a recorded batch id is collected, never resubmitted.

**Halts.**
- A halt resolved while the harness was down is found on restart.
- Control clients may run against the ledger without holding the run claim. They append only `operation` and `halt` entries.

**Children.** `spawn` followed by `until(rest, { children: true })` ends the attempt. On restart, the kernel compares child positions on the ledger and wakes the parent if they are all terminal. Running children keep their own attempts.

**Definition changes.**
- Every attempt records its flow's `fingerprint`, a hash of the body and the step targets.
- If the fingerprint differs on restart, the attempt is parked with reason `definition-changed`.
- `H.ops.recoverAttempts` grants `attempts.restart` (from the top, same unit) and `attempts.abandon`.

**Identity and track record.** A resumed attempt keeps its id. The crash is recorded as a `run` entry, never as an invocation failure.

**Single writer.**
- `start()` calls `ledger.claim(holder, ttl)` and renews the claim while running.
- A second process is refused while the claim is live. It takes over only after the claim expires, and records `took-over`.

**What the harness author writes for durability:** `.restart(...)` on commands that are not the default. Nothing else.

### 5. Flows speak the kinds they declare

`.for(Bug, Feature)` types the flow's data as the union of both kinds. Its states are the shared state entities. Per-lane differences, such as rounds, arrive as `params`.

### 6. Supply

- A supplier emits `create` or `update`. A `create` is ignored while a non-terminal unit with that key exists.
- An `update` may move a unit, including re-opening it.
- The ledger keeps a snapshot of every unit, so a kind with no store still has data and telemetry.

### 7. Triggers (principle 13)

**Sources.**

| Source | Fires on |
|---|---|
| `enters` | A unit entering one of the given states. |
| `streak` | A pattern across transitions, grouped by a key. |
| `deadline` | A due time read from unit data. It is re-armed on every recorded data change, so an extended SLA moves its timer and the old deadline never fires. |
| `clock(at)` | Pure time. |
| `clock(at, kind, whileIn)` | Time, once per unit in the given states. |
| `metric(read, { trips, resets, minSamples })` | Hysteresis per group. It fires once on a trip and once on a reset, and only when the samples meet `minSamples`. |

**Effects.** `create`, `move` (the source unit), `moveIn(lane, key, state)`, `remember`, `pause(lane)` and `resume(lane)`.

**Recording.**
- Every firing is a `firing` entry carrying its group, phase, value and samples.
- Pause and resume are `lane` entries carrying the metric value that caused them.
- `metrics.count(... by 'group')` and `metrics.pausedMs` query these entries.
- A paused lane starts nothing; its running attempts finish.

**Deduplication.** Deduplication by group is the `create` key rule from rule 6 combined with hysteresis.

### 8. Asking

An agent whose driver responds `asked` raises a kernel halt named `ask:<agent>`. Resolving that halt re-invokes the agent with the answer. `ctx.halt` remains the way a flow asks.

### 9. Cost

`maxUsdPerUnit` is cumulative across a unit's attempts. An invocation that would pass it halts the attempt with the halt `cost-ceiling`. Daily budgets are scheduler-policy reads of `metrics.sum`.

### 10. Scheduler

One `H.policy.scheduler` returns `start` and an optional `preempt` list. The kernel enforces:
- lane WIP limits and lane pause;
- runner slots;
- account eligibility, read fresh from `ledger.quota` at each decision.

Blocked attempts count toward WIP but release their runner slots.

### 11. Accounts

- Account window state is ledger state, in `Ledger.quota`, which is a composed part of the ledger rather than a supertype of it.
- Two harnesses share account state by giving their ledgers one quota backend (`sqlite.ledger(path, { sharedQuota })`).
- Accounts no longer select a quota book, which removes the parent's split-brain declaration.
- Shares belong to the pool, and therefore to one harness.

### 12. Memory

- The kernel owns the envelope.
- Candidates are not recalled until they are accepted.
- Recall is always a recall policy over what the store's `search` returns.
- Reads union across every library an agent `recalls`. Writes go to the one library it `records`.

### 13. Startup validation

`start()` fails in each of these cases:
- duplicate names;
- a terminal state without a verdict;
- `initial`, `afterFailure` or `afterCancel` naming a state outside the kind;
- a lane/flow mismatch;
- an unknown state in a trigger;
- a trigger naming an unregistered lane;
- an agent that no pool can serve;
- a batch on a model without `submitBatch`;
- `'ask-driver'` on an executable that has no `recover`.

Zero pools, agents and models is valid.

## What changed and why

**Deleted: `H.schedule`.**
- Time-driven supply is `H.trigger(n, H.on.clock(at), (e, act) => act.create(lane, data, key))`. Re-opening recurring topics is `H.on.clock(at, Topic, terminalStates)` → `act.move('queued')`.
- This removes one of the four time and "schedule" mechanisms the adversary counted (principle 22).
- The scheduler policy is renamed `H.policy.scheduler`, so "schedule" now means only the thing that decides what runs next.

**Principle 12 repaired.**
- States are entities with a position and a verdict.
- The four positions replace the seven outcomes; attempt outcomes are back to three.
- `afterFailure` and `afterCancel` are declared on the kind, and `ctx.fail` exists, so flows no longer route failures to states that lie.

**Scenario 9 surface:**
- the `metric` source with `trips`, `resets` and `minSamples`;
- the `pause` and `resume` effects, with `lane` entries;
- `moveIn` for cancelling an open Audit;
- `metrics.count` and `metrics.pausedMs`;
- `Window.hours`;
- deadline re-arming.

**Scenario 10 surface:**
- steps defined and recorded;
- `RestartRule` on commands and agents;
- driver `recover`, `submitBatch` and `collectBatch`;
- flow `fingerprint`, and parked attempts with `ops.recoverAttempts`;
- `Ledger.claim` and `renew`.

**Critiques answered:**
- Quota is composed into the ledger, not a supertype of it.
- Agent asks become kernel halts, so there is one ask mechanism.
- A suspended unit cannot wake into review, because moves clear wake conditions.

**Not done:**
- A resource entity (seed weakness W4). Runner selection by data still uses `.on(input => runner)`.
- Per-invocation timeouts. No battery scenario requires them.

## Principles broken

**16 (bent, stated).**
- Principle 16 lists "schedule" among suppliers. Here, time-driven work comes from a trigger with a time source whose consequence creates units.
- That is precisely principle 13's description ("a trigger connects a source (… time …) to a consequence (create work in a lane)").
- Keeping a scheduled supplier as well would give two mechanisms for one thing (principle 22).
- The three pillars stand unchanged: suppliers (webhook, poll, folder, tracker, operator), stores and the scheduler.

No other principle is knowingly broken.
