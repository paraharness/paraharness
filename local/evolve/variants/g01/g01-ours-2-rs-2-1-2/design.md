# ours-2, merged: facets fold into resources

This child of g00-ours-2-1 applies the **merge** operator once. The facet and the resource are made one entity. It also repairs the adversary's three sharpest critiques and the scenario-7 defect.

## The merge: `Facet` + `Resource` → `Resource`

### Why they rhyme

The parent had two vocabulary entities that do the same job: each is a named thing that other entities reference by identity.

- **Resource** (principle 8): "a named shared thing that leases, memory scope and metric facets reference by identity."
- **Facet** (principle 18): "a declared dimension that is not a column."

In practice, every use of a facet in the battery is one of three things:

- a memory scope (scenarios 6 and 9);
- a metric dimension (scenarios 2, 9 and 11);
- a unit tag (scenarios 6, 9 and 11).

The resource already served memory scope and metric dimensions. The only difference was that a facet has many values, while the parent's resource was a single thing. Scenario 12 then faked the many-valued case for resources, with a `databases` record of two resources.

### The merged entity

`H.resource(n)` is now the one noun.

- A resource used whole is a single shared thing, such as `app-code`.
- `resource.is(value)` names one member of it, such as `database.is('orders')` or `category.is('billing')`. It produces a `ResourceValue`.
- Leases, memory scope (`when.resources`), metric dimensions (`.by(category)`), unit tags (`flow.tag(category, …)`) and creation values (`lane.create(child, e => [category.is(…)])`) all accept either form.

### What it buys

- **Principle 14 is repaired.** The envelope's `when` is back to exactly kinds, roles, skills and resources. The parent's knowing bend (a fifth `facets` slot) is gone.
- **Scenario 12 gets real per-database locks.** `database.is(input.database).exclusive()` replaces the hand-built record of resources.
- **One fewer entity and one fewer `H.*` method.**

### What it costs (honesty)

1. **A category is not shared.** A support category is not a "shared thing" in the plain sense of principle 8. Nothing stops an author writing `category.is('billing').exclusive()`, and the kernel will honour it by serialising billing work. That is meaningful but rarely intended. The type system cannot tell a lockable resource from a classifying one, because they are now one type.
2. **Values are open-ended.** Members of a resource are runtime strings, not declared entities. `category.is(s.classify.category)` mints a member from model output. Principle 8's "a string never stands in for it" now holds for the resource itself, but not for its members. Members are data under a declared entity. That is how a data value can be a dimension without declaring every category ahead of time.
3. **Weakness 4 grows.** The resource-binding plugin (the file-lease guard's `area`) maps whole resources. A family resource leased by member, such as `database`, needs no binding, because the lease table keys on `resource:value`. The startup check therefore applies only to whole resources claimed by an agent's file tools.

## Entities

### Kinds (vocabulary, no backend)

- **`H.work`**: the kind of a unit, its schema and its states.
- **`H.state`**: shareable. Each declares its position. A terminal state declares its verdict.
- **`H.resource`**: a whole resource or, through `.is(v)`, a member.
- **`H.halt`**: a named question with a context and a decision schema.
- **`H.memory`**: a memory kind.
- **`H.role`**: a role.
- **`H.skill`**: the typed contract for one model call.

### Instances (carry a backend)

- **Account.** `H.account(n, driver).quota(partition)`. The account no longer carries a share.
- **Model.** `H.model(id, opts).pricing(p)`.
- **Command.** `H.command(…)`.
- **Job.** `H.job(…)`, as a general external job or `.batch(seat)`.
- **Runners** live in `harness-dsl/runners`.

### Pivots

- **Seat.** Role × skill × models × choice policy.
- **Pool.** Accounts × shares × policy, written `H.pool(n, accounts).share(account, ratio).serves(...).policy(p).fallback(a)`.
- **Lane.** Work kind × suppliers × store × handler.
- **Journal.** Memory kind × store × recall.
- **Grant.** Client × operations.

### Execution

Unchanged from the parent, apart from the items listed under *What changed and why*: flow, trigger, streams, metric, policy and consequences.

## Rules

Only the rules that changed or matter here are repeated. Everything else is as in the parent.

### Moving and cancelling units

There are two verbs: `lane.move(select, to)` and `lane.cancel(select, to)`.

- **`move`** never ends an attempt.
  - On a unit with no live attempt, it applies at once.
  - On a unit whose attempt is running, blocked or suspended, it is recorded and applied when the attempt next ends. It is the same deferral rule as supplier updates.
- **`cancel`** ends the unit's live attempt with outcome `cancelled`, then moves the unit with cause `cancelled`.
  - On a unit with no live attempt, it is a move.
  - A cancellation is never counted against a model, seat, runner or account.
- **Selectors** are unchanged. `{ halted, key }` selects units whose attempt is blocked at that halt, so `cancel({ halted: replyApproval, key }, fresh)` cancels a draft awaiting approval and nothing else.
- **Reopen, wake and re-entry** are all `move`. Only `cancel` destroys work, and its name says so.

### Retry exhaustion must have a way out

`retry.exhausted` stays required, as principles 12 and 11 require.

- The target must be either a terminal state, or a waiting state that something can leave.
- A waiting state can be left when it is the `from` of a registered move or cancel selector, or the `failed` target of an `.order`.
- Any other target is a startup error, with this message: *"exhaustion target `stalled` of lane `x` has no exit; use a terminal state"*.
- Dead-end waiting states are therefore unwritable. A kind that wants "gave up" declares a terminal state such as `abandoned`, with its own verdict, usually failure.

### Ordering holds

`.order({ after, failed })` works as follows.

- A unit whose predecessor ends with a failure verdict moves to `failed` (cause `order`, with the reason recorded) and is *held*.
- If the predecessor later reaches a success verdict (an operator retries it), the held unit is released back to its pending state (cause `released`).
- The board lists held units with their reason and with the key that would release them. "Nothing will happen" and "someone outside will reply" are therefore distinguishable.

### Ceiling decisions are kernel-owned

`.ceiling({ maxUsd, halt, context, stopped })` halts the attempt before a step that would pass `maxUsd`.

- The halt's decision type must extend `CeilingDecision = { raiseToUsd?: number }`. This is checked at compile time.
- If the decision raises the ceiling above the amount already spent, the attempt continues under the new ceiling.
- Any other decision ends the attempt `cancelled`, and the unit moves to `stopped` (cause `ceiling`).
- The meaning of the decision no longer depends on a schema the author happened to write.

### Metrics read by entity, never by string

- `metrics.read(metric, ...at)` takes **entities** as key values.
  - A column value is the entity of that column: a `Model`, a seat, a lane, a work kind, a state, an account, a halt or a job. The resolver column takes `'human' | 'policy' | 'clock'`.
  - A resource dimension takes a `ResourceValue` of that resource.
- The allowed value types are computed from the metric's `by(...)` dimensions. `read(approvals, category.is(c), sonnet)` type-checks, and `read(approvals, region.is(r))` does not.
- Renaming a resource renames every key with it.
- Crossing events expose `event.of(category)`. This is restricted to the resource dimensions of the crossed metric.

### Seat credit

`stream.credit(...seats)` emits one record per listed seat per event.

- The **seat column** is set to that seat.
- The **model column** is set to the model that seat ran on in the same attempt. This is read from the ledger's invocation records for that attempt. If the seat was not invoked in that attempt, no record is emitted for it.
- An owner-defined A/B metric therefore keys on the seat, and may also key on the model. For example: `H.events.decisions(editorial).credit(reviewerA, reviewerB).rate(c => actedOn(c.event).includes(c.seat))`.
- Swapping a seat's model keeps the seat series.
- The decision schema no longer has to mirror the parallel-call keys.

### Shared accounts, per-harness shares

- An account is one descriptor, imported by both harnesses of scenario 7. It names its quota partition.
- The share cap is a relationship between this harness and that account, so it lives on the pool (`pool.share(account, 0.6)`). No derived account descriptors exist, so principle 11's one-name rule holds.
- `AccountCandidate.maxQuotaShare` is computed from the pool. The folded `QuotaState.byHarness` shows each harness's consumption of the shared window.
- A client may name a `session` (an adapter option). Two clients with one session are one supervisor session holding two endpoints. The `Client.session` field lets the adapter join them.

### Startup validation (additions)

`start()` now also fails on:

- an exhaustion target with no exit;
- a pool `share` for an account not in the pool;
- a `ceiling.stopped` target that is not terminal;
- two resources with one name, which covers what was a facet-versus-resource clash;
- a resource name that repeats a column name.

## What changed and why

Changes are listed against the parent, g00-ours-2-1.

1. **Facet merged into resource** (operator). `H.facet`, `Facet`, `FacetValue`, `DimName` and `ScopeInput.facets` are removed. `Resource.is(value)` gives a `ResourceValue`.
   - The kernel's `Scope.resources` is now `{ resource, value? }[]`.
   - `UnitMeta.facets` becomes `resources`, and `NewRecord.facets` becomes `values`.
   - The honesty cost is listed above.
2. **`lane.cancel` split from `lane.move`** (critique c). `move` never kills an attempt and defers while one is live. Scenario 2's reply-while-classifying no longer kills classify. The deferred update fires once the attempt blocks at approval, and `cancel({ halted })` acts then.
3. **Ceiling decision has kernel meaning** (critique c). `CeilingDecision` is kernel-owned, and the lane declares a terminal `stopped` state.
4. **Exhaustion targets must have an exit** (critique a). Dead-end waiting states become a startup error. Order-parked units are held with a release, and the board shows `held`.
5. **Metric keys are entities** (critique b). `MetricsReader.read(metric, ...DimValue<Key>[])` replaces the string-keyed record. `CrossingEvent.of(resource)` replaces `e.key.category`.
6. **`stream.credit(...seats)`** (critique b, scenario 6). Owner-defined A/B metrics key on the seat, as principle 8's seat ruling requires.
7. **Shares moved from account to pool** (scenario 7 critique, weakness 5 in part). The account is an instance with a backend; the share is a per-harness relationship, and so it lives on a pivot.
8. **Client `session`** (weakness 8, scenario 7). One supervisor session can hold endpoints into several harnesses.
9. **`ModelChoice.seat` and `RecallChoice.seat`** are now seat entities, not names.
10. **`TransitionEvent.reason`** carries the order or ceiling reason, so a parked 0042 says why on the board and in metrics.
11. **Credit sets the model column too** (scenarios 2 and 3, written against this surface). Two scenarios need a model dimension on owner-defined metrics:
    - Scenario 3's synthesizer A/B ranks two models by citation-check pass rate, but the citation check is a command with no model of its own.
    - Scenario 2's approval rate "by model" is read from halt decisions, whose own model field belongs to the resolver.

    With `credit(seat)`, the credited record carries the seat's model from the same attempt, so `.by('model')` means the model that did the work being judged. There is no new method or type; the rule is now stated where it was silent.

### Defects not taken up

These are listed openly rather than repaired:

- **Jurisdictional quorum** (the adversary's scenario 13): resolvers scoped by lane, and multi-person approval, are not in the battery. A grant still names a halt without a lane scope. The repair would be `H.ops.resolve(halt).in(lane)`, but no battery scenario calls it, so principle 21 keeps it out.
- **Lane breadth** (weakness 6) is unchanged.
- **A decision inside a `when` branch is dropped from the flow state.** A halt's decision taken inside `when` is recorded on the ledger, but it does not reach later steps, because `when` returns its input state type.
  - Scenario 1's owner call is therefore not passed back to the builder in the same round.
  - Scenarios 2–6, written against this surface, do not depend on it.
  - The repair would be an optional merge of the branch state, and it is left for a later generation.

## Principles broken

None.

- The parent's bend of 14 is repaired by the merge: memory scope uses resources only.
- The cost of the merge, a category being a resource it is odd to lease, sits within principle 8's text. Principle 8 lists memory scope and metric facets among what references a resource.
