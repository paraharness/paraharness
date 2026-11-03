# harness-dsl: minimal, placement and failure repaired (child of g02-minimal-al-0-2-2)

The operator is **scenario-fix**. The parent handled scenario 4 (operations) worst. This child changes the design so that scenario 4 is expressed truthfully:

- host-bound work runs on its host;
- the preflight belongs to the work it guards;
- triggers have defined semantics;
- preemption never leaves parked work behind.

It also repairs the adversary's three sharpest critiques:

- (a) unbounded fixed retry;
- (b) the half-finished string discipline;
- (c) flows coupled to state entities.

It also repairs the "two vendors for one model" remark.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).failsTo(state?)` | Data shape, states, and an optional failure move. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, schema)`; kernel halts `H.halt.costCeiling`, `H.halt.definitionChanged` | A named outside decision. |
| Kind | **tag** | `H.tag(n)` | An author-defined grouping dimension for metrics. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each with its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, { params?, states? }).suppliers(...).store(s).wip(n).retry(p).maxUsdPerUnit(x)` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source: memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).states(...names).params(z).does(ctx => name)` | A handler body over flow-local state names. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(...).preflight(check).recovery(r)` | A deterministic executable. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

## Execution vocabulary

| Word | Definition |
|---|---|
| **Run** | One lifetime of a harness process. |
| **Attempt** | One execution of a lane's flow for one unit. Its states are `running`, `blocked` (on a halt), `waiting` (in `ctx.wait`) and `ended`. Its outcome is `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable inside an attempt. Each step retry, each batch item and each preflight is its own invocation. |
| **Step** | Not a word in this design. |

## Rules

### 1. Skeleton (principle 12)

Positions and verdicts are unchanged from the parent.

**How a flow ends:**

| How the flow ends | Attempt outcome |
|---|---|
| Returns a flow state name | `succeeded`. The unit moves to the kind state that name maps to (rule 2). |
| `ctx.fail` or a throw | `failed`. See rule 3. |
| An outside move, a preemption or a cost-ceiling stop | `cancelled`. |

### 2. Flows name their own states; lanes map them (repairs critique c)

A flow may declare its own state vocabulary with `.states('building', 'done', 'exhausted', 'abandoned')`. Without it, the vocabulary defaults to the states its kinds have in common.

`ctx.move`, `ctx.wait` and the return type use the flow's names.

A lane supplies `states: { flowName: kindState }` for every flow name its kind lacks. Names that coincide map to themselves unless overridden.

The mapping is typed: `HandlerArgs<F, S, P>` makes `states` required exactly when `Exclude<F, S>` is non-empty.

What this buys:

- Bug and Feature need not share state entities.
- A Feature may own `feature-abandoned` (neutral) while a Bug owns `bug-abandoned` (failure). Both map from the flow's `abandoned`.
- A Feature with an extra `needs-design` state is still handled by `ticket-work`.

`ctx.unit` exposes `key` and `data` only. A flow never reads its kind's state, which keeps it blind to the kind.

**Startup validation:**

- every mapping target is a state of the lane's kind;
- a `wait` name maps to a waiting state;
- a returned name maps to a non-active state.

### 3. Failure and retry (repairs critique a)

A failed attempt consults the lane's retry policy, `Lane.retry(policy)`. The policy reads `RetryView.failures`, the unit's consecutive failed attempts, and answers `{ retryInMs }` or `'stop'`.

| Retry answer | What happens to the unit |
|---|---|
| `retryInMs` | It stays at its pending state with `retryAt` set. |
| `'stop'` | It moves to the kind's `failsTo` state. This is the only way an attempt failure moves a unit, as principle 12 requires. |

`start()` refuses a lane that declares `.retry` when its kind declares no `failsTo`, because `'stop'` would have nowhere lawful to go.

**Default when a lane declares no `.retry`:**

- **The kind declares `failsTo`.** Backoff runs from 1 minute, doubling, and stops after the 3rd failure.
- **The kind declares no `failsTo`.** Backoff runs from 1 minute and is capped at 1 hour. After 5 failures the unit shows on the board as `retrying (n)` for the supervisor's `work.update`. The kernel invents no destination.

All model-calling lanes in the battery whose kinds can dead-end now declare `failsTo`, so the parent's "Bug retries forever" cannot occur.

**The adversary's fleet-patching scenario:**

```
.failsTo('quarantined')
.retry(H.policy.retry('patch-retry', ({ failures }) =>
  failures >= 3 ? 'stop' : { retryInMs: failures === 1 ? 600_000 : 1_800_000 }))
```

The cross-fleet rate limit is a scheduler read of `metrics.rate` over `transition` entries with `cause: 'retry'`.

**Step retry.** `RunOptions.retry` is the same `RetryPolicy` type applied to one invocation, with `failures` counting that invocation's tries (scenario 5). One policy shape serves both levels.

### 4. Durable waits

Unchanged from the parent. `ctx.wait(name, { at })` and `ctx.wait(name, { children })` suspend one attempt, which holds no slot and no WIP and resumes by replay.

### 5. Success rate

- `success / (success + failure)` over terminal transitions.
- Neutral states are excluded from the rate and stay countable by state entity.
- Every rate carries `hits` and `samples`. `value` is `null` at 0 samples.

### 6. Moving a unit with a live attempt cancels the attempt first

### 7. Supply and keys

Unchanged from the parent.

- A `create` with an open key is ignored.
- `update` addresses the open unit with that key.
- The ledger snapshots every unit, so storeless kinds have data and telemetry.

### 8. Entities, not strings (repairs critique b)

| What | Now takes or is |
|---|---|
| `Scope.kinds`, `Scope.roles` | Descriptors. The ledger stores names (`StoredScope`). |
| `EntryFilter.state` | `State` entities. |
| `EntryFilter.status` | `EntryStatus`, the literal union of every ledger status, so a typo is a type error. |
| Kernel halts | Entities: `H.halt.costCeiling`, `H.halt.definitionChanged`. |
| Grouping | `rateBy({ by })` takes a `GroupBy` (see below). |
| Lookup in a grouped result | `RateGroups.get(key | descriptor)`, which returns a zero-sample `Rate` when absent. The ad-hoc `noSamples` helpers go away. |
| Scheduler views | Carry no `kind` string. Kind tests go through `is(kind)`. |

`GroupBy` is one of:

- a `Tag` entity, set with `ctx.tag(tag, value)` and filtered with `tagged: { tag, value }`;
- `{ modelOf: agent }`, which groups an attempt's entries by the model that served that agent in it;
- `'trigger-group'`, the group key of metric-trigger firings.

`{ modelOf: agent }` ends hand-tagging of `drafted.model ?? 'unknown'`, and `Result.model` is removed. Scenario 6's A/B reads `{ modelOf: criticA }` and `{ modelOf: criticB }`.

Ledger entries themselves keep names as strings. They are the storage record a backend writes, not authoring vocabulary.

### 9. One model, many accounts

A **model** is what is served: its name, provider and price. It is declared once, in `harness-dsl/anthropic`.

The **account** is the driver. An account carries `call`, `recover` and an optional `submit`/`collect`:

- a Claude Code subscription is an account whose driver is a Claude Code session;
- an API account is an account whose driver is HTTP.

So `opus` is one instance, and metrics keyed by model name are honest across accounts. `claude-code.model` is removed. `start()` refuses a batch whose pool has no account with `submit`/`collect`.

### 10. Triggers

**Sources:** `on.enters`, `on.streak`, `on.deadline`, `on.metric`. Their behaviour is unchanged from the parent, except for the points below.

**Streak semantics.** `on.streak(kind, state, n, group)` counts terminal transitions of `kind` within one `group` value, in ledger order.

- It fires when the last `n` of them are all entries into `state`.
- Any other terminal state in the group resets the count. A `heartbeat-ok` between failures breaks the streak.
- After firing, the count restarts. Three more failures are needed to fire again.

**The attempt on a unit event.** `UnitEvent.attempt` is `{ durationMs } | null`, never optional. It is `null` exactly when the transition was not caused by a flow (supply, operation, trigger). An author handles `null` explicitly and no silent `?? 0` is needed. `durationMs` excludes blocked and waiting time.

**Recording.** Effects and recording are unchanged: firings are `firing` entries, and pause and resume are `lane` entries with `durationMs`.

### 11. Scheduler, preemption and placement (scenario 4)

**Scheduler.** The scheduler returns an ordered `start` and an optional `preempt`.

- Blocked attempts free runner slots and keep WIP.
- Waiting attempts hold neither.

**Preemption is cancellation, not interruption.**

- A preempted attempt receives the cancellation signal. Its running invocation is cancelled through `Cancellation`.
- The attempt ends `cancelled`.
- The unit returns to the pending state it held before the attempt, recorded as a transition with `cause: 'preempt'`.
- Recovery (`.recovery`) is never consulted. It belongs to crashes only.
- No preempted unit is parked.

`ActiveView.state` lets a policy spare work at a delicate point. Scenario 4 preempts heartbeats and checking renewals, never a renewal in `cert-renewing`, and never a backup.

**Placement.** `command.on(...)` has two forms:

| Form | Places the invocation on |
|---|---|
| `.on(r1, r2)` | Any listed runner with a free slot. |
| `.on({ orders: dbHostA, users: dbHostB }, (input) => input.database)` | The runner chosen by a typed key from the command's input. `K` is inferred from the record, and `by` must return `K`. |

With the keyed form, a backup of `orders` runs on `db-host-a`, and the invocation queues for that host's slot (`slots: 1` gives per-host concurrency 1). Affinity is a fact about where the database lives. It is declared on the command, an executable bound to runners, not on the kind (principle 10). The kind still says only `{ database }`.

**Preflight.** `command.preflight(check)` runs `check` with the same input, on the runner the command was placed on, immediately before it.

- If the check fails, the command is not started. Its invocation is recorded `refused` with zero cost, and the flow receives `{ ok: false, error: 'preflight: …' }`.
- The disk check belongs to `backup-database` alone. Renewals on the same host are not gated by it.
- `ssh.host` has no `preflight` option any more.

### 12. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it blocks the attempt on `H.halt.costCeiling`. The answer is `raise` with a new limit, or `stop`, which cancels the attempt.
- Daily budgets are scheduler reads of `metrics.sum`.

### 13. Accounts and quota (principle 15)

Unchanged from the parent.

- Quota is a ledger partition of append-only usage and cooldown events, folded at read time.
- `sqlite.ledger(path, { sharedQuota })` places that partition in a shared file.
- Shares belong to pools.

### 14. Memory

Unchanged from the parent, with one difference: the scope takes descriptors.

- Candidates are never recalled until accepted.
- Recall is one deterministic kernel ranking: similarity when the store reports it, then specificity, then track record.
- An agent reads the union of its `recalls` and writes to its one `records`.

### 15. Durability (scenario 10)

The mechanism is unchanged: replay of sequenced ledger entries, `Executable.recover`, batch handles, `requested` operation entries, wake fields, a lease-based single writer.

- An interrupted model invocation is recovered through the serving **account's** `recover`.
- A changed flow fingerprint blocks the attempt on `H.halt.definitionChanged`, which the supervisor answers with `restart` or `abandon`.
- Changing a lane's `states` mapping also changes the fingerprint.

### 16. Control API

- The API is made of operations, and clients are granted operations.
- `claude-code.supervisor` and `http.control` are both clients.

### 17. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names, including halts and tags;
- a lane mapping to a state outside its kind;
- a `wait` name or a `failsTo` target with the wrong position;
- `.retry` on a lane whose kind lacks `failsTo`;
- a keyed `on` record with a duplicate runner name;
- an unregistered lane referenced by a trigger;
- an agent no pool serves;
- a command without argv or runners;
- a missing ledger;
- a batch with no batch-capable account.

A harness with no pools, agents or models is valid.

### 18. A model policy knows the agent it chooses for

`ModelChoice` carries `agent: AgentRef`: the agent whose next invocation needs a model.

A model policy that compares models on a metric of that agent's work groups by `{ modelOf: choice.agent }`. It does not need to name the agent it belongs to.

## What changed and why

### Scenario 4 (operator target)

| Defect in the parent | Change |
|---|---|
| Backups placed on any free host | `Command.on(record, by)`: typed affinity from input data. |
| Renewals placed on database boxes at random | Renewals use the same keyed placement by domain. |
| Disk preflight on the runner, gating every command | `Command.preflight(check)` on the command it guards. `ssh.host` drops `preflight`. |
| Slow-backup note on `attempt?.durationMs ?? 0` | `UnitEvent.attempt` is `{ durationMs } | null`, with defined `null` semantics. |
| "Consecutive" a guess | Streak semantics specified (rule 10). |
| Preemption parking renewals | Preemption returns the unit to pending without recovery. Scheduler views expose `state` for sparing. |

### The three critiques

| Critique | Repair |
|---|---|
| a. Unbounded fixed retry | `Lane.retry(policy)`. `'stop'` moves to `failsTo`. A bounded default when `failsTo` exists. Start-time refusal of an impossible combination. |
| b. Strings | Descriptor scopes. `State`-typed and literal-status filters. Kernel halt entities. `H.tag`. `GroupBy` with `modelOf`. `RateGroups.get`. Kind strings removed from scheduler views. |
| c. Flows coupled to states | Flow-local state names with a typed lane mapping. `ctx.unit` reduced to key and data. |

The "two vendors for one model" remark is repaired by rule 9: models are declared once and accounts are drivers.

### Surface delta

**Added:**

- `H.tag`
- `H.halt.costCeiling`, `H.halt.definitionChanged`
- `FlowShape.states`
- `Lane.retry`
- the keyed `Command.on` overload
- `Command.preflight`
- `RateGroups`, `GroupBy`, `StateMap`, `HandlerArgs`, `FlowUnit`, `StoredScope`

**Removed:**

- `claude-code.model`
- `ssh.host` `preflight`
- `Result.model`
- `UnitView.kind` and `UnitView.lane` (kept on `UnitRecord`)
- string tags (`ctx.tag(record)`, `byTag`)
- `Model.call`, `recover`, `submit` and `collect` (moved to `Account`)

### Scenario pass over 01 to 05 (this generation)

**The gap: a model policy could not group by the agent it chooses for.**

Scenario 3's synthesizer model is chosen by comparing citation-check pass rate per model. The only grouping by model is `{ modelOf: agent }`. A model policy that names its own agent is a definition cycle: the agent is built from the policy, and the policy body reads the agent. TypeScript rejects the cycle, and an implementation would face the same knot at load time.

The only escape is a hand-written `{ name: 'synthesizer', entity: 'agent' }`, which is a string in disguise (critique b). Scenario 6's A/B hits the same wall.

**Fix (rule 18).**

- `ModelChoice` gains `agent: AgentRef`.
- `GroupBy.modelOf` takes `AgentRef`, the new kernel type `Named & { entity: 'agent' }`, which every `Agent` satisfies.

`h.d.ts` is unchanged.

**Observations recorded from the pass, needing no surface change:**

- **Scenario 2, the conversation lifecycle.** A customer reply moves the unit to `new` (pending), not to `classifying` (active). Rule 6 cancels the live attempt; the next attempt moves to `classifying` as its first act. A unit cannot sit at an active state without an attempt, so "returns to classifying" is honest only as "returns to the queue in front of classifying".
- **Scenario 2, escalation.** A single `enters(conversation, 'escalated')` trigger creates the Escalation. The SLA deadline trigger only moves the unit, so breach, rejection and exhausted retries escalate one way, deduplicated by key.
- **Scenario 4, preflight placement.** The preflight command declares the same keyed placement as the command it guards, to satisfy startup validation. The kernel runs it on the guarded command's chosen runner regardless.

## Principles broken

None.

- **Principle 10.** Runner affinity sits on the command, not the kind. The keyed placement maps input data to runners, and the kind remains unaware of hosts.
- **Principle 12.** Retry belongs to the lane's policy, and only a kind's declared `failsTo` moves a unit on failure.
- **Principle 21.** Every addition answers a defect in a battery scenario, either scenario 4 or a critique of scenarios 1, 2, 6 and 7. `ModelChoice.agent` answers scenarios 3 and 6.
