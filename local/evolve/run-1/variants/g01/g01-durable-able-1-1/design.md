# harness-dsl: durable, generation 1 (support-triage fix)

Lens: a unit of work is a durable execution. Its identity (kind + key) outlives processes. Attempts are continuations of it. The ledger is the event history. Timers, events and children are the normal case, not exceptions.

This child is aimed at scenario 2, the scenario the parent handled worst. It also repairs the parent's break of principle 12, whose amended text the parent predates.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, identified by `(kind, key)`.
  - It is durable and lives in the ledger. It may also have fields in a store.
  - It is always at one **position**: pending, active, waiting or terminal.
- **Attempt**: one pass of the lane's flow over a unit. It has exactly one of three outcomes:
  - **succeeded**: the flow reached an end label;
  - **failed**: a step failed after retries, or the budget failed it;
  - **cancelled**: a reaction, the operator or recovery ended it.
  - Statuses while open: running, blocked (on a human or on recovery), or waiting (on a timer, children, a batch or capacity).
  - Blocked and waiting do not create a new attempt.
  - `AttemptView.models` maps each step key that ran a model to the model's name.
- **Step**: one named node of a flow, at any depth, including inside a loop body. Its output is recorded. On resume, recorded outputs replay and are never re-executed.
- **Invocation**: one execution of an executable inside a step.
  - A retry is a new invocation of the same step.
  - A batch step makes one invocation per item, all sharing a `batchId`.
- **Event**: a typed fact addressed to an existing unit by key. A kind declares its events and timers, and a timer fires as an event of the same name.
  - Events are the one word for this. "Signal" is gone.
  - A **reaction** is what a lane does with an event. Reaction is the noun that replaces the parent's `H.move` verb.
- There is no "run".

## Entities

### Kinds (vocabulary, no backend)

- **States** are built per position: `H.state.pending(n)`, `H.state.active(n)`, `H.state.waiting(n)` and `H.state.terminal(n, verdict)`.
  - The verdict is `'success' | 'failure' | 'neutral'`. It is required, and there is no default.
  - States are shareable entities.
- `H.work(name)` declares a work kind with:
  - `.attributes()`: ledger-held scalars;
  - `.fields()`: store-held data;
  - `.states()`: the first state listed is initial;
  - `.events({...})`;
  - `.timers()`;
  - `.key()`.
- `H.role`, `H.resource`, `H.memory.experience|taste`, `H.command` and `H.flow` are unchanged from the parent.

### Instances (from adapter subpaths)

Account, model, runner, quota, ledger, store, memory store, supplier, client, projection and external executable. Each is the kernel interface implementation itself.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| **lane** | work kind × suppliers × store × flow × runner × reactions | the place a kind's units are produced, kept and handled |
| **reaction** | event × target state × from-states × update | the unit's response to an event |
| **agent** | role × model (or choice policy) × pool × journals | an executable that thinks |
| **pool** | accounts × shares × preference × fallback | the accounts an agent may draw on |
| **journal** | memory kind × memory store × recall policy | where items of a kind are written and recalled |
| **trigger** | source × consequences | a recorded firing |
| **access** | operations | what a client may do |
| **harness** | ledger × lanes × triggers × schedule × clients × projections | a running scheduler |

## Rules

### Skeleton (principle 12 as amended)

- **Positions.**
  - **Pending**: queued and schedulable.
  - **Active**: has an open attempt, or is about to.
  - **Waiting**: parked. It holds no capacity, is not schedulable and has no open attempt.
  - **Terminal.**
- **Queueing.** A unit enters the pending queue iff it moves to a pending state.
- **Attempt outcomes are the track record.** Metrics on models, agents, runners and accounts are computed from attempt outcomes and their invocations.
  - An `interrupted` invocation (crash) counts as nothing.
- **The kind's own rate.**
  - `success()` = success-verdict terminals / (success + failure terminals) in the window.
  - `n` is that denominator.
  - Neutral terminals are excluded from the rate and always reported by `outcomes()` with `byVerdict`, `byState` and `share(state)`.
- **Filtering by model or agent.** `success({ model })` counts units whose terminating attempt ran that model.
- **Moving the unit.** An attempt's failure moves the unit only where the lane maps the implicit `failed` label. Mapping `failed` to a waiting state is allowed.

### Flows emit labels, lanes map labels to states

- `.mark`, `.exit` and `.ends` emit labels.
- `.mark` may appear inside a loop body; it then fires on every round.
- The lane's `handler(flow, { states })` maps every label exhaustively.
- One flow serves Bug and Feature, with `params` carrying the round counts.
- **A flow's step map** (its `steps` type) contains every step at any depth.
  - A step inside a loop body is addressable by its own key.
  - Its last recorded output is what transition triggers see in `outputs`.
  - `H.metric(..).step` and `H.on.step` count and fire on every recording of that step, one per round.
  - Step keys are unique across the whole flow (startup validation).

### Events and reactions (the scenario-2 fix)

**Suppliers** emit `{ create }` or `{ key, event, payload }`.

**Creates and keys.**
- A create whose key names a non-terminal unit is a no-op, recorded as `unit.deduped`.
- A create whose key names only terminal units creates a new unit.
- Dedupe is therefore by the kind's key, and the key may be a group.

**Reactions** are declared as `lane.reacts({ name: r => r.to(State).from([...]).updates((payload, unit) => ({...})) })`.
- `r` is typed per event.
- `.updates` writes attributes to the ledger and fields to the store, in the same append as the move.
- A move to a different state cancels the open attempt, with outcome cancelled and cause `event`.
- A move to a pending state enqueues the unit.
- An event whose unit is not in a from-state is recorded and moves nothing.

**Ordering.**
- Triggers are evaluated after the append that records the event and its reaction.
- An `H.on.event` trigger sees `before` and `moved`.

**Timers.**
- An attribute timer re-arms whenever its attribute changes, including through the `updateWork` operation.
- The old deadline's queue entry is removed in the same append, so it never fires.
- A recurrence timer fires per unit and is delivered only to units in the reaction's from-states.

### Halts and gates

- `halt(key, { ask, decision, skip })` blocks the attempt on a human.
- When `skip.when` (a gate policy) returns true, the engine records the given decision with step status `skipped`.
- **Skipped steps never enter step metrics.**
  - Because inner steps are addressable, a gate reading the `approval` halt inside a rework loop counts only human decisions.
- **Bounded rework.** A rejection loops draft→approval with the reviewer's notes as carry, for a bounded number of rounds. When rounds run out, the flow exits with a label the lane maps to a failure state.

### Triggers

Sources:
- `transition`, filtered by `to`, `position` or `verdict`;
- `streak`;
- `step`;
- `event`, including timers;
- `crossing`, with hysteresis.

`crossing` details:
- The last crossing per (trigger, group) is read from the ledger.
- It therefore survives restart and fires once per crossing.

Consequences:
- `creates`, `delivers`, `records` and `invokes`;
- `pauses(lane)` and `resumes(lane)`.
  - These record `lane.paused` and `lane.resumed` with the firing's seq and reason.

Every firing is recorded as `trigger.fired` with its source seq.

### Steps and restart (scenario 10)

`StepOptions.onRestart` takes one of `rerun`, `park` or `reconcile`. **The default is `park`.**

`reconcile` asks the executable (driver or external) whether the open invocation finished:
- `finished`: its output is recorded and the flow continues.
- `notStarted`: the step runs.
- `unknown`, or no `reconcile` method on the executable: the attempt parks for the supervisor.

Restart mechanism (the author writes nothing):
- The ledger holds:
  - recorded step outputs;
  - open invocations;
  - batch handles;
  - halt resolutions;
  - children's transitions.
- On start, each open attempt replays from these. Each attempt stores `flowFingerprint`, and a mismatch parks it with the reason "flow changed".
- `H.ops.recoverAttempts` lets the supervisor restart a parked attempt from the top or abandon it.
- **Single writer.** `Ledger.claim(holder, ttl)` is a lease, and every `append` carries the holder.

### Other rules (unchanged from the parent unless noted)

- **Suspension.** A suspended attempt releases its slot and account and keeps lane WIP.
- **Budget.** `lane.budget({ maxUsdPerUnit, onExceed })`.
- **Memory.**
  - Reads union all named journals; writes go to exactly one.
  - A `.curated()` kind turns trigger-recorded items into candidates.
- **Quota.** By default, quota state is a partition of the ledger. An account may carry its own `Quota` backend, which two harnesses can share.
- **Scheduler.** The policy orders candidates and may preempt. Paused lanes are excluded before the policy runs.
- **Metrics.**
  - Rates are `{ rate, hits, n, window }`.
  - Owner metrics come from `step`, `transition` or `invocations`.
  - A `hit` test returns `true` (a hit), `false` (a sample, not a hit) or `null` (not a sample). Only non-null results enter `n`.
  - Counters: `created` and `pausedMs`.
- **Control API.** Operations as listed in `H.ops`.
- **Startup validation.** The parent's list applies, plus:
  - terminal-verdict recheck;
  - reaction targets and from-states inside the kind;
  - `.updates` keys declared on the kind;
  - a kind with fields but no store;
  - `crossing.per` is an attribute;
  - step keys unique across the flow, loop bodies included.

## What changed and why

**Versus the parent (g00-durable-1):**

1. **Principle 12 repaired.** Four positions and three verdicts replace the six-outcome skeleton.
2. **Signals → events and reactions.**
3. **The gate no longer feeds itself.** Skipped halts are excluded from step metrics.
4. **Rejection is bounded** by a rework loop that ends in escalation.
5. **Trigger ordering is defined.**
6. **Metric crossing source with hysteresis, lane pause/resume, key dedupe.**
7. **`onRestart` rules, flow fingerprints, ledger claim, reconcile.**
8. **Smaller changes:**
   - `MetricQuery.window: Duration`;
   - `Clock.startOfMonth`;
   - `cost` filters on attempt outcome;
   - `wordpress.poll` may emit events.
9. **Loop bodies and the step map (found writing scenarios 1–5).**
   - **Labels inside loops.** `FlowDraft.loop` now infers the body's labels (`L2`).
     - Before, a `.mark` inside a rework loop did not type-check.
     - Scenario 2 could not enter Drafting and AwaitingApproval on each round, which left AwaitingApproval a dead state and made the customer-reply reaction unable to catch an attempt waiting on approval.
   - **The step map.**
     - `FlowDraft` and `Flow` carry a seventh type, `steps`: every step at any depth.
     - `Lane`'s output type is now that map. As a result, `H.metric(..).step`, `H.on.step` and transition `outputs` can name a halt inside a loop.
     - Without this, scenario 2's approval-rate metric could only read the loop's summary. It could not tell a human approval from a gate-skipped one, so the gate would have fed its own metric (principles 4 and 18).
     - Step keys are now validated unique across the flow.
10. **Owner metrics choose their own denominator (found writing scenarios 6 and 9).**
    - **The change.** The `hit` tests of `H.metric(..).step|transition|invocations` now return `boolean | null`, where `null` means "this event is not a sample".
    - **Why scenario 6 needs it.** It scores each reviewer model by how often the editor acted on that model's critique.
      - The sample set is the editor decisions on drafts that model reviewed.
      - It is not every editor decision: after a model swap, the old denominator would count decisions a model never saw. The model-choice policy would read a dishonest `n` (principle 18).
    - **Why scenario 9 needs it.** Its model error rate counts model invocations only.
      - Commands and interrupted invocations are not samples. A deterministic step's failure is not a model error, and a crash is never a model failure.
    - **Also stated:**
      - `AttemptView.models` is keyed by step key.
      - `reconcile`'s fallback: unknown or unsupported parks, not-started runs. Scenario 10's `announce` depends on it.
      - Create-after-terminal makes a new unit. Scenario 6 re-reviews a returned draft as a new unit with the same key.
11. **Known friction, not fixed.**
    - **The problem.** A gate whose policy reads a metric defined over the same flow is circular in TypeScript's inference: the flow contains the gate, and the metric is built from the flow. The same holds for a model-choice policy read by agents in that flow.
    - **The workaround.** A function declaration with a declared return type, such as `function approvals(): Metric`, closes the loop. Scenarios 6 and 9 do this.
    - **Why it is left.** It is honest code, not an escape hatch, but a first-time reader may not predict why it is there. A later generation might name metrics before flows exist (a metric referring to a step by flow name and key).

## Principles broken

None.
