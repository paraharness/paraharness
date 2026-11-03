# harness-dsl: minimal, one entity deleted (child of g02-minimal-0-2-2--2-2-1-2)

The operator is **delete**. This child removes one entity, the **job**, and repairs the battery without it. A long external effect is now a setting on a command: `command.collect(poll, every)`. The child also answers the adversary's three sharpest critiques of the parent, and the scenario 9 defects it named.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, 'pending' \| 'waiting')`, `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. Its position is part of its type. There is no `active` state: active is derived from the attempt (principle 12). |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and its states. The type records which states are terminal. It declares nothing about failure. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about(z).timeout(after, resolve).policy(rule)` | A named outside decision. |
| Kind | **resource** | `H.resource(n)` | A named shared thing. |
| Kind | **facet** | `H.facet(n, valuesSchema)` | A declared metric dimension and memory-scope axis. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | A specific thing with its backend. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy)` | Role × model chosen at attempt time. An agent is a seat with one model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, { retries?, backoff?, exhausted, params? })` | Kind × suppliers × store × handler. Optional settings: `.suppliers() .store() .wip() .maxUsdPerUnit() .locks(f) .sequence(f, parked) .facet(facet, read)`. |
| Pivot | **journal** | `H.journal(n, memory, store).recall(policy?)` | Memory kind × store × recall, as principle 8 names it. Renamed from `library`, and recall is now a slot on it. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | Accounts × policy: the account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | flow, command, policy, operation, harness | | |

The kernel halts are `H.halts.interrupted`, `definitionChanged`, `costCeiling` and **`exhausted`** (new). Their decision is `{ action: 'restart' | 'continue' | 'abandon', to?, note? }`.

## Execution vocabulary (principle 22)

| Word | One meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. Its status is `running`, `blocked` (on a halt), `suspended` (on a timer, children, an external effect, a batch or a lease) or `ended`. An ended attempt has the outcome `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable. Its mode is `model`, `batch`, `command` or `external`. An external invocation is one row covering submit, polls and collect. |
| **Position** | `pending`, `active`, `waiting` or `terminal`. |
| **Retry** | A lane retries attempts (`retries`). A command retries invocations (`command.retries`). |

## Rules

### 1. Skeleton, retry, exhaustion (principle 12)

**Position.** A running attempt makes the unit `active`. A blocked or suspended attempt makes it `waiting`. With no live attempt, the unit is at the position its state declares.

**Outcomes.**

- `succeeded`: the flow returns a state.
- `failed`: the flow returns `ctx.fail` or throws.
- `cancelled`: an outside move, a supply re-entry, a preemption, or an `abandon` decision.

**The lane names the end, and the type forbids dead ends.** In `handler(flow, { retries?, backoff?, exhausted })`:

- `retries` defaults to 0, so a lane where retry is meaningless writes none.
- `exhausted` is required. Its type is either a **terminal state of the kind** (the `TerminalName` of the kind's states) or `H.halts.exhausted`.
- No other state can be written there.

`H.halts.exhausted` parks the last failed attempt as blocked. The unit is at `waiting` and holds no WIP or slot. A client granted `resolve(H.halts.exhausted)` then decides:

- **`restart`** runs the flow from the top with a fresh retry budget.
- **`abandon`** ends the attempt `cancelled` and moves the unit to `to`, which must be a state of the kind. Without `to`, the unit returns to the state it held when the attempt began.
- **`continue`** is rejected.

Startup fails if no client can resolve `exhausted` for a lane that uses it.

Scenario 8 is the case this serves. A tenancy whose review keeps failing parks for the supervisor. Before, it moved into an invented `review-stalled` state that nothing leaves. It is not ended as churn, which would be a lie.

**Human verdicts are states, never failures.** `ctx.fail` means an executable or the flow failed. A human "no" is a state the flow returns, and the attempt therefore succeeds:

- A rejected reply returns the conversation to its drafting state.
- A refused upsell returns the tenancy to `current`.

An unresolved incident stays inside one attempt: the flow reruns the runbook and asks again. The model and seat track record counts only executable failures (principle 12). The battery is rewritten to this rule, and the design calls out the parent's `ctx.fail('reply rejected by reviewer')` as a defect.

**Command retries.** `command.retries(n, backoff?)` retries the invocation in place. Exhaustion returns `{ ok: false }` to the flow.

**Return bounds.** `H.on.enters(kind, state, { times: n })` is evaluated in the transaction that records the transition. The unit becomes schedulable only after that commits.

### 2. Supply and outside moves

A `create` whose key belongs to a unit that is not terminal records the firing effect with `applied: false, reason: 'duplicate key'`, or does nothing when it comes from a supplier. A key whose unit is terminal creates a new unit under the same key.

An `update` is split into two parts, and the parent's deferral of data is removed:

- **The patch applies immediately**, in every position.
  - A running flow keeps the snapshot of `ctx.unit.data` it started with. It sees the new data on its next attempt.
  - Deadline sources re-read the patched data at once (see the deadlines rule below).
- **A `state` waits for the attempt to leave `active`**, and lands then:
  - Arriving with a live attempt at `active`: it is recorded on the unit as `deferredState`. When the attempt blocks, suspends or ends, it applies.
  - Arriving at `waiting`, or once a deferred state lands at `waiting`: it cancels the attempt (cause `supply`) and moves the unit.
  - Arriving with no live attempt: it moves the unit.

Applied to the battery:

- **Scenario 11, redline during `draft`.** The text is patched now. The `redlined` move lands when the attempt blocks on `counsel`, which cancels it, and the unit re-enters at `draft` with the redline. Nothing is lost and nothing is fatal.
- **Scenario 11, redline during `counsel`.** It re-enters at once.
- **Scenario 2, customer reply while the draft awaits approval.** It cancels the attempt and returns the unit to classifying.

**Deadlines move (scenario 9).** `H.on.deadline(kind, due, whileIn)` arms a timer and records an `armed` timer entry with its due time.

- Any data change re-evaluates `due`.
- A changed due time records `disarmed` for the old timer and `armed` for the new one, in the same transaction as the patch.
- Only armed timers fire.

An SLA extended through `writeWork` therefore never fires its old deadline, even while the conversation is drafting. Halt timeouts use the same timer entries, measured from the recorded raise.

### 3. External effects without a job entity (principle 3)

`command.collect(poll, every)` turns a command whose output is a handle into one submit-and-collect invocation of mode `external`. It works as follows:

1. **Submit.** The command runs and its output is recorded as the handle.
2. **Suspend.** The attempt suspends: no WIP and no runner slot are held.
3. **Poll.** `poll` runs every `every`, on whatever runner it declares, and each poll is recorded.
4. **Collect.** `done` resumes the flow with the result. `failed` is an invocation failure, so the flow sees `{ ok: false }`.

On restart:

- A recorded handle is polled, never resubmitted.
- A crash before the handle is recorded follows the submit command's `.recovery`.
- Harness downtime is never counted as a failure.

A model batch (`ctx.batch`) is the same mechanism with the model driver's `submit` and `collect`, priced at the batch discount in telemetry. It stays a context method because its items are model calls with per-item results. The kernel's implementation interface is one: `Executable.external`.

### 4. Recall is a policy on the journal (principles 4, 8, 14)

`H.journal(n, memory, store)` recalls through a kernel default policy. That default is deterministic and lives in the kernel, not in a backend. It ranks by:

1. specificity of `when` against the call's scope;
2. then track record, meaning the share of succeeded attempts among those whose invocations carried the item;
3. then recency.

`.recall(H.policy.recall(name, choice => items))` replaces the default. The store only supplies candidates:

- `MemoryStore.search` returns scope-matching items, with `similarity` when the backend computes one.
- The policy receives `RecallCandidate`s, each carrying `similarity`, `specificity` and `record` (a `Rate` with samples).
- The policy returns the items to feed.

A vector store can therefore inform recall by similarity, but it never decides it. Each recall is recorded as a `decision` entry, and the invocation records `memoryIds`.

Candidates are not recalled until they are accepted.

### 5. Facets, metrics, quota, locks, ordering, halts, durability

**Facets.** `lane.facet(facet, read)` stamps the value on every entry about a unit. A grouped metric trigger stamps its group value on its firing. A facet named like a column is a startup error.

**Metrics.** `rateBy(... by: { modelOf: seat })` returns `ModelRates.of(model)`, and every rate carries `hits` and `samples`. To count Audits *opened*, count transitions into the Audit kind's initial state with the facet. Firings record per-effect `applied`, so a deduped create is never counted as an opened unit.

**Quota (principle 15).** `account.quota` names an append-only partition. Without one, the account uses the ledger's own partition.

**Locks.** Locks are declared on the lane and held for the whole attempt, including while parked. Exclusive excludes everything on the resource; shared excludes only exclusive. `lockWaitMs` runs from `requested` to `acquired`.

**Ordering.** `lane.sequence(order, parked)` parks a unit behind a lower-ordered unit that ended at `failure` or `neutral`, with a reason naming the blocker.

**Halts.** A halt is resolved by a human through a grant `H.ops.resolve(halt)`, by a registered policy (recorded with the reads it used), or by a clock through `.timeout`. `H.on.halted(halt, after)` fires escalations.

**Durability.**

- Replay is by invocation sequence, and a step completed before the crash is not rerun.
- A command declares its restart behaviour with `.recovery('rerun' | 'park' | probe)`.
- A changed flow definition is detected by fingerprint and parks the attempt on `definitionChanged`.
- Single-writer exclusion is enforced by `claimWriter`.
- The author writes none of this.

### 6. Startup validation

`start()` fails, naming the offender, on any of the following:

- duplicate names;
- a facet named like a column;
- a trigger or spawn that targets an unregistered lane;
- a facet read that no lane declares;
- a flow state outside the lane's kind;
- a `sequence` parked state or `suspend` target that is not `waiting`;
- a seat model that no pool serves;
- a batch on a model without `submit` and `collect`;
- a command without argv or runners (preflights excepted);
- a `collect` poll whose input does not match the submit output;
- a halt used in a flow, including `H.halts.exhausted` named by a lane, that no client, timeout or policy can resolve;
- a missing ledger.

`exhausted` outside the kind's terminal states cannot be written.

A harness with no pools, seats or models is valid.

## What changed and why

| Change | Reason |
|---|---|
| **Deleted the job entity** (`H.job`, `JobDraft`, `JobShape`, `JobSubmitted`, `Job`); added `Command.collect(poll, every)` and `Executable.external` | The operator. This also closes known weakness 2: the job and the command were two entities for one executable with a submit/collect setting. `InvocationMode 'job'` is renamed `'external'`. |
| `State<N, P>` carries its position; `H.state` refuses `'active'`; `Kind<T, S, F>` records terminal names; `.states(...)` is variadic and inferred | Critique 1, and principle 12's ruling that a kind declares no states for active. |
| `exhausted: TerminalState \| H.halts.exhausted`; `retries` optional (default 0); `H.halts.exhausted` added; `RecoveryDecision.to` added | Critique 1. Invented dead-end parking states can no longer be written. Exhaustion either ends the unit honestly or parks the attempt, holding no capacity, for a named resolver. |
| Rule: a human verdict is a returned state, never `ctx.fail` | Critique 2. The track record stays executable-only. The kernel already allowed this; the parent's battery misused it. |
| `H.library` renamed `H.journal` with `.recall(policy)`; `H.policy.recall`; `RecallChoice` and `RecallCandidate`; `MemoryStore.search` returns `StoredMatch`; the default recall is a kernel policy | Critique 3. Principles 4, 8 and 14: the store supplies candidates, and a deterministic policy decides recall. |
| Patches apply immediately; only `state` defers while active; deadlines re-arm on data change, with `TimerEntry` and `Ledger.timers` | Scenario 9: an extended SLA never fires its old deadline. Scenario 11: redline handling is unchanged. |
| Firing `status: 'deduped'` replaced by per-effect `applied` | Scenario 9: audit counts were ambiguous. |

**Net surface.** Removed: 1 entity and 5 interfaces, 1 DSL method (`H.job`), and the firing status `deduped`.

Added:

- `Command.collect`;
- `Journal.recall`;
- `H.policy.recall`;
- `H.halts.exhausted`;
- `ExternalEffect`, `RecallChoice`, `RecallCandidate`, `TimerEntry`, `StateName`, `TerminalName`.

### Open

- **Step-scoped locks (the adversary's release-train scenario).** These are not in the battery. A lane lock is right for Backfill: a Migration must not slip between batches. A step lock would be a second scope with no battery caller.
- **Scenario 6's decision schema names seat slots.** This is repaired in the scenario: the halt records which critique the editor acted on, and both seats' policies read `rateBy` by `modelOf` for their own seat. It needs no kernel change.

## Principles broken

None.

The parent's claim of "none" is upheld and tightened. Principle 12's ban on active-position states is now enforced by type. Its "no dead-end failure states" intent is enforced by restricting `exhausted` to terminal states or a resolvable kernel halt.
