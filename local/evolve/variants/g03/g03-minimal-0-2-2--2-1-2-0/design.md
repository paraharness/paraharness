# harness-dsl: minimal, inference pass (child of g02-minimal-0-2-2--2-2-1-2)

The operator is **inference**. I listed every place the parent's scenarios needed a cast, an explicit type argument, or a type annotation that only existed to rescue inference. For each one I changed the surface so that inference carries it. Most of these changes also fix a named defect.

| Parent scenario site | Why it needed help | Surface change |
|---|---|---|
| S3, S8: `.map((unit): SupplyOf<typeof topic> => ({ update, state: 'queued' }))` | The literal `'queued'` widened to `string` inside `map`. | A clock's `produce` now receives a `Tick` with `create(data, key?)` and `update(key, { patch?, state? })`. Both are typed by the kind, so the literal checks against `S`. `SupplyOf` is deleted. |
| S2, S9, S11: `H.policy.rule<In, Out>(...)` or `(about: ApprovalAbout, metrics: Metrics)` on a halt-skipping rule | A free rule cannot see the halt's `about` and decision types. | `halt.policy(name, view => D \| null)`. The view is contextually typed (`about: C`, `metrics`, and `resolved(match?: Partial<D>)` for this halt). The policy is still a named, registered policy, and its decision is recorded with its reads. Because the view carries `resolved`, the self-reference cycle (`approval` used inside its own rule) disappears. |
| S9, S11, S12: `(_input: { readonly month: string }, metrics)` and `rule<…>` on report rules | `I` was inferred only from a parameter annotation. | `H.policy.rule(name, inputSchema, (input, metrics) => O)`. `I` comes from the schema, and `ctx.decide(rule, input)` checks against it with `NoInfer`. |
| S9: `const audits: Lane<AuditData, AuditState> = …` | A circular initializer: lane → flow → rule → trigger → lane. | The audit count now counts audit transitions (see rule 9), not the trigger's firings. The cycle is gone, so no annotation is needed. |
| S10: `summaries[0] === undefined` guard with a string `fail` | `batch` returned an array, so indexing lost the arity. | `ctx.batch(seat, inputs)` returns a tuple mapped over `inputs` (a `const` type parameter). `const [summary] = await ctx.batch(seat, [x])` is `Result<O>`. |
| `handler(flow, { retries, exhausted, params })` | One object mixed three concerns and needed `NoInfer` on all of them. | `handler(flow, ...params)` takes params only when the flow declares them (`RunArgs`). Retry is a second step, `.retries(times, exhausted, backoff?)`. `exhausted` is typed to the kind's terminal or waiting state names (see rule 1). |
| `Kind<T, S>` | It did not carry positions, so `suspend('x')` and `sequence(…, 'x')` were checked only at `start()`. | `State<N, P>` carries its position in its type. `Kind<T, S, F, W>` derives `F` (terminal names) and `W` (waiting names) from the states passed to `states(...)`. `ctx.suspend(state: W)`, `lane.sequence(order, parked: W)` and `retries(…, exhausted: F \| W)` are now type errors when wrong. |

Scenario annotations on standalone helpers are kept. For example, `const rank = (unit: PendingView) => …` declares a function's parameter. It is not an inference rescue.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | state | `H.state(n, 'pending' \| 'waiting')`, `H.state(n, 'terminal', verdict)` | A shareable lifecycle position. Its position is part of its type. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...others)` | The data shape and its states. The initial state must be pending. It declares nothing about failure. |
| Kind | role | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about(z).timeout(after, f).policy(name, f)` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing. |
| Kind | facet | `H.facet(n, values)` | A declared metric dimension and memory-scope axis. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | A specific thing with its backend. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)` | Role × model, chosen at attempt time. |
| Pivot | lane | `H.lane(n, kind).handler(flow, params?).retries(times, exhausted, backoff?)` | Kind × suppliers × store × handler. Optional: `.suppliers .store .wip .maxUsdPerUnit .locks .sequence .facet`. |
| Pivot | journal | `H.journal(n, memory, store, recall)` | Memory kind × store × recall policy (principle 8). This replaces the parent's `library`. |
| Pivot | pool | `H.pool(n, members, policy?)` | Accounts × policy. |
| Pivot | trigger | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation, harness | | |

Policies come in five domains: `model`, `account`, `scheduler`, `recall` and `rule`. A sixth, halt policy, is declared on its halt.

## Execution vocabulary

These definitions are unchanged from the parent: run, attempt (`running`, `blocked`, `suspended`, `ended`), invocation, position, retry.

`active` is not a declarable state position. Principle 12 says a kind declares no states for active work, and the position is derived from a running attempt.

## Rules

### 1. Skeleton, outcomes and retry (principle 12)

- **Position.** A running attempt puts the unit at `active`. A blocked or suspended attempt puts it at `waiting`. With no live attempt, the unit is at the declared position of its state.
- **Outcomes.**
  - An attempt that returns a state **succeeded**: it did its work and reached a decision.
  - An attempt that returns `ctx.fail(failure)`, or throws, **failed**.
  - An outside move, a supply re-entry or a preemption **cancelled** it.
- **Retry lives on the lane and ends in a declared state.** `.retries(times, exhausted, backoff?)` is the only way to finish a lane. A lane without `.retries` has no type `Lane`, so it cannot be registered, and the bound is never implicit.
- **Where exhaustion may leave a unit.** `exhausted: F | W` is typed to the kind's terminal or waiting names.
  - **Terminal.** Exhaustion ends the unit with that terminal's verdict.
  - **Waiting.** Exhaustion parks the unit there. Startup refuses a waiting exhaustion state unless at least one of these exits it:
    - a clock on the kind;
    - a deadline source whose `whileIn` contains the state;
    - a supplier of the kind that can update;
    - a client granted `writeWork`.
  - The parent's invented parking lots, waiting states with no exit, therefore still cannot be registered.
  - Scenario 8 needs the waiting form. A tenancy whose monthly review keeps failing must not churn; it parks at `current`, and the daily clock makes it due again.
- **Retry is separate from the handler.** Params belong to the handler. Retry and its end state belong to the lane step that follows it.

### 2. A decision is a state, not a failure

`ctx.fail` takes a `Failure` (`{ ok: false; error }`), which is the failed branch of an executable's `Result`. A flow can fail an attempt only:

- by forwarding an executable's failure (`return ctx.fail(built)`), or
- by throwing.

A human "no" therefore cannot be typed as a failed attempt. It ends the attempt by returning a state of the kind. In that case:

- the attempt **succeeded** as an execution;
- the **kind's verdict** says whether the work succeeded;
- the halt's recorded decision feeds approval metrics.

Retries apply only to execution failures. Model and seat track records count invocation failures and kind verdicts, never a human's opinion disguised as a crash.

### 3. Recall is a policy on the journal

`H.journal(name, memory, store, recall)` makes recall a required, registered deterministic policy (`H.policy.recall(name, view => candidates)`). At each model call the kernel works in four steps:

1. It asks the store for scoped candidates. `MemoryStore.search` returns items, plus an optional `similarity` when the backend is a vector store.
2. It builds the `RecallView`. The view holds:
   - each candidate's **specificity**, computed by the kernel from the envelope against the call's scope;
   - each candidate's **track record**, a `Rate` of succeeded attempts among the attempts the item was present in, with its sample count;
   - its `similarity`;
   - `ranked`, the kernel's standard ordering by specificity, then track record.
3. It calls the policy.
4. It records the chosen ids and the policy name on the invocation (`memoryIds`, `recall`).

Candidate items (`status: 'candidate'`) are never passed to recall until accepted.

### 4. Supply and outside moves

| Target's position | Patch | `state` given |
|---|---|---|
| Live attempt at `active` | Deferred | Deferred |
| Live attempt at `waiting` | Applied | Cancels the attempt, then moves the unit |
| No live attempt | Applied | Moves the unit |

- **Change: when a deferred update applies.** It applies when the attempt **leaves `active`**: at its end, or at its next block or suspend. It then follows the row for the attempt's new position. Scenario 11 depends on this. A redline that arrives during `draft` is applied when the attempt blocks on `counsel`. That update cancels the attempt and re-enters at `draft` with the redline. It is neither dropped nor fatal.
- **Deferral applies to supplier updates only.** An operation patch is applied at once and recorded. The running flow's `ctx.unit` is a snapshot taken at attempt start.
- **Deadline sources re-arm on every recorded data change of the unit.** The kernel recomputes `due(data)` after each recorded patch and cancels the old timer in the same transaction.

### 5. Locks: two scopes, one entity

- `lane.locks(data => Lock[])` holds a lock for the whole attempt.
- `command.locks(input => Lock[])` holds a lock for one invocation.

A step waiting for a lease suspends the attempt. While suspended it is at the `waiting` position and holds no runner slot and no WIP. `lockWaitMs` is recorded on the lease entry. The entry carries `scope: 'attempt' | 'invocation'`.

### 6. Halts (principle 17)

- **Policy resolver.** `halt.policy(name, view => D | null)` is a named policy. It runs at raise time, and its decision is recorded with the metric reads and sample counts it used. `null` means "ask a human".
- **Clock resolver.** `halt.timeout(after, about => D)` runs from the recorded raise and resolves with resolver `clock`. It does not cancel the attempt.
- **Human resolver.** A human resolves through a client granted `H.ops.resolve(halt)`.
- **Escalation.** `H.on.halted(halt, after)` fires a trigger a fixed interval after the raise.

### 7. Ordering, jobs, cost, quota, durability

These rules are unchanged from the parent:

- `sequence` parks a unit with a reason. Its parked state is type-checked as a waiting state.
- A job submits, suspends and polls, and is collected on restart.
- `maxUsdPerUnit` blocks on `costCeiling`.
- `account.quota` names a quota partition. With none, the account uses the ledger's own partition.
- Replay goes by invocation sequence, with per-command `.recovery` and fingerprint parking.
- `claimWriter` enforces a single writer.

### 8. Startup validation

These checks remain from the parent:

- duplicate names;
- a facet named like a column;
- an unregistered target lane;
- an undeclared facet read;
- a flow state outside the lane's kind;
- a seat model that no pool serves;
- a batch on a model without `submit` and `collect`;
- a command without argv or runners;
- an unresolvable halt;
- a missing ledger;
- a journal whose recall policy is not registered;
- a `command.locks` resource that does not appear in any harness descriptor.

One check is new: a waiting `exhausted` state with no exit (rule 1).

### 9. Scenario-level answers

- **Scenario 9 `sent`.** `sent` is a terminal success state.
- **Scenario 9 `escalated`.** `escalated` is `failure`.
- **Scenario 9 "audits opened".** The count is `count({ of: { entry: 'transition', kind: audit, state: 'audit-open', facets } })`. `FiringEntry.effects` records each effect's outcome as `applied` or `deduped`.
- **Report rules that read a lane** must not be decided inside that lane's own flow. Doing so creates an inference cycle (flow → rule → lane → flow). Scenarios 11 and 12 export such rules for the supervisor and telemetry instead.

## What changed and why

| Change | Reason |
|---|---|
| `State<N, P>`; `Kind<T, S, F, W>`; `active` not declarable | Inference: positions are checked by type. Principle 12: no states for active work. |
| `handler(flow, ...params)` then `.retries(times, exhausted, backoff?)` | No dead-end waiting ends, and handler options no longer mix concerns (weakness 6). |
| `ctx.fail(failure: Failure)` | A human decision cannot be typed as a failed attempt. |
| `H.journal(n, memory, store, recall)`; `H.policy.recall`; `RecallView` | Principles 4, 8 and 14. |
| `halt.policy(name, view => …)` | Inference: no type arguments and no self-reference cycle. |
| `H.policy.rule(name, inputSchema, decide)` | Inference: `I` comes from the schema. |
| `Tick.create` and `Tick.update`; `SupplyOf` removed | Inference: literal states without return annotations. |
| `ctx.batch` returns a mapped tuple | Inference: arity is kept. |
| `command.locks` restored; `LeaseEntry.scope` | A step-scoped exclusive lease. |
| Operation patches immediate; deadlines re-arm on data change | Scenario 9: SLA extension. |
| `FiringEntry.effects` records per-effect outcome | Scenario 9: firing honesty. |
| **`retries(times, exhausted: F \| W, backoff?)`**, plus a startup check that a waiting exhaustion state has an exit | Scenario 8 (run against this surface). A tenancy is never terminal while the customer is a customer. With exhaustion typed to terminal states only, a repeatedly failing monthly review could only end at `churned`, which is a lie. A negotiation whose drafting keeps failing could only end at a walk-away or expiry it did not reach. Principle 12 says the lane names where exhaustion leaves the unit "in the kind's own states", not only terminal ones. The startup exit check keeps out the dead-end parking lots that motivated the terminal-only rule. |
| **Deferred supplier updates apply when the attempt leaves `active`**, not only at its end | Scenario 11: a redline during `draft` must reach the unit before counsel decides on a stale draft. No type change. |

### Weaknesses left open

- A halt raised twice in one flow is addressed only by sequence (weakness 3).
- Batch and job remain two forms.
- The supervisor's transport is still hidden. Scenario 7's one session over two harnesses is two supervisor clients, one per harness, with no entity for the session (weakness 8).
- Scenario 7's "shared module" is expressed as shared constants in one file, because scenario files may import only `harness-dsl`.

## Principles broken

None.

The widened exhaustion rule stays inside principle 12. The lane names the end state in the kind's own states, and the kernel refuses an end state with no way out.
