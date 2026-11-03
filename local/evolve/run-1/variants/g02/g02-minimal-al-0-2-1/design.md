# harness-dsl: minimal, merged (child of g01-minimal-imal-0-2)

This child applies the **merge** operator. The parent had two entities that rhyme: a halt (a named question an attempt asks a human) and a rule policy (a named question an attempt asks a deterministic function). Both are "a question with a typed input and a typed answer, plus a resolver". They become one entity, the **decision**.

The child also repairs the adversary's three sharpest critiques. It answers the worst-handled scenario (4) and the owner-authored-recall scenario with small, named additions.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`; `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. Its type carries its position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others).onFailure(state, { afterAttempts })?` | A data shape, a set of states and an optional failure move. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **decision** | `H.decision(n).input(z).output(z).show(f)?.policy(f)?` | A named, typed question an attempt asks. A human resolves it unless its policy answers. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each carrying its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy).recall(policy)?` | role × model (× recall policy). |
| Pivot | **lane** | `H.lane(n, kind).handler(flow \| { [pendingState]: flow }, params?)...` | work kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store)` | memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, accountPolicy?)` | accounts × shares × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow**, **command**, **policy**, **operation** | as in the parent | |
| Root | **harness** | `H.harness(n)...start()` | The running thing. |

The following are plain values, not entities:

- `H.clock`, `H.operator`, `H.env`.
- `H.ask`: the sentinel a decision policy returns to defer to a human.
- `H.by.*`: metric dimensions.
- `TimeSpec`, `Scope`, `Bound`, `SupplyOf`.

## Execution vocabulary

- **Run**: one process lifetime.
- **Attempt**: one execution of one flow for one unit.
  - Its states are `running`, `blocked` (an open decision awaits a human) and `ended`.
  - When ended, its outcome is succeeded, failed or cancelled.
- **Invocation**: one call of one executable. A retry is a new invocation, and each batch item is its own invocation.
- **Decision**: one `ctx.decide`. It is recorded `raised` when it waits for a human and `resolved` when answered, with `resolvedBy: 'human' | 'policy'`.
- "Halt" is not a word in the API. A halt is a decision raised to a human; the attempt is blocked while it is open.
- "Step" is not a word in the API.

## The merge: decision = halt + rule policy

```ts
const approveReply = H.decision('approve-reply')
  .input(z.object({ category: z.string(), model: z.string(), reply: z.string() }))
  .output(z.object({ approved: z.boolean(), editedReply: z.string().optional() }))
  .show(i => i.reply)
  .policy((input, metrics, self) => isSafe(input.category, metrics, self) ? { approved: true } : H.ask);
```

**How it resolves:**

- With no policy, every decision goes to a human. This replaces `ctx.halt`.
- With a policy that never returns `H.ask`, the decision is a pure deterministic rule. This replaces `H.policy.rule`, for example scenario 8's experiment verdict.
- With a policy that sometimes asks, the decision is scenario 2's "human approves, except where the policy marks the category safe". That is now one line where it used to be two concepts plus an `if`.
- The policy receives `self`, so it can count its own history without a circular reference.

**One mechanism, one ledger entry.**

- `ctx.decide(decision, input)` returns `O`.
- It records a `decision` entry with the input, the output, the resolver, the metric reads and `waitedMs`.
- Restart replay treats it like any other recorded call.

**Typed metrics, which repairs critique (a):**

- `approveReply.resolved({ approved: true }, 'human')` builds the filter. Its match is type-checked against the output schema.
- `H.by.input(approveReply, 'category')` builds a grouping dimension. Its key is type-checked against the input schema.
- A typo is a compile error, not `samples: 0`.

**What the merge costs in honesty:**

1. **A human answer and a function's answer share an entity and an entry type.** A metric that forgets `by` mixes them.
   - An approval rate that counts policy auto-approvals measures the policy's own output and is self-confirming.
   - Mitigation: the second argument of `resolved(match, by)` exists for exactly this, and `H.by.resolver` splits any rate.
   - But the default (`by` omitted) counts both. The author must ask for honesty rather than get it free.
2. **Once a category is marked safe, it accrues no new human samples.** The "200 with zero rejections" evidence therefore freezes at the moment the policy starts answering. The parent had the same blind spot, but the merge makes it look like a single track record.
3. **A deterministic rule now records `waitedMs: 0` and appears in the decision log beside human waits.** Latency means differ by resolver, so `meanBy({ of: 'waitedMs', by: H.by.resolver })` is the honest read.
4. **Principle 4 is stretched in wording only.** The policy part of a decision is deterministic and authored once. The human part was never a policy. The entity is a question; it is not a policy.

## Rules

### 1. Skeleton (principle 12)

- **Positions and verdicts.** Units have four positions, and every terminal state declares a verdict. `State<N, P>` now carries its position in the type, so a kind knows its pending states statically (`Kind<T, S, Pd>`).
- **Attempt outcomes.**
  - A flow returning a state means the attempt succeeded and the unit moves.
  - `ctx.fail` or a throw means the attempt failed.
  - An interruption by a move, a preemption or a cost ceiling means the attempt was cancelled.
- **Failure default.** A failed attempt leaves the unit at the state it started from (pending). The kernel's retry is fixed:
  - Exponential backoff from 1 minute, capped at 1 hour, exposed as `UnitRecord.retryAt`.
  - The scheduler never sees the unit before then.
  - It is not configurable: no scenario needs to configure it (principle 21).
- **Failure move.** A kind may declare `onFailure(state, { afterAttempts })`. Only then does failure move the unit, after that many consecutive failed attempts.
  - This replaces the parent's `if (ctx.unit.failures >= 3) return 'abandoned'` in scenario 3, a branch on history the critique named.
  - `unit.failures` stays readable by schedulers.

### 2. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions. Neutral states are excluded.
- Every rate carries `hits` and `samples`, and `value` is `null` at 0 samples.

### 3. Re-entry without phase dispatch (repairs critique c)

A lane maps each **pending** state of its kind to the flow that runs from it:

```ts
H.lane('releases', Release).handler({ requested: releaseFlow, smoked: settleRelease })
```

- Each flow is a straight line. `until('awaiting-smoke', { children: true, then: 'smoked' })` parks the unit. The wake moves it to `smoked`, a pending state, and the lane starts `settleRelease`, which is a new attempt.
- No flow reads `ctx.unit.state` to decide where it is. The kind's states name the phases, and the lane routes them. Routing is declared, so it is not resumption code.
- The key type is `Pd`, the kind's pending names. An unmapped pending state is a startup error unless a single-flow `handler(flow)` covers all of them.

### 4. Moves, supply, keys

These are unchanged from the parent:

- A move with a live attempt cancels the attempt first.
- A `create` on an open key is ignored.
- `update` addresses the open unit with that key.
- The ledger snapshots unit data on every transition (`TransitionEntry.data`). So storeless kinds have data, and `H.by.data(kind, key)` can group by it.

### 5. Triggers

**Sources:**

- `on.enters`, `on.streak` and `on.deadline`. The deadline is re-evaluated on every data update.
- `on.metric(read → Rate)` is a **single** latch, with no group. This repairs critique (b): the lane-wide error-rate trigger no longer invents a group key.
- `on.metricBy(read → Record<group, Rate>)` gives one latch per group. Its event's `group` is non-optional, by overload.

**Effects:** `create`, `move`, `remember`, `pause(lane)`, `resume(lane)`.

**Records and references:**

- Firings are `firing` entries with reads. Pause and resume are `lane` entries with reads and the paused `durationMs`.
- Filters take entity references (`lane: conversations`, `trigger: approvalAudit`, `kind: Audit`), never strings.
- Where a reference would be circular (an audit flow that counts the audits its own trigger opens), the author counts the units instead. `{ entry: 'transition', kind: Audit, state: Open }` grouped by `H.by.data(Audit, 'category')` is the honest count of openings.

### 6. Scheduler

- One scheduler policy returns `start` and optionally `preempt`.
- `SchedulerView.runners` exposes slots and used slots, and `ActiveView.runners` exposes what each attempt holds.
  - So "Incidents preempt everything" preempts only when an Incident's runner is actually full.
  - This answers the scenario-4 critique that preemption freed nothing.
- Blocked attempts release runner slots but count toward lane WIP. Waiting units count toward nothing.

### 7. Placement

- `Command.on(...runners)` names the runners a command may run on. The kernel picks the least-used runner whose `preflight()` passes, respecting slots.
- "Backups run on these SSH hosts, one at a time each" is now one line on the command plus `slots: 1` on each host.
- Kind data carries no host (principle 10), and there are no per-host command factories.
- If the owner's domain genuinely ties a database to a host, that is domain data. It goes in the argv, not in placement.

### 8. Cost

`maxUsdPerUnit` is cumulative. An invocation that would pass it raises the kernel decision `cost-ceiling`.

### 9. Accounts and quota (principle 15, shared-quota ruling)

- **Shared quota.**
  - Quota is ledger state.
  - `sqlite.ledger(path, { sharedQuota })` places quota events in a shared partition, keyed by account and tagged by harness.
  - Usage and cooldowns are **append-only events**. `recordCooldown` now carries the harness.
  - Each harness folds the window at read time and takes no lock on the shared partition. The single-writer lease covers only the harness's own partition.
- **Shares** belong to pools, so to one harness.

### 10. Memory (principle 14)

- The kernel owns the envelope, and `MemoryItem.sort` is now on the item.
- Candidates are never recalled until accepted.
- **Recall is a deterministic policy:**
  - `H.policy.recall(name, view => items)` attached with `Agent.recall(policy)`.
  - Its view carries the items (with `trackRecord`, `similarity` and `specificity`), the scope, `now` and `metrics`.
  - Without one, the kernel default ranks by similarity, then specificity, then track record.
- Two agents sharing a library can therefore rank, decay, exclude and cap differently.
- Each recall is a `policy` entry whose `excluded` list carries the track record of every item left out.
- Reads union across `recalls`. Writes go to the one `records` library, and trigger `remember` names its library.

### 11. Durability (scenario 10)

**Replay.**

- Every `run`, `batch`, `decide`, `move`, `update`, `remember` and `spawn` is a sequenced ledger entry.
- On restart the flow is re-executed against recorded results. Completed calls are not invoked and cost nothing.

**The invocation running at the crash** follows the executable's `recovery`, set on commands with `.recover(...)`:

- `'rerun'`
- `'park'` (the command default), which raises the kernel decision `interrupted`.
- A check command, where `true` means the effect happened.
- `'driver'` (the agent default), which asks `Model.recover`. An `unknown` answer parks.

There is one word, *recover*, for the setting and for the driver's method. `recovery` is the field that holds it. The parent's second word is gone, which answers the critique's principle-22 point.

**Things that moved while the harness was down:**

- **Batches** record their handle before waiting, and are collected, not resubmitted.
- **Decisions resolved while down** are `operation: requested` entries applied on start.
- **Children** are found by their recorded positions.
- **Resumed attempts** keep their id. The crash is `attempt: interrupted`, and interrupted invocations are excluded from model and agent rates.

**A flow that changed:**

- A fingerprint mismatch raises the kernel decision `definition-changed`.
- The supervisor answers `restart` or `abandon` through `resolveDecisions`.

**Single writer:** a ledger lease, with takeover after expiry recorded as `run: took-over`.

### 12. Control API

- The API is made of operations, and clients are granted operations.
- `resolveHalts` is renamed `resolveDecisions`. The API's halt list becomes `decisions.list` and `decisions.resolve`.

### 13. Observers

- Observers remain instances (board, telemetry, slack).
- `slack.notify({ among: EntryFilter, message })` filters by entity reference (`kind: Incident`), not by comparing strings.

### 14. Startup validation

`start()` fails on each parent case, and on these new ones:

- an unmapped pending state in a lane's handler map;
- a `onFailure` state not in the kind;
- a `by.input` dimension whose decision is never decided in any flow.

## Scenario-level answers to the critique

- **Scenario 4, unresolved Incident.**
  - The Incident flow is: decision `acknowledge` → runbook → decision `confirm-resolution`.
  - Unresolved returns `unresolved`, a pending state that the lane maps to a `follow-up` flow (runbook again, then confirm).
  - It does not re-enter at `open` and re-page.
- **Scenarios 2 and 9, lifecycles.** They are the same domain and will declare the same Conversation lifecycle: `sent` is terminal/success, `escalated` is terminal/failure, `closed` is terminal/neutral. Scenario files cannot import each other, so the definitions are repeated identically.
- **Scenario 6, model policy and agent names.** Each reviewer gets its own model policy, reading one shared lineup function, so no policy compares agent names.

## What changed and why

| Change | Why |
|---|---|
| **Merged** `ctx.halt` + `H.policy.rule` → `H.decision` (with `H.ask`, `ctx.decide`) | Operator. Halts become typed entities (critique a). Scenario 2's safe-category gate becomes the decision's policy. |
| `EntryFilter` takes entity refs (`KindRef`, `LaneRef`, `TriggerRef`, `DecisionRef`, `ExecutableRef`, `State`) | Critique a: raw strings removed. |
| `ctx.tag`, `EntryBase.tags`, `byTag` removed; `rateBy({ by: Dimension })` with `H.by.model(agent?)`, `H.by.input(decision, key)`, `H.by.data(kind, key)`, `H.by.resolver`, `H.by.group` | Typed grouping. Approval-by-model groups by the decision's input; citation-pass-by-synthesizer groups by `H.by.model(synthesizer)`. |
| `Metrics.meanBy`, `Measure 'waitedMs'` | Decision latency per resolver, with samples. |
| `on.metric` split into `metric` (single) and `metricBy` (grouped) | Critique b. |
| Lane handler map keyed by pending state; `State<N, P>`, `Kind<T, S, Pd>` | Critique c: no phase dispatch in flows. |
| `Kind.onFailure(state, { afterAttempts })` | Principle 12's failure move. Removes the `failures` branch. |
| `H.policy.recall`, `Agent.recall`, `PolicyEntry.excluded`, `MemoryItem.sort` | Principle 14 ("recall is a deterministic policy") was weakened by the parent's fixed ranking. This answers the adversary's legal-review scenario. |
| `Command.on(...runners)`, `Runner.preflight`, `SchedulerView.runners`, `ActiveView.runners` | Scenario 4 placement and honest preemption. |
| `Command.recovery(r)` → `.recover(r)`; `Executable.recover()` removed, replaced by a `recovery` field with `'driver'` | One word for recovery. Verbs for settings. |
| `DecisionEntry` (the policy-read entry) renamed `PolicyEntry`; the new `DecisionEntry` replaces `HaltEntry` | The merge. |
| `ops.resolveHalts` → `ops.resolveDecisions`; `ControlApi.halts` → `decisions` | The merge. |
| `recordCooldown(account, harness, until)` | Shared-quota ruling: append-only events attributable per harness. |
| `slack.notify({ among })` | Typed observer filter. |
| `Supplier`, `Store`, `Ledger` lease, durability rules | Unchanged. |

**Considered and rejected for the merge:** lane + library. Both are "a kind × a store × a behaviour", but a queue of units with lifecycles and a set of recallable items share no operations. Merging them would have forced memory items to have positions, or units to have similarity. That cost is a lie, not a little honesty.

## Principles broken

None.

- Principle 4 is respected: the policy half of a decision is deterministic and never self-modifying; the human half is not a policy and is not called one.
- Principle 12's "lane's retry policy" is a fixed kernel default rather than a configurable lane method. A configurable method is not added because no battery scenario calls it (principle 21). If the owner reads principle 12 as requiring configurability, this is a break of 12, made in favour of 21.
