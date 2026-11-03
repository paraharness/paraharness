# harness-dsl: minimal, surface cut (child of g01-minimal-0-2-2--0-2-2-1)

The operator is **surface-cut**. This child removes:

- every method that no scenario in the battery calls;
- every option that has one caller, wherever a caller already present can carry the meaning instead.

It also repairs the adversary's three sharpest critiques of the parent. Most repairs are cuts in their own right:

- **The retry default.** The bound moves into the lane's handler declaration, and the kernel default is deleted.
- **"Waiting" with four meanings.** `waiting` now names a position only.
- **Imperative facets and string model keys.** Facets are read from unit data by a lane declaration. Model rates key on the model entity.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and its states. It declares nothing about failure. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about(z).timeout(after, resolve).policy(rule)` | A named outside decision. |
| Kind | **resource** | `H.resource(n)` | A named shared thing. |
| Kind | **facet** | `H.facet(n, valuesSchema)` | A declared metric dimension and memory-scope axis. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | A specific thing with its backend. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy)` | Role × model chosen at attempt time. An "agent" in the sense of principle 8 is a seat given one model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, { retries, backoff?, exhausted, params? })` | Kind × suppliers × store × handler. Optional settings: `.suppliers() .store() .wip() .maxUsdPerUnit() .locks(f) .sequence(f, parked) .facet(facet, read)`. |
| Pivot | **library** | `H.library(n, memory, store)` | Memory kind × store: a recall source. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | Accounts × policy: the account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation, harness | | |

Kernel halts are exported by `H.halts`:

- `interrupted`
- `definitionChanged`
- `costCeiling`

All three use the decision `{ action: 'restart' | 'continue' | 'abandon' }`.

## Execution vocabulary (principle 22)

| Word | One meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. Its status is `running`, `blocked` (on a halt), `suspended` (on a timer, children, a job, a batch, or a lease) or `ended`. An ended attempt has the outcome `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable. A job is one invocation. Each batch item and each command retry is its own invocation. |
| **Position** | `pending`, `active`, `waiting` or `terminal`. **`waiting` names a position and nothing else.** |
| **Retry** | A lane retries attempts (`retries` in the handler options). A command retries invocations (`command.retries`). |

The parent used "waiting" for four things. Each now has its own word:

- `ctx.wait` is now `ctx.suspend`.
- The attempt status `waiting` is now `suspended`.
- `Supply.deferred` is deleted (see rule 3).

A reader of `ctx.suspend('observing', { at })` can tell it does two things:

- It moves the unit to the waiting state `observing`.
- It suspends the attempt.

## Rules

### 1. Skeleton and retry (principle 12)

**Position derivation.**

| Condition | Position |
|---|---|
| A running attempt | `active` |
| A blocked or suspended attempt | `waiting` |
| No live attempt | The position its state declares |

**Attempt outcomes.**

| Outcome | How it happens |
|---|---|
| `succeeded` | The flow returns a state. |
| `failed` | The flow returns `ctx.fail`, or throws. |
| `cancelled` | An outside move, a supply re-entry, or a preemption. |

**The retry bound is part of the handler.** `handler(flow, { retries, backoff?, exhausted })` is the only way to give a lane a flow.

- Every lane therefore has a bounded retry policy and a declared end state.
- `exhausted` is typed as a state of the lane's kind.
- "Unbounded" and "bounded with no end" cannot be written.
- `retries: 0` means do not retry.
- **The parent's kernel default of unbounded retries is deleted.** Principle 12 and scenario 11 hold by construction.
- Scenario 8's lanes must now declare their end states. For example, an experiment's analysis failure exhausts to `inconclusive` only if the author says so.

**Command retries.** `command.retries(n, backoff?)` retries the invocation in place. Exhaustion returns `{ ok: false }` to the flow.

**Return bounds (scenario 11).** `H.on.enters(kind, state, { times: n })` is the declared bound. The race the adversary found is closed by an ordering rule:

- A unit-source trigger is evaluated inside the same ledger transaction that records its transition.
- The kernel makes the unit schedulable only after that transaction commits.
- A second `returned` therefore moves to `declined` before any scheduler sees the unit at pending.
- No attempt starts on it and none is cancelled.
- The flow counts nothing.

### 2. Supply and outside moves

A `create` whose key belongs to a unit that is not terminal records a `deduped` firing (from a trigger) or does nothing (from a supplier). A key whose unit is terminal creates a new unit under the same key. The latest unit per key is the one read, which answers the scenario 9 question.

An `update` is handled by the target's position at the time it arrives:

| Target's position | Patch | `state` given |
|---|---|---|
| Live attempt at `active` | Deferred to attempt end | Deferred to attempt end |
| Live attempt at `waiting` | Applied | Cancels the attempt (cause `supply`), then moves the unit |
| No live attempt | Applied | Moves the unit |

One rule covers every "not now versus re-enter" case:

- **Scenario 2:** a customer reply while the draft awaits approval cancels the attempt and returns the unit to `classifying`.
- **Scenario 11:** a redline during `draft` is deferred. A redline during `counsel` re-enters at `draft`. The adversary showed the parent could not tell these apart.
- **Scenario 8:** a vendor reply during a running round is deferred.

The supplier never says which behaviour it wants. The kernel already knows the position.

### 3. Facets are declared, not stamped (principles 8 and 18)

`lane.facet(category, data => data.category)` declares how a lane's units carry a facet value.

- The kernel stamps the value on every entry about the unit: transitions, attempts, invocations, halts, leases, and trigger firings sourced from the unit.
- It reads the value at the time of each entry.
- A flow that learns the value (for example a classifier) writes it into unit data with `ctx.update`. From then on, every entry carries it.

A grouped `H.on.metric(... by: facet)` stamps its group value on its firing as that facet. Scenario 9's `count({ of: { entry: 'firing', trigger, facets: [category.of(v)] } })` therefore counts real firings. Recall scope uses the unit's current facet values.

`ctx.facet` is deleted. No flow code is coupled to any metric.

**Model rates key on the entity.** `rateBy({ ..., by: { modelOf: seat } })` returns `ModelRates`, and `rates.of(sonnet)` returns a `Rate`. A model with no samples returns `{ value: null, hits: 0, samples: 0 }`. No string stands in for the model. The column overload of `rateBy`, which nothing called, is removed with its `Column` type.

**Adapter strings.**

- **Preflight.** `ssh.host({ preflight })` now takes a command (`Executable<void, unknown>`). It is recorded, priced and metered like any invocation. A preflight command runs on the runner it guards and declares no runners of its own.
- **Backend configuration strings.** `http.store`'s `stateField` names a field in the owner's helpdesk. `qdrant.memory`'s `embedder` names the vector backend's embedding model. Both are configuration of a backend inside an adapter, as `claudeCode.model(id)` is. Principle 8 bans a string standing in for a *kernel entity* (resource, halt, facet, model in a metric). It does not ban a backend's own settings. These stay.

### 4. Locks (one scope)

- Locks are declared once, on the lane: `lane.locks(data => Lock[])`.
- They are held from before the attempt starts until it ends, including while it is parked.
- Exclusive excludes everything on the resource. Shared excludes only exclusive.
- The scheduler starts a unit only when its locks are free. `lockWaitMs` runs from `requested` to `acquired`.
- A migration is a one-command attempt, so an attempt-scoped lock is exactly the old invocation lock. `Command.locks` and the lock-scope column are therefore cut.
- A GPU job pins nothing unless its lane declares a lock.

A parked holder keeps its locks, and that holding is visible in three places:

- `leases()` with `parked: true`;
- the board;
- `ParkedFacts.locksHeld`.

`abandon` releases the locks at once.

### 5. Ordering

`lane.sequence(order, parked)` works as follows:

- A unit starts only when every unit of the lane with a lower order value (latest per value) is at a `success` terminal.
- If such a unit is at `failure` or `neutral`, the waiting unit moves to `parked` with a reason naming the blocker.
- A parked unit is released when the blocker's value later succeeds, or by `work.move`.

### 6. Halts (principle 17)

The rules are unchanged from the parent:

- **Policy resolver.** Runs when the halt is raised. Its decision is recorded with the metric reads and sample counts it used.
- **Human resolver.** Resolves through a client granted `H.ops.resolve(halt)`.
- **Clock resolver.** `.timeout` runs from the recorded raise and resolves without cancelling.
- **Escalation.** `H.on.halted(halt, after)` serves escalation, such as paging a deputy. In scenario 11 the deputy is given a second client that holds `resolve(signoff)`, so either person can resolve.

`H.ops.resolveHalts`, a blanket grant, is cut. Every grant now names its halts, as principle 17 says.

### 7. Jobs, batches, cost, quota, memory, durability

These rules are unchanged from the parent:

- **Jobs:** submit, suspend, poll, collect on restart.
- **Cost:** `maxUsdPerUnit` is cumulative and blocks on `costCeiling`.
- **Quota (principle 15):** `account.quota` names a partition. With none, the account uses the ledger's own partition (`Ledger extends QuotaPartition`).
- **Memory:** the kernel owns the envelope; candidates are not recalled until accepted.
- **Replay:** by invocation sequence, with `.recovery` per command and fingerprint parking.
- **Single writer:** enforced by `claimWriter`.

### 8. Startup validation

`start()` fails, naming the offender, on each of these.

**Names**

- duplicate descriptor names, across every sort;
- a facet named like a column (`kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`, `resolver`).

**References**

- a trigger or spawn that targets a lane that is not registered;
- a facet read by a policy or filter that no registered lane declares.

**States**

- a flow state that is not a state of the lane's kind;
- an `exhausted` state outside the kind;
- a `sequence` parked state that is not a waiting state;
- a `suspend` target that is not a waiting state.

**Seats and models**

- a seat model or policy candidate that no pool can serve;
- a batch on a model without `submit` and `collect`.

**Executables and halts**

- a command without argv;
- a command without runners, unless it is a preflight;
- a halt whose `.timeout` or `.policy` reads `about` when no `.about` is declared;
- a halt referenced in a flow that no client can resolve and that has no timeout or policy.

**Harness**

- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

| Change | Reason |
|---|---|
| `Lane.retries` folded into `handler(flow, { retries, backoff?, exhausted, params? })`; the kernel's unbounded default deleted | Critique 1: principle 12 and scenario 11. It also removes a method and the second `handler` overload. |
| `ctx.wait` renamed `ctx.suspend`; attempt status `waiting` renamed `suspended`; `Supply.deferred` deleted | Critique 2: one word, one meaning. The update rule by position replaces `deferred` and fixes scenario 11's redline-during-counsel. |
| `ctx.facet` removed; `Lane.facet(facet, read)` added; facets stamped on firings | Critique 3: dimensions declared, not side effects. Fixes scenario 9's always-zero audit count. |
| `rateBy` by model returns `ModelRates.of(model)`; the column overload and `Column` removed | Critique 3: no string keys. The column overload had no caller. |
| `ssh.host` `preflight` takes a command | Critique 3: the preflight gets a ledger row and metrics. |
| `Command.locks`, `LockScope`, the `scope` and `invocation` fields on leases removed | Command locks had one caller, and a lane lock expresses it identically. |
| `RunOptions` and `RunOptions.resources` removed; `RunArgs` is `[]` or `[input]` | No caller. |
| `ctx.move` removed | No caller. Flows end by returning a state. |
| `H.ops.resolveHalts` removed | Blanket grants contradict "a grant names the halt" (principle 17). Callers use `resolve(...)`. |
| `EntryFilter.seat` and `EntryFilter.model` removed | No caller. `successRate` and `modelOf` cover them. |
| Trigger-in-transition ordering; dedupe and re-create by key specified | Scenario 11 return race; scenario 9 key reuse. |

**Net surface.** Removed:

- 3 builder or context methods;
- 1 option type;
- 2 filter fields;
- 1 grant;
- 1 overload;
- 1 type and 2 entry fields.

Added:

- `Lane.facet`;
- `ModelRates`;
- `HandlerOptions` and `RetryOptions`;
- `FiringEntry` status `deduped`.

`Harness.start` is kept although no scenario calls it. It is how a harness runs, and it is the operator's single entry point.

### Weaknesses left open

- **Two gates of one halt in one flow (the adversary's scenario 13).** The gates are distinguishable only by sequence. This is not in the battery, and an address would be a new noun. It is left open, as known weakness 3.
- **Batch and job remain two forms.** The batch carries the priced, model-only discount.
- **The handler options carry the retry bound.** This keeps the lane at its parent's concern count. Weakness 6 is not worsened, but it is not solved either.

## Principles broken

None.

The parent's claim of "none" was false with respect to principle 12, because of its unbounded retry default. That default is deleted here, and the bound is required by the type of `handler`.
