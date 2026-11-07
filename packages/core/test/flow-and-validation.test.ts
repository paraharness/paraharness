import { describe, expect, it } from 'vitest';
import {
  BudgetApprovalSchema, type GitAbortMeta, type GitScopeReceipt, type GitWorktreeHandle, H,
  type LaneBuilder, type LeaseDelta, type LoopBuilder, SpeculationInputSchema,
  type UniversalStepTelemetry, z,
} from '../src/index.js';
import {
  SAMPLE_ABORT_HOOK_NODE, SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE, SAMPLE_CROSS_REPORT_SCHEMA,
  SAMPLE_CROSS_VERIFIER_NODE, SAMPLE_DECLARED_TOOL_NODE, SAMPLE_EXTRA_COMPARE_TOOL_NODE,
  SAMPLE_GUARD_NODE, SAMPLE_LEDGER_NODE, SAMPLE_MODEL_NODE, SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE,
  SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE, SAMPLE_RUNNER_NODE, SAMPLE_SCOPE_RECEIPT_SCHEMA,
  SAMPLE_TELEMETRY_COLLECTOR_NODE, SAMPLE_TIER1_SCOPE_NODE, SAMPLE_TIER2_SCOPE_NODE,
  SAMPLE_TIER3_SCOPE_NODE, SAMPLE_TRACKER_NODE,
} from './fixtures/sample-domain-nodes.constants.js';

const FlowInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(['fast', 'deep']).default('fast'),
  retryReason: z.string().optional(),
});
const StepOutputSchema = z.object({ prUrl: z.string(), commits: z.number().default(1) });
const LeaseRequestInterrupt = H.interrupt('lease-req').payload(z.object({ partition: z.string(), glob: z.string() }));
const EscalationInterrupt = H.interrupt('normative-esc').payload(z.object({ question: z.string() }));
const RewindSignal = H.signal('ci-failed').payload(z.object({ runId: z.string(), failureLog: z.string() }));

describe('H.flow, H.lane, and H.harness end-to-end compilation and generic inference', () => {
  it('propagates TReceipt, TCustomMetrics, TAbortMeta, and TStepOutputs across H.flow, H.lane, and H.harness', () => {
    const bidirectionalHuman = H.human('tech-lead').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const budgetHuman = bidirectionalHuman.withName('budget-owner').output(BudgetApprovalSchema);
    const baseWorker = H.agent<GitWorktreeHandle>('worker')
      .model(SAMPLE_MODEL_NODE)
      .tools(SAMPLE_DECLARED_TOOL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema);
    const adjudicator = H.agent<GitWorktreeHandle>('lease-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ partition: z.string(), glob: z.string() }))
      .output(z.object({ grant: z.boolean(), rationale: z.string() }));
    const arbiterVerdictSchema = z.object({
      action: z.enum(['winner', 'unpark', 'reject']),
      branchIndex: z.number().default(0),
      rationale: z.string().default('ok'),
      needsRefinement: z.boolean().default(false),
    });
    const arbiterInputSchema = SpeculationInputSchema(
      FlowInputSchema,
      StepOutputSchema,
      SAMPLE_SCOPE_RECEIPT_SCHEMA,
      SAMPLE_CROSS_REPORT_SCHEMA,
    );
    const arbiterAgent = H.agent<GitWorktreeHandle>('arbiter')
      .model(SAMPLE_MODEL_NODE)
      .input(arbiterInputSchema)
      .output(arbiterVerdictSchema);

    const orchestrator = H.agent<GitWorktreeHandle>('orchestrator')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema)
      .canRaise(LeaseRequestInterrupt, EscalationInterrupt)
      .capabilities(($cap) =>
        $cap
          .fork('delegateSubtask', baseWorker, ($f) =>
            $f
              .historyMode('shared-prefix-only')
              .requestSchema(z.object({ subTitle: z.string() }))
              .mapInput((parentIn: z.output<typeof FlowInputSchema>, req: { readonly subTitle: string }) => ({
                ...parentIn,
                title: req.subTitle,
              }))
              .modelRouting(($m) =>
                $m
                  .inheritParentWithEffort('high', {
                    when: (parentIn: z.output<typeof FlowInputSchema>) => parentIn.mode === 'deep',
                  })
                  .otherwisePool(SAMPLE_MODEL_NODE),
              ),
          )
          .speculate('raceCandidates', ($s) =>
            $s
              .requestSchema(z.object({ strategies: z.array(z.string()) }))
              .worker(baseWorker)
              .branches(2, (parentIn: z.output<typeof FlowInputSchema>, req: { readonly strategies: string[] }) =>
                req.strategies.map((s: string) => ({ ...parentIn, title: `${parentIn.title}:${s}` })),
              )
              .crossVerifyWith(SAMPLE_CROSS_VERIFIER_NODE)
              .arbiter(arbiterAgent, {
                resolveDecision: (verdict: z.output<typeof arbiterVerdictSchema>) =>
                  verdict.action === 'winner'
                    ? { decision: 'select-winner', winnerBranchIndex: verdict.branchIndex }
                    : { decision: 'reject-all', rationale: verdict.rationale },
              })
              .refineWinnerWhen(
                (verdict: z.output<typeof arbiterVerdictSchema>) => verdict.needsRefinement,
                baseWorker,
                (
                  parentIn: z.output<typeof FlowInputSchema>,
                  verdict: z.output<typeof arbiterVerdictSchema>,
                  candidates: ReadonlyArray<z.output<typeof arbiterInputSchema>['candidates'][number]>,
                ) => ({ ...parentIn, title: `${parentIn.title}:refined:${candidates.length}:${verdict.rationale}` }),
              ),
          )
          .mutatePlan(($m) =>
            $m
              .canSpawnTasks(FlowInputSchema, {
                maxSpawnedPerRun: 3,
                onPrerequisiteSpawned: 'suspend-and-yield-slot',
                resumeWhen: 'prerequisite-exit',
              })
              .canAddDependencies(),
          )
          .escalate(EscalationInterrupt, ($esc) =>
            $esc
              .to(bidirectionalHuman)
              .response(z.object({ guidance: z.string(), grantWrite: z.boolean().default(false) }))
              .elevateLeaseWhen(
                (d: { readonly guidance: string; readonly grantWrite: boolean }) => d.grantWrite,
                (): LeaseDelta => ({ type: 'harness:lease-delta', id: 'grant-api', grantedMatchers: [] }),
              ),
          ),
      )
      .onChildInterrupt(EscalationInterrupt, ($ci) =>
        $ci.pauseSiblingForksInPartitions(() => ['db']).suspendAndReturnToParent(),
      );

    const flow = H.flow('engineering-flow')
      .input(FlowInputSchema)
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .telemetry(SAMPLE_TELEMETRY_COLLECTOR_NODE)
      .branch('execute-work', ($b) =>
        $b
          .output(StepOutputSchema)
          .when(
            (input: z.output<typeof FlowInputSchema>) => input.mode === 'deep',
            ($sub) =>
              $sub.step('deep-orchestrator', orchestrator, ($s) =>
                $s
                  .onInterrupt(LeaseRequestInterrupt, ($i) =>
                    $i
                      .adjudicateWith(
                        adjudicator,
                        (_in: z.output<typeof FlowInputSchema>, payload: { readonly partition: string; readonly glob: string }) => payload,
                      )
                      .elevateLeaseWhen(
                        (
                          _in: z.output<typeof FlowInputSchema>,
                          _p: { readonly partition: string; readonly glob: string },
                          verdict: { readonly grant: boolean; readonly rationale: string },
                        ) => verdict.grant,
                        (): LeaseDelta => ({ type: 'harness:lease-delta', id: 'grant-partition', grantedMatchers: [] }),
                      )
                      .resumeWith(
                        (
                          _in: z.output<typeof FlowInputSchema>,
                          _p: { readonly partition: string; readonly glob: string },
                          verdict: { readonly grant: boolean; readonly rationale: string },
                        ) => verdict.rationale,
                      ),
                  )
                  .onInterrupt(EscalationInterrupt, ($i) =>
                    $i.onAbort(SAMPLE_ABORT_HOOK_NODE).replaceWith(
                      baseWorker,
                      (
                        flowIn: z.output<typeof FlowInputSchema>,
                        payload: { readonly question: string },
                        telemetry: UniversalStepTelemetry<
                          { readonly filesRead: readonly string[]; readonly filesMutated: readonly string[] },
                          GitAbortMeta
                        >,
                      ) => ({
                        ...flowIn,
                        retryReason: `${payload.question}:${telemetry.custom.filesRead.length}:${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                      }),
                    ),
                  ),
              ),
          )
          .otherwise(($sub) => $sub.step('fast-worker', baseWorker)),
      )
      .step('finalize', baseWorker, ($s) =>
        $s.inputFrom(
          (
            flowIn: z.output<typeof FlowInputSchema>,
            steps: Readonly<{ 'execute-work': z.output<typeof StepOutputSchema> }>,
            receipt: GitScopeReceipt,
          ) => ({ ...flowIn, title: `${flowIn.title}:${steps['execute-work'].prUrl}:${receipt.baseBranch}` }),
        ),
      )
      .exit('pr-opened');

    const lane = H.lane('default-lane')
      .input(FlowInputSchema)
      .key((item: z.output<typeof FlowInputSchema>) => item.id)
      .tracker(SAMPLE_TRACKER_NODE, ($t) =>
        $t
          .everySeconds(15)
          .from((issue: { readonly id: string; readonly title: string; readonly ready: boolean }) =>
            issue.ready ? { id: issue.id, title: issue.title, mode: 'fast' as const } : undefined,
          )
          .onQueued('queued')
          .onRunning('in-progress')
          .onWaiting('needs-human')
          .onErrored('errored')
          .onCancelled('cancelled')
          .onExit('pr-opened', 'pr-open'),
      )
      .concurrency(4)
      .priority('high')
      .agingMinutes(30)
      .waitFor(() => [], 'abandoned')
      .maxCostUsd(25, budgetHuman)
      .retry(($r) => $r.tries(3).exponential(1000).orFail('abandoned'))
      .runs(flow)
      .onSignal(RewindSignal, ($sig) =>
        $sig
          .update((current: z.output<typeof FlowInputSchema>, payload: { readonly runId: string; readonly failureLog: string }) => ({
            ...current,
            retryReason: payload.failureLog,
          }))
          .rewindTo('execute-work'),
      );

    const harnessNode = H.harness('meta-harness').ledger(SAMPLE_LEDGER_NODE).pools(SAMPLE_RUNNER_NODE).lanes(lane).toAST();
    expect(Object.isFrozen(harnessNode)).toBe(true);
    expect(harnessNode.lanes[0]?.tracker?.stateMappings).toEqual({
      queued: 'queued',
      running: 'in-progress',
      waiting: 'needs-human',
      errored: 'errored',
      cancelled: 'cancelled',
      'exit:pr-opened': 'pr-open',
    });
  });
});

describe('Static build-time validation rejections', () => {
  const SimpleSchema = z.object({ id: z.string() });
  const SimpleAgent = H.agent('simple-agent').model(SAMPLE_MODEL_NODE).input(SimpleSchema).output(SimpleSchema);

  it('rejects .fork(), .speculate(), and .mutatePlan() on Tier-1 or Tier-2 non-branchable scopes', () => {
    const forkingAgent = SimpleAgent.capabilities(($c) =>
      $c.fork('childFork', SimpleAgent, ($f) =>
        $f.requestSchema(SimpleSchema).mapInput((_p: { readonly id: string }, r: { readonly id: string }) => r),
      ),
    );
    const speculatingAgent = SimpleAgent.capabilities(($c) =>
      $c.speculate('raceChild', ($s) =>
        $s
          .requestSchema(SimpleSchema)
          .worker(SimpleAgent)
          .branches(2, (p: { readonly id: string }) => [p, p])
          .arbiter(SimpleAgent, { resolveDecision: () => ({ decision: 'select-winner', winnerBranchIndex: 0 }) }),
      ),
    );
    const mutatingAgent = SimpleAgent.capabilities(($c) =>
      $c.mutatePlan(($m) => $m.canSpawnTasks(SimpleSchema, { maxSpawnedPerRun: 2 })),
    );

    for (const actor of [forkingAgent, speculatingAgent, mutatingAgent]) {
      expect(() =>
        H.flow('tier1-branch-flow').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).step('run', actor).exit('done').toAST(),
      ).toThrowError(
        "Flow 'tier1-branch-flow' scope 'sample:tier1-scope' has capabilityTier 'scope', but actor 'simple-agent' declares branching capabilities (.fork, .speculate, or .mutatePlan) requiring capabilityTier 'branchable'.",
      );
      expect(() =>
        H.flow('tier2-branch-flow').input(SimpleSchema).scope(SAMPLE_TIER2_SCOPE_NODE).step('run', actor).exit('done').toAST(),
      ).toThrowError(
        "Flow 'tier2-branch-flow' scope 'sample:tier2-scope' has capabilityTier 'checkpointable', but actor 'simple-agent' declares branching capabilities (.fork, .speculate, or .mutatePlan) requiring capabilityTier 'branchable'.",
      );
    }
  });

  it('rejects subprocess-post-flight tools under policy guards and unhooked .replaceWith() on Tier-1 scopes', () => {
    const guardedPolicy = H.policy<GitWorktreeHandle>('guarded').guard(SAMPLE_GUARD_NODE).onViolation('deny-with-error');
    const postFlightAgent = H.agent<GitWorktreeHandle>('post-flight-agent')
      .model(SAMPLE_MODEL_NODE)
      .policy(guardedPolicy)
      .tools(SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE)
      .input(SimpleSchema)
      .output(SimpleSchema);

    expect(() =>
      H.flow('tier1-postflight-flow').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).step('run', postFlightAgent).exit('done').toAST(),
    ).toThrowError(
      "Flow 'tier1-postflight-flow' scope 'sample:tier1-scope' has capabilityTier 'scope', but actor 'post-flight-agent' mounts subprocess-post-flight tool 'shell_exec' under policy 'guarded' requiring capabilityTier 'checkpointable' or 'branchable'.",
    );
    expect(() =>
      H.flow('tier1-replace-flow')
        .input(SimpleSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .step('run', SimpleAgent, ($s) =>
          $s.onInterrupt(EscalationInterrupt, ($i) => $i.replaceWith(SimpleAgent, (flowIn: { readonly id: string }) => flowIn)),
        )
        .exit('done')
        .toAST(),
    ).toThrowError(
      "Flow 'tier1-replace-flow' step 'run' configures .replaceWith() on interrupt 'normative-esc' without .onAbort() on a Tier-1 'scope' (sample:tier1-scope); bind .onAbort() or use a 'checkpointable' or 'branchable' scope.",
    );

    const abortHookPolicy = H.policy('adj-abort-policy').onAbort(SAMPLE_ABORT_HOOK_NODE);
    const hookedAdjudicator = H.agent('hooked-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .policy(abortHookPolicy)
      .input(z.object({ question: z.string() }))
      .output(z.object({ verdict: z.string() }));
    const unhookedAdjudicator = H.agent('unhooked-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ question: z.string() }))
      .output(z.object({ verdict: z.string() }));

    const nestedHookedFlow = H.flow('tier1-nested-hooked-replace')
      .input(SimpleSchema)
      .scope(SAMPLE_TIER1_SCOPE_NODE)
      .step('run', SimpleAgent, ($s) =>
        $s.onInterrupt(EscalationInterrupt, ($i) =>
          $i
            .adjudicateWith(hookedAdjudicator, (_in: { readonly id: string }, p: { readonly question: string }) => p)
            .onInterrupt(EscalationInterrupt, ($nested) =>
              $nested.replaceWith(SimpleAgent, () => ({ id: 'replaced' })),
            )
            .resumeWith((_in: { readonly id: string }, _p: { readonly question: string }, v: { readonly verdict: string }) => v.verdict),
        ),
      )
      .exit('done')
      .toAST();
    expect(nestedHookedFlow.id).toBe('tier1-nested-hooked-replace');

    expect(() =>
      H.flow('tier1-nested-unhooked-replace')
        .input(SimpleSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .step('run', SimpleAgent, ($s) =>
          $s.onInterrupt(EscalationInterrupt, ($i) =>
            $i
              .adjudicateWith(unhookedAdjudicator, (_in: { readonly id: string }, p: { readonly question: string }) => p)
              .onInterrupt(EscalationInterrupt, ($nested) =>
                $nested.replaceWith(SimpleAgent, () => ({ id: 'replaced' })),
              )
              .resumeWith((_in: { readonly id: string }, _p: { readonly question: string }, v: { readonly verdict: string }) => v.verdict),
          ),
        )
        .exit('done')
        .toAST(),
    ).toThrowError(
      "Flow 'tier1-nested-unhooked-replace' step 'unhooked-adjudicator' configures .replaceWith() on interrupt 'normative-esc' without .onAbort() on a Tier-1 'scope' (sample:tier1-scope); bind .onAbort() or use a 'checkpointable' or 'branchable' scope.",
    );
  });

  it('rejects clone-transcript forks across distinct roleKeys when prefixGroup uses role-scoped toolsMode', () => {
    const roleScopedPrefix = H.prefixGroup('role-scoped-group').toolsMode('role-scoped');
    const childWithExtraTools = SimpleAgent.withTools(SAMPLE_EXTRA_COMPARE_TOOL_NODE);

    expect(() =>
      SimpleAgent.prefixGroup(roleScopedPrefix)
        .capabilities(($c) =>
          $c.fork('cloneChild', childWithExtraTools, ($f) =>
            $f.historyMode('clone-transcript').requestSchema(SimpleSchema).mapInput((_p: { readonly id: string }, r: { readonly id: string }) => r),
          ),
        )
        .toAST(),
    ).toThrowError(
      "Agent 'simple-agent' (roleKey 'simple-agent') cannot use historyMode 'clone-transcript' on fork 'cloneChild' targeting 'simple-agent' (roleKey 'simple-agent+tools:git_compare') when prefixGroup 'role-scoped-group' has toolsMode 'role-scoped'; configure toolsMode('union') on the prefixGroup or use historyMode('shared-prefix-only').",
    );
  });

  it('rejects notify-only human channels on .ask(), .escalate(), human.withName().output(), and H.lane.maxCostUsd()', () => {
    const notifyOnlyHuman = H.human('pager').notify(SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE);
    expect(() => notifyOnlyHuman.withName('approver').output(BudgetApprovalSchema)).toThrowError(
      "Invalid human channel on 'pager' in H.human.withName().output(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
    );
    expect(() =>
      SimpleAgent.onInterrupt(EscalationInterrupt, ($i) => $i.ask(notifyOnlyHuman, BudgetApprovalSchema).resumeWith(() => 'ok')),
    ).toThrowError(
      "Invalid human channel on 'pager' in .ask(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
    );
    expect(() =>
      SimpleAgent.capabilities(($c) => $c.escalate(EscalationInterrupt, ($e) => $e.to(notifyOnlyHuman).response(BudgetApprovalSchema))),
    ).toThrowError(
      "Invalid human channel on 'pager' in .escalate(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
    );
    expect(() =>
      H.lane('bad-cost-lane').maxCostUsd(25, notifyOnlyHuman.withName('ops').output(BudgetApprovalSchema)),
    ).toThrowError(
      "Invalid human channel on 'pager' in H.human.withName().output(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
    );
  });

  it('rejects incomplete FlowBranchBuilder, ChildInterruptBuilder, LoopBuilder.returnOutputFrom(), and LaneBuilder.rewindTo()', () => {
    expect(() =>
      H.flow('empty-when')
        .input(SimpleSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .branch('b', ($b) => $b.output(SimpleSchema).when(() => true, ($sub) => $sub).otherwise(($sub) => $sub.step('s', SimpleAgent))),
    ).toThrowError("Flow branch 'b' .when() sub-branch must declare at least one step.");

    expect(() =>
      H.flow('empty-otherwise')
        .input(SimpleSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .branch('b', ($b) => $b.output(SimpleSchema).when(() => true, ($sub) => $sub.step('s', SimpleAgent)).otherwise(($sub) => $sub)),
    ).toThrowError("Flow branch 'b' .otherwise() sub-branch must declare at least one step.");

    expect(() =>
      H.flow('incomplete-branch').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).branch('b', ($b) => $b.output(SimpleSchema)),
    ).toThrowError("Flow branch 'b' requires at least one .when(...) case and an .otherwise(...) fallback.");

    expect(() =>
      SimpleAgent.onChildInterrupt(EscalationInterrupt, ($ci) => $ci.pauseSiblingForksInPartitions(() => ['db'])),
    ).toThrowError("Child interrupt handler for 'normative-esc' requires .suspendAndReturnToParent().");

    const evaluator = H.agent('eval').model(SAMPLE_MODEL_NODE).input(SimpleSchema).output(z.object({ ok: z.boolean() }));
    const untypedLoop: LoopBuilder<{ readonly id: string }, { readonly id: string }, unknown, string> = H.loop('bad-loop')
      .input(SimpleSchema)
      .output(SimpleSchema)
      .act('act-step', SimpleAgent)
      .evaluate('eval-step', evaluator, {
        mapInput: (inVal: { readonly id: string }) => inVal,
        acceptWhen: (outVal: { readonly ok: boolean }) => outVal.ok,
        feedbackMapper: () => 'retry',
      });
    expect(() => untypedLoop.returnOutputFrom('wrong-step')).toThrowError(
      "Loop 'bad-loop' returnOutputFrom('wrong-step') must match the .act() step ID ('act-step').",
    );

    const validFlow = H.flow('valid-flow').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).step('step-one', SimpleAgent).exit('done');
    const untypedLane: LaneBuilder<{ readonly id: string }, string> = H.lane('bad-rewind-lane')
      .input(SimpleSchema)
      .key((item: { readonly id: string }) => item.id)
      .runs(validFlow);
    expect(() =>
      untypedLane.onSignal(RewindSignal, ($s) => $s.update((cur: { readonly id: string }) => cur).rewindTo('non-existent-step')),
    ).toThrowError(
      "Lane 'bad-rewind-lane' signal handler on 'ci-failed' rewinds to unknown step ID 'non-existent-step' not present in flow 'valid-flow'.",
    );

    const outOfOrderFlow = H.flow('out-of-order-flow')
      .step('step-one', SimpleAgent)
      .input(SimpleSchema)
      .scope(SAMPLE_TIER1_SCOPE_NODE)
      .exit('done')
      .toAST();
    expect(outOfOrderFlow.nodes.map((n) => n.id)).toEqual(['step-one']);

    const outOfOrderLane = H.lane('out-of-order-lane')
      .key(() => 'item-1')
      .waitFor(() => ['dep-1'], 'abandoned')
      .onSignal(RewindSignal, ($s) => $s.update((cur: unknown) => cur).rewindTo('step-one'))
      .runs(outOfOrderFlow)
      .input(SimpleSchema)
      .toAST();
    expect(outOfOrderLane.onSignalHandlers.length).toBe(1);
    expect(outOfOrderLane.waitFor?.onAbandonedState).toBe('abandoned');
    expect(outOfOrderLane.flow.id).toBe('out-of-order-flow');

    expect(() =>
      H.lane('out-of-order-bad-rewind')
        .onSignal(RewindSignal, ($s) => $s.update((cur: unknown) => cur).rewindTo('non-existent-step'))
        .runs(validFlow),
    ).toThrowError(
      "Lane 'out-of-order-bad-rewind' signal handler on 'ci-failed' rewinds to unknown step ID 'non-existent-step' not present in flow 'valid-flow'.",
    );
  });
});
