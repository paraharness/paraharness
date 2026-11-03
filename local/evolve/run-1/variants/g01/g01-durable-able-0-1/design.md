# harness-dsl, durable lens, generation 1 (surface cut)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. This generation does two things:

- It cuts the parent's surface to what the battery calls.
- It repairs the lifecycle against the amended principle 12. The parent's sixth outcome `ended` is gone.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind. It has a stable id and a `key` (from `Kind.key`). The key is used for signal routing and for create-deduplication. A unit is at one **position**: pending, active, waiting or terminal.
- **Attempt**: one execution of a unit's flow, from a start step to an end.
  - **Open statuses:**
    - `running` holds capacity.
    - `blocked` is halted on a human decision. It holds nothing.
    - `parked` is in a `wait`, a `spawn`, a crash recovery or a ceiling stop. It holds nothing.
  - **Outcomes:** exactly `succeeded`, `failed` or `cancelled`.
    - An exit into a state whose verdict is `failure` ends the attempt `failed`.
    - Any other exit ends it `succeeded`.
    - A step failing after its retries ends it `failed`.
    - `H.cancel` and `restart` end it `cancelled`.
  - **Track record:** metrics on models, agents, runners and accounts are computed from these outcomes.
- **Step**: a named node of a flow: `step`, `halt`, `wait`, `spawn`, `loop` or `exit`.
  - Step outputs are recorded and form the replay state.
  - A command that exits non-zero fails its step. When a step needs a report rather than a failure, the command exits zero and declares an `output` schema.
- **Invocation**: one call of an executable inside a step. A retry is a new invocation. Cost, tokens, model, account and runner are recorded per invocation.

"Run" is not a word in this design.

## Entities

**Kinds** (vocabulary only):

- Work kind: `H.kind().attributes().states().key()`
- State: `H.state(name, position)`, or `H.state(name, 'terminal', verdict)`
- Signal: `H.signal().payload()`
- Role: `H.role().intents().instructions()`
- Memory kind: `H.memory(name, 'experience' | 'taste')`
- Command
- Flow
- Operation

**Instances** (each carries a backend, built in a subpath):

- Account
- Model
- Runner
- Workspace
- Supplier
- Store
- MemoryStore
- Ledger
- Client
- Observer

`H.clock` and `H.operator` are kernel suppliers.

**Pivots** (each names what it produces):

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow, plus the exit/during/failure/cancelled → state map | managed units |
| Agent | role × model or model policy | a model-call executable |
| Pool | accounts × shares × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples | a rate with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | lanes, pools, journals, triggers, metrics, scheduler, ledger, clients, observers | a running harness |

## Rules

### Lifecycle (principle 12)

1. **Positions and verdicts.** Every state declares its position. Every terminal state declares its verdict (`success`, `failure` or `neutral`), and there is no default.
   - The kind's first state is its initial state.
   - A unit whose initial state is `waiting` is not scheduled until a signal restarts it.
2. **Flows know no states.** A flow ends at named exits. The lane maps:
   - `exits` to any state. This map is total, so a missing exit is a compile error.
   - `during` (step names) to non-terminal states.
   - `failure`: where a failed attempt moves the unit. If omitted, the unit stays where it is, while the failed attempt is still recorded and counted.
   - `cancelled`: where `H.cancel` moves it.

   Startup checks positions against step type:
   - a `during` state on a running step must be `active`;
   - a `during` state on a `halt`, `wait` or `spawn` step must be `waiting`.
3. **Capacity follows attempt status, not names.** Only `running` attempts hold runner slots, lane WIP and account reservations.

### Signals, timers, triggers

4. **Signals.** A supplier route can `create` a unit, `signal` one by key or by typed predicate, or `skip`.
   - **Create-deduplication.** A `create` whose key matches a non-terminal unit of the lane is a recorded no-op (`unitDeduplicated`).
   - **Reactions** declared with `Lane.on(signal, …)`:
     - `update` merges the payload into the unit's attributes.
     - `restart` cancels the open attempt and starts a new one at a typed step name.
     - `enter` transitions the unit, possibly reopening it.

   `H.cancel` is the one built-in signal.
5. **Timers.** `H.when.timer(lane, { at, if })` arms one timer per unit as a ledger `timerSet`.
   - `at` is re-evaluated on every `attributesUpdated`. If the date changed, a new `timerSet` supersedes the old one, and a superseded timer never fires.
   - `if` is evaluated at fire time.
   - `wait({ ms })` parks the attempt.
6. **Trigger sources.** `transition`, `pattern` (N consecutive per group), `timer`, `step`, `invocation`, and `threshold`.
   - **`invocation`** takes one lane, which gives typed unit attributes, or several lanes, which gives a source over all of them.
   - **`step`** events carry:
     - the step's typed `output`;
     - `steps`, the typed outputs recorded so far in the attempt, keyed by the lane's step names;
     - `models`, the model used per step.
   - **`threshold(metric, { trip, reset, minSamples, window, edge })`** is evaluated per group after each ledger append that adds samples. Its state machine is armed → tripped → armed.
     - It emits `thresholdCrossed` once per edge, and only with at least `minSamples` samples.
     - `trip` and `reset` are separate bounds, which gives hysteresis.
     - Two sources over the same metric and bounds share one state machine. Filtering them by `edge` lets one trigger act on the trip and another on the reset.
7. **Trigger consequences.**
   - `create(lane, attrs)`
   - `signal(lane, signal, e => { key, payload })`
   - `record(journal, draft)`, as candidate or active
   - `pause(lane)` and `resume(lane)`

   Every firing is recorded as `triggerFired`. Pause and resume are additionally recorded as `lanePaused` and `laneResumed`, which reference the threshold event that carries the rate.

### Metrics (principle 18)

8. **Definitions.**
   - `outcomes({ of, model?, window })` counts units entering terminal states, by verdict:
     - `successRate = success / (success + failure)`;
     - `samples = success + failure`, always reported beside the rate;
     - `neutral` is reported separately;
     - `byState` is keyed by the lane's typed state names.
   - Owner metrics are `H.metric().from(source).samples(e => [{ group, hit }])`, read with `rate(metric, { group, window })` as `{ rate, hits, samples }`.
   - `meanCostUsd` is the mean cost of succeeded attempts.
   - `pausedMs` is the total paused time of a lane.
   - Windows are rolling and may be fractional. "This month" is `windowDays` equal to the days elapsed since the first of the month.
9. **Negative human verdicts count.** A state such as Rejected is the owner's call. Its verdict is mandatory.

### Cost and scheduling

10. **Cost.**
    - `Lane.ceiling({ maxUsd, onExceed })` checks projected cost before each invocation.
    - The scheduler's `admit` reads `spentUsd(lanes, since)` from the ledger.
    - Batch invocations are priced by the driver at the batch rate.
11. **Scheduler.**
    - `priority` orders lanes.
    - `wip` caps running attempts.
    - `boost` ages a starved lane.
    - `rank` orders units within a lane (lower first).
    - `admit` gates a start, using two counts:
      - `AdmitCtx.active(lane)` counts running attempts;
      - `AdmitCtx.open(lane)` counts non-terminal units, including those blocked at a halt.

    Preemption is priority plus admission. Running attempts are never interrupted.

### Accounts and memory

12. **Accounts.** Accounts and models carry no relationships.
    - Each model is served by the one harness pool that has an account accepting it.
    - Share caps live on the pool.
    - Quota state is a facet of the ledger. `sqlite.ledger({ path, quotaPath })` lets several harnesses share the quota tables.
13. **Memory.** An item's body is forward-phrased `text` inside the kernel envelope.
    - Recall is deterministic: filter by scope, rank by specificity or by the store's similarity score, break ties by track record.
    - Reads take the union of all journals visible to the role.
    - Writes come from three places, each naming one journal: agents whose role is in `writtenBy`, triggers, and the control API (`memoryWrite`, `memoryCurate`).

### Restart and durability (scenario 10)

14. **Recovery.** The author writes nothing except `onCrash` on effectful steps, and `.check` on a command whose completion can be observed.
    - **Single writer.** The ledger holds a writer claim. A second process refuses to start while the first is alive, and takes over from a dead one.
    - **Completed steps** are replayed from their recorded outputs.
    - **The step that was running** is handled by its `onCrash` setting:
      - `rerun`: run it again.
      - `park`: park the attempt with `unsafeRerun`. This is the default for commands.
      - `ask`: ask the executable whether it finished. This is the default for agents and batches.
    - **`ask` by executable type:**
      - **Agents:** the driver resumes the session. Driver states map as follows:
        - a completed session is `confirmedDone`;
        - a still-running session is awaited;
        - an unknown session is parked with `driverUnknown`.
      - **Batches:** the batch is collected (`collected`) and never resubmitted.
      - **Commands:** the `.check` executable is run.
        - `true` gives `confirmedDone`, and the flow continues.
        - `false`, or a failing check, parks the attempt with `unsafeRerun`.
        - A command with `ask` is therefore never rerun.
    - **Halts, children and decisions.** Halts resolved while down are found in the inbox. Children are units, so their outcomes are already in the ledger.
    - **Identity of the attempt.** A recovered attempt keeps its id. Interruption is never an outcome.
    - **Changed definitions.** A changed flow fingerprint parks the attempt with `definitionChanged`.

### Control API and startup

15. **Control API.**
    - **Grants.** Clients are granted operations (`H.ops.*` and `H.operation(name).run(exec)`).
    - **Transports.** The supervisor and plain HTTP are two backends of one `ControlApi`.
    - **Shared clients.** One client descriptor may be registered in several harnesses. `Client.serve` is then called once per harness's `ControlApi`, which is how one supervisor session reaches two harnesses.
16. **Startup validation.** `start()` fails on any of these:
    - duplicate descriptor names;
    - a flow that can fall off its end;
    - an unregistered lane, journal, metric or pool;
    - a `during` position mismatch;
    - a terminal state without a verdict;
    - `H.cancel` received by a lane with no `cancelled` mapping;
    - `onCrash: 'ask'` on a command without `.check`;
    - a batch on a driver without `submitBatch`;
    - a model served by zero pools or by two.

## What changed and why

Versus g00-durable-0:

- **Lifecycle repaired to amended principle 12.**
  - `ended` is removed.
  - States declare a position, and terminal states declare a verdict.
  - Attempts have three outcomes.
  - `waiting` is a real position.
  - `failure` is optional.
- **Typed step and state names everywhere.**
  - `StepEvent.models` is keyed by step names.
  - `UnitView.state` and `byState` are typed.
  - `PolicyCtx.lane` is available.
  - Lanes and metrics are branded.
- **Relationships off instances.**
  - Pools are declared on the harness.
  - Shared quota is a ledger backend option.
- **Scenario 9 coverage.**
  - Threshold with hysteresis.
  - Invocation source.
  - Pause and resume.
  - Signal by key.
  - Create-deduplication.
  - Timer re-arm.
  - `pausedMs`.
- **Scenario 10 coverage.**
  - `onCrash` and `Command.check`.
  - Writer claim, inbox, and fingerprint.
  - `attemptsRecover`.
- **Surface cuts.** Removed or tightened:
  - `Budget` and `H.budget`;
  - the `await` step and buffered signals;
  - `wait.until`;
  - `transition.from`;
  - `AdmitCtx.pending`;
  - `H.retry`;
  - `MemoryKind.body` and `.trust()`;
  - `recall.minScore`;
  - `meanCostUsd.outcome`;
  - `Operation.input`;
  - `supervisor.endpoint`;
  - `worktree.base`;
  - `writtenBy` now accepts agent roles only;
  - `loop.max` is now required;
  - adapter options that every caller passes are now required.

Scenario pass 01–05:

- **`StepEvent.steps`** carries the typed outputs recorded so far in the attempt.
  - Scenario 2's approval-rate metric groups by the classifier's category, which is a step output, not an attribute.
  - Scenario 3 records prior findings from the synthesis output when the citation check passes.
  - Without this, both had to smuggle step data into human decisions or attributes.
- **`AdmitCtx.open(lane)`** counts non-terminal units.
  - In scenario 4, "no new Backup while an Incident is active" must see Incidents that are blocked at an acknowledgement halt.
  - Those Incidents hold no capacity, so `active` (running attempts) reports zero for them.
- **`ZendeskEvent.status`.** The helpdesk adapter now reports the ticket status. Scenario 2 can then route "closed by customer" as a signal instead of guessing it from the event type.
- **Command failure is now stated.** A command exiting non-zero fails its step. Scenarios 3 and 4 rely on this; scenario 5's validation exits zero with a report so that it can halt instead of failing.

Scenario pass 06–10 (this revision):

- **`H.when.invocation(...lanes)`.** A second overload takes any number of lanes and yields untyped unit attributes.
  - **The problem.** Scenario 9 pauses `conversations` on the model error rate and resumes it when the rate recovers. If `conversations` is the only lane that produces invocation samples, pausing it stops the samples.
  - **Why the old form failed.** The reset edge needs `minSamples`, so it could never fire: a deadlock that the single-lane source could not avoid.
  - **The fix.** The harness-wide error metric now reads `conversations` plus a cheap canary lane that keeps running while `conversations` is paused.
  - The single-lane overload is unchanged.
- **`onCrash: 'ask'` on commands is now stated** (rule 14).
  - A check that answers no parks the attempt; it never reruns the command.
  - Scenario 10's `announce` relies on this: "never rerun, unless we can tell the post happened".
- **Shared client descriptors are now stated** (rule 15). Scenario 7 registers one supervisor descriptor in two harnesses: one session, two control endpoints.
- **Month-to-date windows are stated** (rule 8). A fractional rolling `windowDays` expresses them, so no new window type is needed. Scenario 9 uses this.
- **Threshold sources filtered by `edge` share one state machine** (rule 6). Scenario 9 uses this to split trip and reset into separate triggers.

## Principles broken

none

- 12 is repaired: there is no added outcome.
- 15 is satisfied: quota is ledger state, and sharing it is a ledger-backend option, not a second store.
