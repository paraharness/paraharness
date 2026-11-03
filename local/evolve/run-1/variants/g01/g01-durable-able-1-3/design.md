# harness-dsl: durable, without moves (g01, child of g00-durable-1)

Operator: **delete**. The deleted entity is **Move**: `H.move(state).from([...])` and the lane's `.signals({...})` reaction table that consumed it. Every unit state change from outside a flow is now a trigger consequence (`trigger.moves(lane, {...})`). The child also repairs the parent's break of principle 12, which has been amended: the skeleton is now three attempt outcomes, four unit positions, and a verdict on each terminal state.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, identified by `(kind, key)`. It is durable and lives in the ledger. It may also have fields in a store.
- **Attempt**: one pass of the lane's flow over a unit.
  - Statuses: `running`, `blocked` (on a human decision), `suspended` (on a timer, children, capacity or preemption), `ended`.
  - An ended attempt has one outcome: `succeeded`, `failed` or `cancelled`.
  - Suspension, blocking and process restarts never create a new attempt. A resumed attempt keeps its id.
- **Step**: one named node of a flow. Its output is recorded once, with its index and a digest of the flow prefix up to it.
- **Invocation**: one execution of an executable inside a step.
  - Retries are new invocations.
  - A batch step has one invocation per item, sharing a `batchId`.
- There is no "run".

## Entities

### Kinds (vocabulary, no backend)

- `H.state(name, position)` for `pending`, `active` or `waiting`; `H.state(name, 'terminal', verdict)` with verdict `success`, `failure` or `neutral`. There is no default verdict.
- `H.work(name)`: `.attributes`, `.fields`, `.states`, `.signals` (typed events addressed to a unit by key), `.timers` (each timer fires as a signal), `.key`.
- `H.role(name)` with intents; `H.resource`; `H.memory.experience` / `H.memory.taste` (`.curated()`); `H.command`; `H.flow` (blind to kinds and states).

### Instances (carry a backend, from subpaths)

Account, model, runner, ledger (which owns quota), store, memory store, supplier, client, projection, external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| **lane** | work kind × suppliers × store × flow × runner | the place a kind's units are produced, kept and handled |
| **agent** | role × model or choice policy × pool × journals | an executable that thinks |
| **pool** | accounts × shares × preference × fallback | the accounts an agent may draw on |
| **journal** | memory kind × memory store × recall policy | where items are written and how they are recalled |
| **trigger** | source × consequences | a recorded firing |
| **access** | operations | what a client may do |
| **harness** | ledger × lanes × triggers × schedule × clients × projections | a running scheduler |

## Rules

### Skeleton (principle 12, as amended)

- A unit's position is that of its state.
  - **pending**: in the queue.
  - **active**: an attempt is open.
  - **waiting**: parked. It holds no capacity and is not schedulable. Examples: a tenancy between reviews, a negotiation awaiting the vendor.
  - **terminal**: done, with a verdict.
- The lane typechecks the flow's labels against positions.
  - `mark` labels must map to **active** states.
  - `exit`, `ends` and the implicit `failed` label must map to **non-active** states.
  - So a unit can never sit "active" with no attempt.
- **Kind outcome rate** = success / (success + failure), with `n` beside it. Neutral terminals (parked, inconclusive, churned, walked away) are excluded from the rate. `outcomes()` reports them with `byVerdict`, `byState` and `share(state)`.
  - "Loaded with warnings" is a second success state: success to the scheduler, distinct in `byState`.
- **Attempt outcome**:
  - `failed` if the attempt ended through the `failed` label, or at a terminal state whose verdict is failure.
  - `cancelled` if a trigger move or an operator cancelled it.
  - `succeeded` otherwise.
  - Agent, model, runner and account metrics (`metrics.attempts`) are computed from this.
  - A crash is never an outcome. The attempt resumes and only its `interruptions` count rises.

### Signals and triggers (replaces Move)

- Suppliers emit `{ create }` or `{ key, signal, payload }`.
  - A create whose key matches a non-terminal unit is recorded as `unit.deduplicated`; no unit is created.
  - A signal is recorded as `signal.received`, and nothing else happens until a trigger reacts.
- `trigger.moves(lane, { key, to, from?, update? })`:
  - cancels the unit's open attempt (outcome `cancelled`);
  - applies `update` (typed against the kind's attributes and fields), so the redraft sees the customer's new message;
  - moves the unit to `to`, queueing it if `to` is pending.
  - `from` restricts the move to the listed states. When omitted, the move applies to every non-terminal state. A move to or from a state outside the kind fails at `start()`.
- Ordering is defined:
  - every trigger on one source event evaluates `where` against the unit as it was at that event;
  - consequences run in declaration order, trigger by trigger, in harness registration order.
  - So an SLA trigger can `.creates(escalations)` and `.moves(conversations, Escalated)` in one firing with no race.
- Sources:
  - `transition`, filtered by `to` or `verdict`;
  - `streak`;
  - `step`;
  - `signal`, which includes timers;
  - `threshold`.
- Other consequences: `creates`, `records`, `invokes`, `pauses(lane)`, `resumes(lane)`.
- Every firing is recorded with its source sequence number.

### Threshold sources (metric triggers)

- `H.on.threshold({ groups?, read, enters, leaves })` is re-evaluated after committed ledger appends, reading metrics only.
- Per (trigger, group), the kernel keeps the last crossing as a `threshold.crossed` ledger event. It fires `entered` once when `enters` holds while outside, and `left` once when `leaves` holds while inside. That is hysteresis.
- The firing is the recorded crossing, which carries its reading.
- Group deduplication comes from hysteresis plus key dedupe: an Audit keyed by category is not created twice while one is open.
- `lane.paused` / `lane.resumed` carry their cause, and the cause points to the crossing that holds the rate.
  - The board shows them.
  - `metrics.pausedMs` answers "how long paused".
  - `metrics.created(query, 'category')` answers "audits per category".
- A paused lane starts nothing new. Its running attempts finish.

### Timers

- An attribute timer re-arms whenever the attribute changes, through `updateWork` or `moves.update`.
- The superseded deadline is removed from the queue in the same append, so it never fires.

### Steps

- A step takes an executable plus the options `retry`, `timeoutMs`, `onFailure`, `runner`, `onRestart` and `confirm`.
- `halt(..., { skip })`:
  - records the skipped decision with status `skipped`;
  - owner step metrics (`H.metric(...).step`) ignore skipped and confirmed records.
  - So a gate can never feed on its own decisions.
- `spawn` suspends until the children are terminal. While suspended, the attempt holds WIP but no slot or account.
- `batch` submits one cloud batch, priced at the batch rate.

### Restart (scenario 10)

The mechanism is a write-ahead invocation record.
- Before an effect, the engine appends `invocation.started`, which carries the step's restart rule.
- After the effect, it appends `step.recorded` / `invocation.recorded`.

On start, for every attempt that is not ended:
1. **Writer check.** `claimWriter` takes the ledger's single-writer lease, using TTL and a fence.
   - A live holder means the second process refuses to start.
   - An expired holder is taken over, recorded as `writer.claimed`.
   - Every `append` carries the fence, so a stale writer's appends are rejected. Two writers can never both run.
2. **Inbox.** Halt resolutions, signals and creates posted while no writer ran are drained from the ledger inbox.
   - `harness.control()` serves the control API without the writer lease and writes to the inbox. The supervisor can resolve an approval while the harness is down.
3. **Definition check.** The current flow digest is compared with the recorded step digests.
   - On a mismatch (a step was renamed or inserted before the one in progress), the attempt is blocked with `hold.on: 'definition'`.
   - The supervisor resolves it through `resolveBlocks`, choosing `restart` (from the top, same attempt id) or `abandon` (cancelled).
4. **Replay.** Recorded steps replay their outputs and cost nothing.
5. **Interrupted step**, by `onRestart`:
   - `rerun`: run the step again. This is the default for nothing; the author declares it (as for `build`).
   - `park`: the default for commands and externals.
     - If `confirm` is given, it is run first. A zero exit, or a returned output, records the step as `confirmed` with that output.
     - Otherwise the attempt blocks with `hold.on: 'restart'`. The supervisor chooses continue, rerun or abandon.
   - `ask`: the default for agents. `Driver.status(invocationId)` returns one of:
     - finished: the result is recorded;
     - running: the engine re-attaches;
     - unknown: the attempt parks.
   - A batch with a `batch.submitted` record is collected, never resubmitted.
   - Timers and children are re-derived from queue entries and child transitions in the ledger.
6. **Counting.** An interrupted invocation is recorded as `interrupted`. That status is excluded from `invocationFailures` and from attempt outcomes.

The author writes only `onRestart` / `confirm` on the steps that differ from the defaults. There are no checkpoints and no ledger reads in a flow.

### Accounts and quota (one owner)

- Quota is a partition of the **ledger** (`Ledger.quota`, principle 15). Accounts carry no state.
- Two harnesses share account state by giving their ledgers the same quota location: `sqlite.ledger(path, { quotaPath })`. Runs stay private and the window and cooldown state is shared.
- Share caps are per pool, checked with `harnessUtilization`, and read fresh at every decision.

### Everything else (unchanged from parent)

- Labels are mapped to states by the lane; `params` serve Bug and Feature from one flow.
- `.sets` writes attributes, typechecked at the lane.
- Lane budget is a cumulative per-unit cap on cost.
- Memory envelope, recall candidates (specificity, track record, similarity), curated kinds.
- Scheduler: the policy orders candidates and may preempt; the kernel admits within WIP, slots, preflight, eligibility and pauses.
- Control API of operations; transport in client adapters.
- Startup validation, extended with:
  - a move target or `from` outside the kind;
  - `onRestart: 'ask'` on a non-agent step;
  - a `confirm` on a step whose rule is not `park`;
  - a mark label mapped to a non-active state (also a type error).

## What changed and why

- **Deleted Move** (`H.move`, `Lane.signals`). It was a verb-named pivot (principle 9) and one of four meanings of "signals".
  - **Repair:** signals are now only declared events (on the kind) and a trigger source. Reactions are `trigger.moves`.
  - **What the repair fixes:**
    - The new customer message reaches the redraft through `update`. The parent depended on store reload.
    - The SLA escalation race is gone, because triggers have a defined snapshot and order.
    - The untyped `c.signals` / `safeParse` path is gone. `FlowContext.signals` is removed, and a negotiation stores the vendor's offer as a field through `update`.
- **Principle 12 repaired.**
  - `concluded` and the six outcomes are gone. States declare a position, and terminals declare a verdict.
  - `waiting` replaces "idle active".
  - Attempt statuses no longer reuse "waiting"; they use `blocked` and `suspended`.
  - The critique's "junk drawer" is resolved by explicit verdicts. An escalation can be a failure, a parked topic neutral, a returned draft a failure.
- **Self-feeding gate fixed.** Skipped decisions are recorded as `skipped` and excluded from owner step metrics.
- **Metric threshold source, lane pause/resume, `created`/`pausedMs`/`values`/`invocationFailures`/`attempts` metrics, `Duration` windows and `sinceMs`.** These serve scenario 9, which the parent left unwritten.
- **Restart machinery** serves scenario 10:
  - `onRestart` and `confirm` on steps;
  - `Driver.status`;
  - the writer lease with fencing;
  - the ledger inbox and `harness.control()`;
  - flow digests;
  - `interrupted` invocations.
- **Quota ownership.** `Account.quota` and `sqlite.quota` are removed. The ledger alone owns quota and may place it in a shared file. This answers the critique that ownership "depended on which object you read".
- **Removed:** `Outcome`/`Terminal` types, `TimerPayload`-as-reaction, the `WaitView` name, and `Quota` as a `Named` instance.

## Principles broken

none

The parent's break of 12 is repaired against the amended text: three attempt outcomes, four positions, terminal verdicts with no default, and blocked as an attempt status.
