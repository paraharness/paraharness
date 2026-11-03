# harness-dsl: minimal, renamed (child of g02-minimal-0-2-2--2-2-1-2)

The operator is **rename**. The weakest noun in the parent was **library**.

- A library is where you borrow books. It says nothing about recall, which is the whole reason the pivot exists.
- Principle 8 already names this pivot: *journal = memory kind × store × recall*.
- The parent's library was also missing the third factor. The adversary's sharpest critique 3 was that recall had moved into the backend.

So the rename and the repair are one change:

- `H.library` becomes `H.journal`.
- The journal regains its recall policy: `H.journal(n, memory, store).recall(policy)`.

This child also repairs the parent's other two sharpest critiques:

- **Dead-end exhaustion states.** The bound leaves the handler options, and exhaustion is typed to the kind's terminal states.
- **Human "no" routed through `ctx.fail`.** This is now a stated rule.

It also fixes the scenario 9 defects the adversary listed: the stale SLA deadline, the audit count, and the deferred patch.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, 'pending' \| 'waiting')` or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position, typed by position. No state can claim `active` (principle 12). |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and its states. The type carries the names of its terminal states. The initial state must be pending. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about(z).timeout(after, resolve).policy(rule)` | A named outside decision. |
| Kind | **resource** | `H.resource(n)` | A named shared thing. |
| Kind | **facet** | `H.facet(n, valuesSchema)` | A declared metric dimension and memory-scope axis. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | A specific thing with its backend. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy)` | Role × model, chosen at attempt time. An agent is a seat given one model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow, params?).retry({ times, backoff?, exhausted, reopenAfter? })` | Kind × suppliers × store × handler, with the retry policy that principle 12 places on the lane. Optional settings: `.suppliers() .store() .wip() .maxUsdPerUnit() .locks(f) .sequence(f, parked) .facet(facet, read)`. |
| Pivot | **journal** | `H.journal(n, memory, store).recall(policy?)` | Memory kind × store × recall: what a seat remembers and how it is chosen. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | Accounts × policy: the account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | flow, command, job, policy, operation, harness | | |

Kernel halts: `H.halts.interrupted`, `definitionChanged`, `costCeiling`. All three take the decision `{ action: 'restart' | 'continue' | 'abandon' }`.

## Execution vocabulary (principle 22)

| Word | One meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. Status: `running`, `blocked` (on a halt), `suspended` (on a timer, children, a job, a batch or a lease), or `ended` with outcome `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable. Each batch item and each command retry is its own invocation. |
| **Position** | `pending`, `active`, `waiting` or `terminal`. |
| **Retry** | A lane retries attempts (`lane.retry`). A command retries invocations (`command.retries`). |
| **Journal** | Where memory of one kind lives and how it is recalled. (The parent's "library".) |
| **Recall** | The deterministic choice of memory items for one invocation of one seat, made by the journal's recall policy. |

## Rules

### 1. Skeleton, outcomes and retry (principle 12)

**Position derivation** is unchanged from the parent:

| Condition | Position |
|---|---|
| A running attempt | `active` |
| A blocked or suspended attempt | `waiting` |
| No live attempt | The position its state declares |

**What an attempt outcome means.** An attempt outcome is the harness's track record of *execution*: did the executables do their work? It says nothing about the unit's verdict.

| Outcome | How it happens |
|---|---|
| `succeeded` | The flow returns any state of the kind. |
| `failed` | The flow returns `ctx.fail`, or throws. |
| `cancelled` | An outside move, a supply re-entry, or a preemption. |

**A human "no" is a state, never `ctx.fail`.** This is the repair of critique 2.

- `ctx.fail` is reserved for an executable that did not do its work: a non-zero exit, a model error, a remote job failure.
- A rejection, an unresolved incident, or a returned contract is a decision. The flow returns a state that says so. Examples:
  - a terminal state such as `rejected` or `unresolved`, with the verdict the kind declares;
  - a pending state such as `drafting`, which ends the attempt `succeeded` and requeues the unit for a fresh attempt.
- A rejection therefore never consumes lane retries and never re-pages anyone.
- It never lands in a model's or seat's failure count. Those count failed invocations and failed attempts only.
- The kind's outcome rate still records it, through the terminal state's verdict.
- Loops through a pending state are bounded where needed by `H.on.enters(kind, state, { times })`, as in scenario 11.

**Retry is its own lane setting** (critique 1). `handler(flow, params?)` takes only the flow and its parameters. `.retry({ times, backoff?, exhausted, reopenAfter? })` is a separate, required step: `LaneHandled` has only `retry`, and only a `Lane` can be registered. So the bound and its end state are always declared, and declared on the lane, as principle 12 says. The `exhausted` field takes one of two forms.

**Form 1: a terminal state.** The type is the kind's terminal names (`TerminalOf<...>`, inferred from the states' positions). Writing `exhausted: 'analysis-stalled'` for a waiting state is a type error. This is what kills the parent's invented parking lots: `analysis-stalled`, `review-stalled`, `negotiation-stalled` and `audit-stalled`. The author must instead name the honest end, such as `failed`, `unhandled` or `analysis-failed`, with its verdict.

**Form 2: a non-terminal state with `reopenAfter`.** This form exists for kinds that are never terminal on failure, such as scenario 8's Tenancy.

- The kernel records `exhausted`, then moves the unit to that state.
- After the interval, the kernel moves it back to the kind's initial state. This is a `transition` with status `reopened` and cause `kernel`.
- A non-terminal exhaustion state therefore always has a recorded exit.
- `start()` rejects form 2 when the named state is not `waiting`.

`times: 0` means "do not retry; a failed attempt goes straight to `exhausted`". That is honest for a heartbeat, where `unhealthy` is the real outcome.

**Return bounds.** `H.on.enters(kind, state, { times })` is evaluated inside the transaction that records the transition. The unit becomes schedulable only after commit. This is unchanged from the parent.

### 2. Supply, patches and outside moves

**Create.** A `create` whose key belongs to a unit that is not terminal is deduped. Inside a trigger, the effect is recorded as `{ result: 'deduped' }` on the firing. A key whose latest unit is terminal creates a new unit.

**Every data change is recorded at once** as a `patch` entry:

| Status | Meaning |
|---|---|
| `applied` | The patch is in the unit's data. |
| `deferred` | Recorded now, merged when the live attempt ends. |
| `merged` | A deferred patch that has now been applied. |

**What happens to an `update`:**

| Source and target | Patch | `state` given |
|---|---|---|
| Supplier update to a unit with a running attempt | Deferred | Deferred |
| Supplier update to a unit at `waiting` (attempt blocked or suspended) | Applied | Cancels the attempt (cause `supply`), then moves the unit |
| Operation update (control API) | Applied at once, to any position | |

The flow keeps reading the data its attempt started with, plus its own `ctx.update`s. At attempt end, fields the flow wrote win over a concurrent operation patch only on those fields.

**Deadlines read recorded data, including deferred patches.** `H.on.deadline` re-arms on every `patch` entry of a unit:

- It records a `firing` with status `armed` and the new `due`.
- It supersedes the previous arming, which is recorded `disarmed`.
- A disarmed deadline never fires.

This repairs scenario 9. The reviewer's SLA extension through `writeWork` moves the breach timer the moment it is recorded, even while a draft is running.

### 3. Journals and recall (principles 8, 14, 4, 5)

**What recall does.** Before each invocation of a seat, for each journal the seat `recalls`, the kernel takes these steps:

1. It asks the journal's store for `candidates({ journal, scope, text, limit })`. The scope comes from the seat's role, the unit's kind, current facet values and leased resources. The text is the rendered prompt.
2. The store returns items, and **may** return a `similarity` number. A vector backend computes it; a JSONL store returns `null`.
3. The kernel annotates each candidate:
   - `specificity`: how many scope axes it matches;
   - `track`: a `Rate` of the succeeded attempts among the attempts whose invocations included this item.
4. The journal's **recall policy**, a deterministic `H.policy.recall(name, view => items)`, chooses and orders the items.
5. The kernel records the choice on the invocation (`memoryIds`) and in a `decision` entry with the reads it used.

**Default and override.** A journal with no `.recall(...)` uses the kernel's built-in policy:

- accepted items only;
- ranked by specificity, then by track value with samples breaking ties;
- cut at the limit.

Scenario 3 passes `.recall(H.policy.recall('by-similarity', view => ...))` and ranks by `similarity` inside a policy it authored.

**Who decides.** The store measures; it never ranks or filters by relevance. Any store-side cut is only the candidate `limit`, which the policy sees. The policy decides. Principle 4 (intelligence in deterministic policies) and principle 5 (indifferent to backend) both hold again.

**Candidates.** A candidate item (`status: 'candidate'`) is never recalled by the default policy. It becomes recallable through `accept` or `merge` on the control API.

### 4. Facets

`lane.facet(facet, data => value)` stamps every entry about the unit with the facet value current at that entry, including patches and firings. A grouped metric trigger stamps its group on its firing.

To count "Audits opened per category", count creation transitions: `count({ of: { entry: 'transition', kind: audit, status: 'created', facets: [...] } })`. Trips whose create was deduped are not creations, so the parent's ambiguity between `tripped` and `deduped` is gone.

### 5. Locks, ordering, halts, jobs, cost, quota, durability

These rules are unchanged from the parent.

- **Locks.** Locks are lane-scoped: `lane.locks(data => Lock[])`, held for the whole attempt. Exclusive excludes everything on the resource; shared excludes only exclusive.
  - The adversary's release train needs a lock for one step of a long attempt. It is not in the battery. Principle 21 removes methods nobody in the battery calls, so `Command.locks` stays cut.
  - If the train joins the battery, the honest answer is a step-scoped lock on the command. Splitting the unit into two kinds is not.
- **Ordering.** `lane.sequence(order, parked)` parks a unit behind a lower-ordered unit that did not succeed, with a reason naming the blocker.
- **Halts.** Human resolvers act through grants that name the halt (`H.ops.resolve(...halts)`). Policy resolvers record their reads and sample counts. Clock resolvers (`.timeout`) count from the recorded raise and do not cancel the attempt. Escalation uses `H.on.halted(halt, after)`.
- **Jobs.** A job submits, suspends, polls, and is collected on restart, never resubmitted. A batch uses the model's `submit` and `collect` and is priced at the batch discount.
- **Cost.** `maxUsdPerUnit` is cumulative across a unit's attempts. A unit that would pass it blocks on `costCeiling`.
- **Quota.** `account.quota` names a quota partition. With none, the account uses the ledger's own partition.
- **Replay.** On restart the kernel replays by invocation sequence and applies `.recovery` per command. An attempt whose flow fingerprint changed is parked on `definitionChanged`.
- **Single writer.** `claimWriter` lets a second copy take over only from a dead first copy, and refuses it otherwise.

### 6. Startup validation

`start()` fails, naming the offender, on each of these.

**Names**

- duplicate descriptor names, across every sort;
- a facet named like a column (`kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`, `resolver`).

**References**

- a trigger or spawn that targets a lane that is not registered;
- a facet read by a policy or filter that no registered lane declares.

**States and retry**

- a flow state that is not a state of the lane's kind;
- a `retry.exhausted` with `reopenAfter` that is not a waiting state;
- a `sequence` parked state that is not waiting;
- a `suspend` target that is not waiting.

**Seats, models and journals**

- a seat model or policy candidate that no pool can serve;
- a batch on a model without `submit` and `collect`;
- a journal recalled or recorded by a seat that is not registered through a lane's flow.

**Executables and halts**

- a command without argv;
- a command without runners, unless it is a preflight;
- a halt whose `.timeout` or `.policy` reads `about` when no `.about` is declared;
- a halt referenced in a flow that no client can resolve and that has no timeout or policy.

**Harness**

- a missing ledger.

A harness with no pools, seats or models is valid. A lane with no `retry` cannot be constructed, so it needs no check.

## What changed and why

| Change | Reason |
|---|---|
| `H.library` renamed `H.journal`; `Journal.recall(policy)` added; `H.policy.recall`, `RecallView`, `RecallCandidate` added; `MemoryStore.search` becomes `candidates`, which returns `similarity \| null` and never ranks | Operator: the weakest noun. Principle 8 names this pivot *journal* and gives it a recall factor. Repairs critique 3: recall is a deterministic, recorded policy again, not a backend's ranking. |
| `MemoryItem.library` becomes `journal`; control API `memory.list(journal)` | Follows the rename. |
| `handler(flow, { retries, backoff, exhausted, params })` split into `handler(flow, params?)` and a required `.retry({ times, backoff?, exhausted, reopenAfter? })` | Critique 1 and known weakness 6: the handler options no longer carry three concerns. |
| `exhausted` typed to the kind's terminal states; `reopenAfter` gives a non-terminal exhaustion a recorded exit | Critique 1: dead-end parking states can no longer be written. |
| `State<N, P>` carries its position; `Kind<T, S, E>` carries its terminal names; `H.state` no longer accepts `'active'` | Makes the line above typeable. Principle 12: kinds declare no active states. |
| Rule: a decision is a state, `ctx.fail` is only execution failure | Critique 2: rejections no longer retry, re-page, or pollute model and seat track records. |
| `patch` entries; operation patches applied at once; deadlines re-arm on every patch (`armed` / `disarmed` firings) | Scenario 9: the old SLA deadline never fires. |
| `FiringEntry.effects` becomes `EffectRecord[]` with `applied \| deduped`; `TransitionEntry.status` `created \| moved \| reopened` | Scenario 9: audits opened are countable without ambiguity. |
| `Interval.days` | Needed by `reopenAfter` for monthly kinds. |

**Net surface.**

- Renamed: library → journal; `search` → `candidates`.
- Added: `Journal.recall`, `H.policy.recall`, `LaneHandled.retry`, two entry fields, `PatchEntry`.
- Removed: the `HandlerOptions` and `RetryOptions` types, the `deduped` firing status, and the `active` overload of `H.state`.

### Weaknesses left open

- **Scenario 6's editorial decision schema names the reviewers.** The schema uses `actedOnA` and `actedOnB`. A decision field keyed by seat identity would be a new noun the battery does not otherwise need. The scenario file will key the actions by seat name inside the decision, and the policies will compare both seats with `rateBy(... modelOf)`, not against an unkeyed rate.
- **Two gates of one halt in one flow** (known weakness 3). Still distinguished only by sequence.
- **Batch and job** remain two forms.

## Principles broken

None.

The parent's implicit break of principles 4 and 5, where recall ranking lived in the memory store, is repaired by the journal's recall policy.
