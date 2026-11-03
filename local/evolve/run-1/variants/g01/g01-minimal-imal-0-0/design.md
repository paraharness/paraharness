# harness-dsl: minimal, renamed (g01, parent g00-minimal-0)

This generation's operator is **rename**. The weakest noun in the parent was *schedule*. It named three different things: a supplier (`H.schedule`), the scheduler policy (`H.policy.schedule`) and the harness setting (`.scheduler`). The clock vocabulary added a fourth name (`TimeSpec`, `H.on.clock`).

A reader seeing `H.schedule(...)` next to `H.policy.schedule(...)` cannot tell which one decides what runs next. That breaks principles 19 and 22.

The child gives each thing its own noun:

| Thing | Parent name | Child name |
|---|---|---|
| The supplier that produces units on a cadence | `H.schedule` | **calendar** (`H.calendar`) |
| The shape of a time | `TimeSpec` | **`Cadence`** |
| The trigger source on a cadence | `H.on.clock` | **`H.on.cadence`** |
| The thing that decides what runs next | `H.policy.schedule` | **scheduler** (`H.policy.scheduler`, `SchedulerPolicy`, `.scheduler(...)`) |

The word "schedule" now appears nowhere as a noun.

The current principle 12 (amended) also required the lifecycle repair described below. The parent's reason for breaking 12 no longer holds against the amended text, so the break is repaired.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, `H.state(name, 'terminal', verdict)` | A shareable named state with a position and, if terminal, a verdict. |
| Kind | **kind** | `H.kind(n).data(z).states([...] \| lifecycle, { initial, afterFailure })` | One sort of work: a data shape plus its states. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. It names intents, not tool names. |
| Kind | **memory** | `H.memory(n, 'fallible' \| 'owner')` | A memory kind. Experience is `fallible`; taste is `owner`. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota book, guard, observer, client | adapters | Specific resources carrying their backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params).suppliers(...).store(s).wip(n).maxUsdPerUnit(x)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store).recall(policy)` | A recall source: memory kind × store × recall. |
| Pivot | **pool** | `H.pool(n, members, policy)` | The account that serves a call: accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of a recorded source. |
| Pivot | **calendar** | `H.calendar(n, kind, cadence, produce)` | A supplier that produces units on a cadence. Kernel-owned, because the clock is kernel. |
| Composite | **flow** | `H.flow(n).for(...kinds).params(z).does(async ctx => ...)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(runner).onCrash(mode)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, recall, retry, rule}` | One entity with six decision shapes. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger(l).lanes(...).pools(...).triggers(...).scheduler(p).clients(...).observers(...)` | The running thing. |

The following are plain values and are never registered:

- `H.lifecycle(...states)` (a shareable list)
- `Cadence`, `Scope`, `Threshold`
- `H.env` and `H.slot.port`
- `H.operator`
- `DataOf` and `StateOf`

## Execution vocabulary

- **Run**: one lifetime of a harness process holding the ledger's writer claim.
- **Attempt**: one execution of a lane's flow for one unit.
  - Its status is `running`, `blocked` (a halt is raised; the attempt holds no runner slot) or `ended`.
  - An ended attempt has one outcome: `succeeded`, `failed` or `cancelled`.
  - A resumed attempt keeps its id.
- **Invocation**: one call of one executable inside an attempt.
  - A retry is a new invocation.
  - Each batch item is its own invocation.
  - Invocations and halts carry a sequence number within the attempt.
- **Step**: not a word in this design. What scenario 10 calls a step is an invocation or a halt.

## Rules

### 1. Lifecycle (principle 12 as amended)

**States.** A state is an entity: `H.state(name, position)`. A kind lists its states. Two kinds may share one state entity. Each state's position is one of:

| Position | Meaning |
|---|---|
| `pending` | Schedulable. |
| `active` | An attempt is live. |
| `waiting` | Parked. The unit holds no capacity and is not schedulable. |
| `terminal` | Finished. |

**Verdicts.** Every terminal state declares a verdict, and there is no default:

| Verdict | Examples |
|---|---|
| `success` | `done`, `loaded`, `loaded-with-warnings` |
| `failure` | `abandoned` |
| `neutral` | `inconclusive`, `parked`, `churned`, `walked-away-us`, `cancelled` |

**Where a failed attempt leaves the unit.** Every kind declares `afterFailure`, the state a unit enters when an attempt fails.

**Attempt outcomes:**

| Outcome | How it happens |
|---|---|
| succeeded | The flow returns a state or an `until`. |
| failed | The flow returns `ctx.fail(reason)`, or throws. The unit then moves to the kind's `afterFailure`. |
| cancelled | The kernel stops the attempt (rule 7, preemption or abandonment). |

A flow therefore never disguises a failure as a state that means something else.

### 2. Rates

- Unit success rate is `success / (success + failure)` over terminal transitions.
- Neutral terminal states are excluded from that denominator. They stay countable by state name (`rate`, `countBy`).
- Attempt outcomes are the track record for models, agents, runners and accounts.
- Every rate carries `hits` and `samples`. `value` is `null` when there are no samples.
- Every metric read inside a policy is recorded on its `decision` entry.

### 3. The flow's return value

| Return value | Effect |
|---|---|
| A `pending` state | Re-queues the unit. |
| A `terminal` state | Ends the unit. |
| A `waiting` state | Parks the unit until a supplier, trigger or operation moves it. |
| `ctx.until(rest, { at \| children, then })` | Parks the unit with a wake condition. |
| An `active` state | Rejected at `start()` when it can be determined; otherwise the attempt fails. |

Any transition clears an armed wake condition. So a tenancy suspended by a supplier never wakes into review.

### 4. Flows speak the kinds they declare

- `.for(Bug, Feature)` types `ctx.unit.data` as `Bug | Feature`.
- Moves and returns accept only the states the declared kinds share.
- Per-lane differences are flow `params`.

### 5. Durability by replay

**What is recorded.** Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember` and `spawn` is a ledger entry with a sequence number. An invocation is recorded twice:

- `phase: 'started'` before it runs, carrying a driver `handle` once known;
- `phase: 'ended'` after it finishes.

**Replay.** On restart the kernel re-executes the flow body against the ledger. Recorded results return immediately at no cost. Flow bodies are deterministic: they use `ctx.now()` and do no ambient I/O. The author writes no resumption code.

**An invocation that was started but not ended** is handled by its executable's `onCrash` setting:

| Setting | Behaviour |
|---|---|
| `'rerun'` | Run it again. |
| `'park'` (the default) | Raise the kernel halt `crashed-invocation`; the supervisor decides `rerun`, `done` or `abandon`. If `happened` is declared, that command runs first; if it returns true, the invocation counts as done. |
| `'ask'` | Call the driver's `recover(handle)`. If the driver reports done, its result is used. If it reports running, the kernel waits. If it reports lost, the attempt parks. |

**Batches.** A batch records its batch id at submission. On restart it is collected, not resubmitted, and it is priced at the model's batch discount.

**Halts and children.** Halts resolved while the harness was down are found on restart, either in the ledger or in its inbox (rule 13). Children are units in the ledger. A parent's `until({ children })` is re-evaluated at start, and running children are not restarted.

**Definition changes.** Each attempt records a definition fingerprint (flow, executables, sequence of recorded names). If replay meets a mismatch, the attempt parks under the kernel halt `definition-changed`, and the supervisor chooses `restart` or `abandon`.

**What a crash counts as.** An interrupted invocation is recorded with `phase: 'interrupted'`. It is never counted as a failure of a model, agent, runner or account. The attempt keeps one id and one row.

### 6. Single writer

`start()` calls `ledger.claimWriter`:

- If a live holder exists, start refuses.
- If the claim has expired, the harness takes over, and records a `run` entry with status `took-over`.

The claim is renewed while the harness runs.

### 7. External moves

A move from a supplier update, from a trigger, or from `work.update` cancels any live attempt first.

### 8. Supply

- `create` is ignored when a non-terminal unit with that key already exists.
- `update` patches the store and may set a state, which can re-open a terminal unit.
- The ledger keeps each unit's snapshot, so store-less kinds still have data and telemetry.
- A calendar's `tick.units` lists every unit of its kind, terminal ones included, so a calendar can re-open them.

### 9. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts since the unit last left a terminal state. A re-opened recurring unit starts its ceiling afresh.
- An invocation that would exceed the ceiling raises the kernel halt `cost-ceiling`.

### 10. Scheduler

- The harness has one scheduler policy. It returns a `start` order and an optional `preempt` list.
- The kernel starts units in that order while WIP, runner slots and lane pause allow.
- Blocked attempts free their runner slots but still count toward WIP.
- Waiting units count toward nothing.

### 11. Accounts and quota

- Account state belongs to the **ledger's quota book** (`ledger.quota`), not to each account. So the ledger remains the kernel's only state.
- Harnesses that share accounts configure ledgers that share one quota book: `sqlite.ledger(path, { quota: sqlite.quota(shared) })`. The setting is made per harness, so one account cannot point at two books.
- Shares belong to the pool, and therefore to one harness.

### 12. Memory

- The kernel owns the envelope: `id`, `created`, `when`, `status`.
- Candidates are not recalled until they are accepted.
- Recall is a recall policy run over the store's `search` results.
- `run(..., { scope })` narrows the recall scope for one invocation.
- Reads union across the libraries an agent `recalls`. Writes go to the single library it `records`.

### 13. Control API

- The API is made of operations, and clients are granted operations.
- `harness.control()` opens the API without the writer claim. Its writes are posted to the ledger's inbox, which the running harness (or the next one to start) drains and applies as recorded `operation` entries. This is how a halt resolved while the harness is down is found on restart.

### 14. Triggers

**Sources:**

| Source | What it reads |
|---|---|
| `enters` | A transition. |
| `streak` | N consecutive entries into one state, grouped by a key. |
| `deadline` | A due date read from unit data. It is re-armed on every recorded data change; an old deadline never fires. |
| `cadence` | Time. It fires once per unit that is in one of the `whileIn` states at that time. |
| `crossing` | A metric threshold with hysteresis, per group. |

**How a crossing behaves:**

- It is evaluated after each ledger append.
- Groups below `minSamples` are skipped.
- It fires `entered` once when the `enter` threshold is crossed, and fires `cleared` once when the `clear` threshold is crossed.
- The last direction per group is derived from the ledger's `firing` entries.

**Effects:** `create` (with key and tags; deduplicated by key against non-terminal units), `move` (the event's unit, or a unit by lane and key), `remember`, `pause` and `resume`.

**Lane pauses.** A pause or resume writes a `lane` entry with the firing's value and sample count. It appears on the board and in `metrics.pausedMs`.

Every firing is recorded.

### 15. Agents asking

The `ask` intent is a driver's way to raise a halt.

- The kernel turns an `asked` response into the kernel halt `question`.
- It resumes the invocation with the answer in `ModelRequest.answers`.

Halt is the single concept for this; there is no question field in role output.

### 16. Startup validation

`start()` fails on any of the following:

- duplicate descriptor names;
- a lane/flow mismatch;
- an unknown state;
- a terminal state without a verdict;
- `afterFailure` not among the kind's states;
- an unregistered lane named in a trigger or spawn;
- an agent no pool can serve;
- a command without argv or runner;
- a batch on a model without `submitBatch`;
- `onCrash('ask')` on a model without `recover`;
- the writer claim held by a live run.

Harnesses with no pools, agents or models are valid.

### 17. Commands and tags

**Command output.**
- A command without `.output(schema)` yields its stdout as a string.
- With `.output(schema)`, it yields stdout parsed as JSON and validated against the schema.
- A non-zero exit, or output that fails validation, is `ok: false`. The error is stderr (or the validation error).

**Tags.**
- `ctx.tag(...)` sets tags on the unit.
- Every entry the attempt records after that point carries those tags.
- This is how an owner-defined metric groups by a value the flow learned, for example the model that drafted or synthesized (`GroupBy { tag }`).

## What changed and why

**Rename (the operator):**
- The `H.schedule` supplier became **calendar** (`H.calendar`).
- `TimeSpec` became `Cadence`, and gained `monthly` for tenancy reviews.
- `H.on.clock` became `H.on.cadence`.
- `H.policy.schedule` became `H.policy.scheduler`, and its type became `SchedulerPolicy`.
- Why: one word had named three things, and a fourth sat beside it (principles 19 and 22).

**Principle 12 repair:**
- The seven-outcome map became state entities with four positions and terminal verdicts.
- `idle` became `waiting`.
- `ended` became `terminal` + `neutral`.
- `blocked` is now only an attempt status.
- Kinds declare `afterFailure`.
- `ctx.fail(reason)` makes failure honest, removing the parent's habit of returning a pending or terminal state to disguise a failure (adversary critique 1).
- Metrics filter by `position`, `verdict` and attempt `outcome`.

**Wake conditions:** any transition clears an armed wake (adversary: the tenancy race).

**Halts:** an agent's ask is the kernel halt `question`, so there is one concept for halting (adversary 3a).

**Quota:** quota moved off accounts into the ledger as `ledger.quota`. The ledger no longer extends `QuotaBook`, and accounts no longer take a `quota` option (adversary 3c).

**Scenario 9 surface:**
- the `crossing` source;
- the `pause` and `resume` effects, with the `lane` entry;
- `move` by lane and key;
- `create` with tags;
- `countBy` and `pausedMs`;
- `hours` windows;
- deadlines re-armed on data change.

**Scenario 10 surface:**
- `onCrash` on commands and agents, with `happened`;
- invocation phases and driver handles;
- `Model.recover`, `submitBatch` and `collectBatch`;
- definition fingerprints with the `definition-changed` halt;
- `claimWriter`;
- the ledger inbox with `harness.control()`.

**Removed:** `InferSchema`. No scenario used it.

**Battery pass (scenarios 1–5):**
- **`EntryFilter.phase`.** Scenario 3's owner-defined metric (citation-check pass rate per synthesizer model) and its daily-spend sum must count only invocations that ended. Without a phase filter, `started` entries entered every denominator.
- **Cost ceiling resets on re-open (rule 9).** A weekly recurring Topic would otherwise exhaust its $3 ceiling for its whole lifetime after a few weeks.
- **Stated, no type change:**
  - a cadence trigger fires per unit in its `whileIn` states;
  - a calendar tick sees terminal units;
  - what a command's output schema does, and how a command's failure is reported (rule 17);
  - tags carry onto later entries (rule 17).
- Each was implicit and each was load-bearing in a scenario.

## Principles broken

none

The parent's break of principle 12 is repaired as described above.
