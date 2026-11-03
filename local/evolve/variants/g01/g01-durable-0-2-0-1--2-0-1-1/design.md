# harness-dsl, durable lens, generation 4 (scenario-fix: 7, plus the three named defects)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child of `g00-durable-0-2-0-1` repairs **scenario 7** (shared subscriptions), which the critique ranked worst. It also repairs the critique's three sharpest points:
1. strings standing in for entities;
2. the kind declaring failure;
3. the unresolved halt and seat vocabulary.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a key.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: succeeded, failed or cancelled.
  - While open it is *running* (holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what blocks it: `decision`, `timer`, `children`, `batch`, `job` or `recovery`.
- **Step**: a named node of a flow, and the attempt's address within that flow.
  - Running steps (`step`) hold capacity.
  - Blocking steps (`halt`, `wait`, `spawn`, `job`) do not.
  - `loop` and `exit` are structure, not steps.
- **Invocation**: one call of an executable within a step. A step retry and a job poll are new invocations.

"Run" is not used. "Agent" is not a noun of the surface (see Seats).

## Lifecycle (principle 12, as now ruled)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- **Kinds** declare only:
  - `attributes`;
  - `states`;
  - `key`;
  - `initial`.

  A kind declares nothing about failure or cancellation.
- **Lanes** carry the moves.
  - **Exits.** `handler(flow, { exits, during, cancelled?, params? })` maps flow exits to states. The map is total and compile-checked. In `during`:
    - a running step accepts only `active` states;
    - a blocking step accepts only `waiting` states.
  - **Cancellation.** `cancelled` names the terminal state a cancellation leaves the unit in.
  - **Retry.** `retry({ maxAttempts, backoff?, initialDelayMs?, exhausted })` is required on every lane.
    - A failed attempt leaves the unit at pending under this policy.
    - After `maxAttempts` failed attempts the unit moves to `exhausted`.
    - "Fail at once" is `maxAttempts: 1`.
  - **Failure bound.** A lane without `retry` is a startup error.
- **Scheduler and board.** Only `pending` units are schedulable. `waiting` units and blocked attempts hold no capacity.

## Entities

**Kinds** (vocabulary, no backend):
- work kind;
- state;
- signal;
- role;
- memory kind;
- halt (`H.halt`);
- resource (`H.resource`);
- facet (`H.facet`);
- command;
- flow;
- operation.

**Instances** (carry a backend, built in subpaths):
- account;
- model;
- embedder;
- runner;
- workspace;
- supplier;
- store;
- memory store;
- ledger;
- quota partition;
- transport;
- observer.

`H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow (exits, cancelled, params) × retry × lease × order | managed units |
| Seat | role × model or model policy × pool × workspace × guard | a model-call executable whose series survives a model swap |
| Pool | accounts × per-harness share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Client | transport × granted operations | a scoped control surface |
| Trigger | source → consequences | recorded firings |
| Metric | source × facets → samples or amounts | a figure per series, with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Scenario 7: who owns which state

- **Accounts name their quota partition.**
  - The account declares it: `claudeCode.subscription(name, { token, quota })`, where `quota = sqlite.quota(name, { path })`.
  - The ledger carries no quota option.
  - `QuotaPartition` is append-only: it has `append` and `read` and no writer lock. Each harness appends its own events and folds the window at read time.
  - An account without `quota` keeps its quota events as a private partition of its harness's ledger.
- **Harness identity.**
  - Every `QuotaEvent` carries `harness` and `ledgerId`.
  - At `start()` the harness appends `joined` for each pooled account.
  - A duplicate harness name from a different ledger is a startup error.
  - A conflicting credential reference for one account name is a startup error.
- **Share caps are per harness.** `pool.share(account, 0.6)` caps this harness's consumption only.
- **Ledgers.** Each harness has its own ledger. The only shared kernel state is the quota partition.
- **Shared taste.** One `Journal` is defined in a shared module and registered in both harnesses.
- **One supervisor, two endpoints.** `H.client(name, { transport, grants })` per harness; `claudeCode.session(name, { clients })` points one session at both.
- **What is limited honestly.** Two harnesses giving one account different partitions cannot be detected, because each sees only its own. The defence is defining the account once in a shared module.

## Seats

- **One noun.** `H.seat(name)` is the single pivot: a role, a fixed model or a model policy, a pool, an optional workspace and guard.
- **Agent.** An "agent" is a seat with one model; it is not a second builder.
- **Metrics.**
  - Invocations, step events and decision events record `SeatChoice { seat, model }`.
  - Metrics key on seat and model as typed columns.

## Entities, not strings

- **Memory scope.**
  - `Scope.resources: Resource[]`.
  - `Scope.facets: FacetValue[]`.
  - Skills remain strings.
- **Recall.** Recall matches items scoped to:
  - leased resources;
  - the resources and facet values the task names.
- **Facets.**
  - `H.facet(name)` is a kind.
  - A metric declares facets with `.facets(...)`. Samples then carry typed facet values, and queries take `MetricQuery<F>`.
  - A facet named after a column is a startup error.
- **Step addresses.**
  - Step names are compile-checked addresses within one flow, not shared identities.
  - Step-dependent reactions live on the lane: `on(signal, { update, restart: { to, at } })`.
  - Step-dependent timers live on the trigger source: `H.when.timer(lane, { at, onlyAt })`.

## Halts and grants

- **One halt form.** Every halt is `flow.halt(address, H.halt(name).decision(schema), options)`.
- **Resolvers** (`decisionRecorded.resolvedBy`):
  - `human`: a client granted `H.ops.resolve(halt)`;
  - `policy`: `skip: H.policy.halt(...)`, with its reads recorded;
  - `timeout`: `timeout: { afterMinutes, decide }`, after which the same attempt continues.
- **Halt scope.**
  - `scope: ctx => FacetValue[]` declares the facet values the question is asked in, for example the classified category.
  - The scope is recorded on `attemptBlocked` and `decisionRecorded`.
  - The skip policy receives it as `HaltPolicyCtx.scope`.
  - Decision metrics read it as `DecisionEvent.scope`.
  - A deterministic policy can therefore depend on a flow-produced value without an inline predicate.
- **Conditional asking.** `askWhen` makes the halt conditional; its step output becomes `D | undefined`, and an unasked halt is recorded as `haltSkipped`.
- **Grants.** `H.ops.resolve(...halts)` names every halt a client may resolve.
- **Clocks.** Clocks run from the recorded `attemptBlocked`.
- **Ceiling halts.** A unit-cost ceiling with `onExceed: 'halt'` blocks the attempt as `recovery`. A client granted `attemptsRecover` resolves it with `continue` or `abandon`.

## Rules

1. **Flows.**
   - Flows know no states. One flow serves several lanes with different params, retries, cancellation states and maps.
   - `exit(name, when)` is positional: the flow ends at that point when `when` holds, and otherwise continues to the next node.
2. **Attempt outcome.**
   - An attempt fails when either:
     - a step fails after its step retries;
     - a job reports failed;
     - its exit maps to a failure terminal.
   - It is cancelled by `H.cancel`, by a `restart` reaction, or by an `enter` into a terminal state.
   - It succeeds otherwise.
   - A crash is never an outcome.
3. **Signals.**
   - A signal to a key with no open unit is recorded as `signalSkipped`.
   - A conditional restart outside its `at` steps applies its update and records `restartDeferred`.
   - An `enter` into a non-terminal state depends on whether an attempt is open:
     - with no open attempt, it moves the unit at once;
     - with an open attempt, it is held. When that attempt ends, the held state replaces the exit map's state, and the last held `enter` wins.
     - Either way, the delivered signal is the recorded fact; no extra event is needed.
4. Creation deduplicates by key (`createSkipped`).
5. Timers re-arm after every `attributesUpdated`.
6. **Triggers.**
   - Sources: transition, pattern, timer, step, invocation, decision, crossing.
   - Consequences: create, signal, record, pause, resume.
   - A lambda returning `undefined` skips that firing.
7. Step retry makes invocations. Lane retry makes attempts.
8. Policy decisions, exit predicates and loop bounds are recorded once and read back on replay, with their metric reads and sample counts.
9. Only running attempts hold slots, WIP, leases and account reservations.
10. `Lane.ceiling` checks projected unit cost before each invocation.
11. **Restart.**
    - There is one writer claim with a TTL.
    - Completed steps replay at zero cost.
    - The running step follows its `afterCrash`.
    - Batches and jobs are collected by id.
    - Children are read from the ledger.
    - A flow version mismatch parks the attempt.
    - `attemptInterrupted` is excluded from every rate.
12. **Startup validation.** `start()` fails on any of:
    - duplicate names;
    - a lane without retry;
    - a state outside the lane's kind;
    - `H.cancel` to a lane without `cancelled`;
    - a signal without a reaction;
    - a flow path without an exit;
    - an unregistered reference;
    - a seat without a pool;
    - an unserved model;
    - a batch on a driver without `submitBatch`;
    - `askDriver` without sessions;
    - an unenforceable guard;
    - a quota identity conflict;
    - a facet named after a column;
    - a crossing over a total;
    - a grant for an unasked halt;
    - a halt policy over a foreign halt or kind;
    - a timeout not later than its escalation;
    - a halt `scope` value whose facet no metric over that halt declares.

## What changed and why

**Previous revision (versus the parent):**
- **Scenario 7.**
  - `QuotaPartition` was added, and the account names its partition.
  - The ledger lost its quota methods.
  - Harness identity was added: `ledgerId` and the `joined` event.
  - `Transport` and `H.client` were added, along with `claudeCode.session`.
- **Strings for entities.**
  - Resources, facets and `MetricQuery<F>` were added.
  - The free `group` strings were removed.
  - Step-dependent reactions moved to the lane.
- **Kind declares failure.**
  - `Kind.onAttemptFailed` and `Kind.onCancelled` were deleted.
  - `HandlerMap.cancelled` was added, and lane retry became mandatory.
- **Halt and seat vocabulary.**
  - The inline halt form and `blockersResolve` were deleted.
  - `askWhen` was added.
  - `H.agent` was replaced by `H.seat`.

**Scenarios 1 to 6 written against the surface:**
- **`HaltOptions.scope` and `HaltPolicyCtx.scope` added. The kernel's `attemptBlocked` and `decisionRecorded` gained `scope`.**
  - Scenario 2's safe category is the classifier's output, not a unit attribute.
  - The registered skip policy (principle 17) had nothing deterministic to read it from, so the only expression left was an inline predicate, which the principle forbids.
  - The scope is recorded, so replay and metrics read the same value the policy read.
- **`DecisionEvent.seats` and `DecisionEvent.scope` added.**
  - `seats` is folded from the attempt's invocations, so no new ledger event is needed.
  - Scenario 2 needs approval rate by category and by model, counting human decisions only. Policy-resolved approvals must not feed the safe-category rule that produces them.
  - Scenario 6 needs the editor's acted-on rate per seat and per model.
  - Before this change, both needed a step source on the lane. That counted policy resolutions, and it made a policy → metric → lane → flow → seat → policy definition cycle.
- **Ceiling halts clarified** as a `recovery` block resolved through `attemptsRecover`. There is no type change.
- **Known ergonomic cost.** A policy that reads a metric over the lane whose flow uses that policy's seat still forms a definition cycle. Scenario 3 breaks it with a `MetricRef<'rate', never>` annotation, and scenario 6 adds a `Seat<…>` annotation. These are annotations, not escape hatches, but the reader must know to write them.

**This revision (scenarios 7 to 12 written against the surface; no type change):**
- **Rule 3 now states what `enter` into a non-terminal state does while an attempt is open.**
  - Scenario 8's Tenancy and Negotiation receive outside signals during an open attempt: suspend, reinstate, a vendor reply. These signals name the unit's next resting state.
  - The surface accepted such reactions but left the semantics open. An immediate move would be overwritten by `during` at the next step boundary, so the board would lie.
  - Holding the state until the attempt ends keeps the attempt's track record intact, and it puts the unit where the outside world said.
- **Rule 1 now states that exits are positional.**
  - Scenarios 10 and 11 end the flow before a wrong-to-repeat step when a halt decides against it: `exit('signoffRejected', ...)` comes before `execute`.
  - The types always allowed an exit mid-chain; the rule now says what that means.
- **Bounded re-entry without arithmetic (scenario 11) needed no new pivot.**
  - Counsel returns are a declared `loop` bound (`max: 2`, `until` not returned), followed by a positional exit.
  - The bound is recorded once (rule 8). The flow counts nothing and reads nothing from the ledger.
- **Scenario 7 is one file.**
  - The battery's scenario files may import only `harness-dsl` and `zod`, so the shared module is the top section of the file: accounts, quota partition, taste journal and roles.
  - Both harnesses then consume that section, exactly as two files would import it.
  - Harness A is a compact form of scenario 1 (bugs and features).

**Still open:**
- batch versus job;
- resource-to-adapter mapping coverage;
- the lane carrying many concerns;
- automatic memory capture.

## Principles broken

None knowingly.

- Principle 8 names "agent" as a pivot. This design keeps it as "a seat with one model", as principle 8 defines it, without a second builder.
