import { describe, expect, it } from 'vitest';
import {
  BudgetApprovalSchema, type GitAbortMeta, type GitScopeReceipt, type GitWorktreeHandle, P,
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
const LeaseRequestInterrupt = P.interrupt('lease-req').payload(z.object({ partition: z.string(), glob: z.string() }));
const EscalationInterrupt = P.interrupt('normative-esc').payload(z.object({ question: z.string() }));
const RewindSignal = P.signal('ci-failed').payload(z.object({ runId: z.string(), failureLog: z.string() }));

describe('P.flow, P.lane, and P.harness end-to-end compilation and generic inference', () => {
  it('propagates TReceipt, TCustomMetrics, TAbortMeta, and TStepOutputs across P.flow, P.lane, and P.harness', () => {
    const bidirectionalHuman = P.human('tech-lead').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const budgetHuman = bidirectionalHuman.withName('budget-owner').output(BudgetApprovalSchema);
    const baseWorker = P.agent<GitWorktreeHandle>('worker')
      .model(SAMPLE_MODEL_NODE)
      .tools(SAMPLE_DECLARED_TOOL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema);
    const adjudicator = P.agent<GitWorktreeHandle>('lease-adjudicator')
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
    const arbiterAgent = P.agent<GitWorktreeHandle>('arbiter')
      .model(SAMPLE_MODEL_NODE)
      .input(arbiterInputSchema)
      .output(arbiterVerdictSchema);

    const orchestrator = P.agent<GitWorktreeHandle>('orchestrator')
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

    const flow = P.flow('engineering-flow')
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

    const lane = P.lane('default-lane')
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

    const harnessNode = P.harness('meta-harness').ledger(SAMPLE_LEDGER_NODE).pools(SAMPLE_RUNNER_NODE).lanes(lane).toAST();
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
  const SimpleAgent = P.agent('simple-agent').model(SAMPLE_MODEL_NODE).input(SimpleSchema).output(SimpleSchema);

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
        P.flow('tier1-branch-flow').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).step('run', actor).exit('done').toAST(),
      ).toThrowError(
        "Flow 'tier1-branch-flow' scope 'sample:tier1-scope' has capabilityTier 'scope', but actor 'simple-agent' declares branching capabilities (.fork, .speculate, or .mutatePlan) requiring capabilityTier 'branchable'.",
      );
      expect(() =>
        P.flow('tier2-branch-flow').input(SimpleSchema).scope(SAMPLE_TIER2_SCOPE_NODE).step('run', actor).exit('done').toAST(),
      ).toThrowError(
        "Flow 'tier2-branch-flow' scope 'sample:tier2-scope' has capabilityTier 'checkpointable', but actor 'simple-agent' declares branching capabilities (.fork, .speculate, or .mutatePlan) requiring capabilityTier 'branchable'.",
      );
    }
  });

  it('rejects subprocess-post-flight tools under policy guards and unhooked .replaceWith() on Tier-1 scopes', () => {
    const guardedPolicy = P.policy<GitWorktreeHandle>('guarded').guard(SAMPLE_GUARD_NODE).onViolation('deny-with-error');
    const postFlightAgent = P.agent<GitWorktreeHandle>('post-flight-agent')
      .model(SAMPLE_MODEL_NODE)
      .policy(guardedPolicy)
      .tools(SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE)
      .input(SimpleSchema)
      .output(SimpleSchema);

    expect(() =>
      P.flow('tier1-postflight-flow').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).step('run', postFlightAgent).exit('done').toAST(),
    ).toThrowError(
      "Flow 'tier1-postflight-flow' scope 'sample:tier1-scope' has capabilityTier 'scope', but actor 'post-flight-agent' mounts subprocess-post-flight tool 'shell_exec' under policy 'guarded' requiring capabilityTier 'checkpointable' or 'branchable'.",
    );
    expect(() =>
      P.flow('tier1-replace-flow')
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

    const abortHookPolicy = P.policy('adj-abort-policy').onAbort(SAMPLE_ABORT_HOOK_NODE);
    const hookedAdjudicator = P.agent('hooked-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .policy(abortHookPolicy)
      .input(z.object({ question: z.string() }))
      .output(z.object({ verdict: z.string() }));
    const unhookedAdjudicator = P.agent('unhooked-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ question: z.string() }))
      .output(z.object({ verdict: z.string() }));

    const nestedHookedFlow = P.flow('tier1-nested-hooked-replace')
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
      P.flow('tier1-nested-unhooked-replace')
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
    const roleScopedPrefix = P.prefixGroup('role-scoped-group').toolsMode('role-scoped');
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

  it('rejects notify-only human channels on .ask(), .escalate(), human.withName().output(), and P.lane.maxCostUsd()', () => {
    const notifyOnlyHuman = P.human('pager').notify(SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE);
    expect(() => notifyOnlyHuman.withName('approver').output(BudgetApprovalSchema)).toThrowError(
      "Invalid human channel on 'pager' in P.human.withName().output(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
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
      P.lane('bad-cost-lane').maxCostUsd(25, notifyOnlyHuman.withName('ops').output(BudgetApprovalSchema)),
    ).toThrowError(
      "Invalid human channel on 'pager' in P.human.withName().output(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
    );
  });

  it('rejects incomplete FlowBranchBuilder, ChildInterruptBuilder, LoopBuilder.returnOutputFrom(), and LaneBuilder.rewindTo()', () => {
    expect(() =>
      P.flow('empty-when')
        .input(SimpleSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .branch('b', ($b) => $b.output(SimpleSchema).when(() => true, ($sub) => $sub).otherwise(($sub) => $sub.step('s', SimpleAgent))),
    ).toThrowError("Flow branch 'b' .when() sub-branch must declare at least one step.");

    expect(() =>
      P.flow('empty-otherwise')
        .input(SimpleSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .branch('b', ($b) => $b.output(SimpleSchema).when(() => true, ($sub) => $sub.step('s', SimpleAgent)).otherwise(($sub) => $sub)),
    ).toThrowError("Flow branch 'b' .otherwise() sub-branch must declare at least one step.");

    expect(() =>
      P.flow('incomplete-branch').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).branch('b', ($b) => $b.output(SimpleSchema)),
    ).toThrowError("Flow branch 'b' requires at least one .when(...) case and an .otherwise(...) fallback.");

    const pausedChildHandlerAgent = SimpleAgent.onChildInterrupt(
      EscalationInterrupt,
      ($ci) => $ci.pauseSiblingForksInPartitions(() => ['db']),
    ).toAST();
    expect(pausedChildHandlerAgent.onChildInterruptHandlers[0]?.mode).toBe(
      'suspend-and-return-to-parent',
    );
    expect(
      pausedChildHandlerAgent.onChildInterruptHandlers[0]?.pauseSiblingForksInPartitions?.({
        reason: 'conflict',
      }),
    ).toEqual(['db']);

    const evaluator = P.agent('eval').model(SAMPLE_MODEL_NODE).input(SimpleSchema).output(z.object({ ok: z.boolean() }));
    const untypedLoop: LoopBuilder<{ readonly id: string }, { readonly id: string }, unknown, string> = P.loop('bad-loop')
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

    const validFlow = P.flow('valid-flow').input(SimpleSchema).scope(SAMPLE_TIER1_SCOPE_NODE).step('step-one', SimpleAgent).exit('done');
    const untypedLane: LaneBuilder<{ readonly id: string }, string> = P.lane('bad-rewind-lane')
      .input(SimpleSchema)
      .key((item: { readonly id: string }) => item.id)
      .runs(validFlow);
    expect(() =>
      untypedLane.onSignal(RewindSignal, ($s) => $s.update((cur: { readonly id: string }) => cur).rewindTo('non-existent-step')),
    ).toThrowError(
      "Lane 'bad-rewind-lane' signal handler on 'ci-failed' rewinds to unknown step ID 'non-existent-step' not present in flow 'valid-flow'.",
    );

    const outOfOrderFlow = P.flow('out-of-order-flow')
      .step('step-one', SimpleAgent)
      .input(SimpleSchema)
      .scope(SAMPLE_TIER1_SCOPE_NODE)
      .exit('done')
      .toAST();
    expect(outOfOrderFlow.nodes.map((n) => n.id)).toEqual(['step-one']);

    const outOfOrderLane = P.lane('out-of-order-lane')
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
      P.lane('out-of-order-bad-rewind')
        .onSignal(RewindSignal, ($s) => $s.update((cur: unknown) => cur).rewindTo('non-existent-step'))
        .runs(validFlow),
    ).toThrowError(
      "Lane 'out-of-order-bad-rewind' signal handler on 'ci-failed' rewinds to unknown step ID 'non-existent-step' not present in flow 'valid-flow'.",
    );
  });

  it('infers TEvalIn, TEvalOut, and TReceipt on SpeculateCapabilityBuilder.verifyWinnerWith and preserves TAdjIn on AdjudicateInterruptBuilder.onInterrupt (P11)', () => {
    const baseWorker = P.agent<GitWorktreeHandle>('p11-worker')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema);
    const soleEvaluator = P.agent<GitWorktreeHandle>('p11-evaluator')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ prUrl: z.string(), headRef: z.string() }))
      .output(z.object({ accepted: z.boolean() }));
    const arbiterInputSchema = SpeculationInputSchema(
      FlowInputSchema,
      StepOutputSchema,
      SAMPLE_SCOPE_RECEIPT_SCHEMA,
    );
    const arbiterAgent = P.agent<GitWorktreeHandle>('p11-arbiter')
      .model(SAMPLE_MODEL_NODE)
      .input(arbiterInputSchema)
      .output(z.object({ winnerBranchIndex: z.number() }));
    const adjudicator = P.agent<GitWorktreeHandle>('p11-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ partition: z.string(), glob: z.string() }))
      .output(z.object({ grant: z.boolean() }));
    const subAdjudicator = P.agent<GitWorktreeHandle>('p11-sub-adjudicator')
      .model(SAMPLE_MODEL_NODE)
      .input(z.object({ partition: z.string(), question: z.string() }))
      .output(z.object({ answer: z.string() }));

    const parent = P.agent<GitWorktreeHandle>('p11-parent')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema)
      .capabilities(($cap) =>
        $cap.speculate('raceP11', ($s) =>
          $s
            .requestSchema(z.object({ count: z.number() }))
            .worker(baseWorker)
            .branches(2, (parentIn) => [parentIn, parentIn])
            .arbiter(arbiterAgent, {
              resolveDecision: (v) => ({
                decision: 'select-winner',
                winnerBranchIndex: v.winnerBranchIndex,
              }),
            })
            .verifyWinnerWith(soleEvaluator, {
              mapInput: (_bIn, bOut, receipt) => ({
                prUrl: bOut.prUrl,
                headRef: receipt.headRef,
              }),
              acceptWhen: (evalOut) => evalOut.accepted,
            }),
        ),
      )
      .onInterrupt(LeaseRequestInterrupt, ($i) =>
        $i
          .adjudicateWith(adjudicator, (_in, payload) => payload)
          .onInterrupt(EscalationInterrupt, ($sub) =>
            $sub
              .adjudicateWith(subAdjudicator, (adjIn, subPayload) => ({
                partition: adjIn.partition,
                question: subPayload.question,
              }))
              .resumeWith((_adjIn, _subPayload, subVerdict) => subVerdict.answer),
          )
          .resumeWith((_in, _payload, verdict) => String(verdict.grant)),
      );

    const ast = parent.toAST();
    expect(ast.capabilities?.speculations[0]?.verifyWinnerWith?.evaluator.id).toBe('p11-evaluator');
    const handler = ast.onInterruptHandlers[0];
    expect(handler?.mode).toBe('adjudicate');
    if (handler?.mode === 'adjudicate') {
      expect(handler.onInterruptHandlers).toHaveLength(1);
    }
  });

  it('supports 1-arg agent.onChildInterrupt(interrupt), direct HumanNode on lane.maxCostUsd(limit, human), and 3-arg harness.onSignal(sig, human, mapper) with exact AST equivalence (P12)', () => {
    const bidirectionalHuman = P.human('tech-lead').notify(SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE);
    const notifyOnlyHuman = P.human('webhook-only').notify(SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE);

    const agentShorthand = P.agent<GitWorktreeHandle>('p12-agent')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema)
      .onChildInterrupt(EscalationInterrupt);
    const agentExplicit = P.agent<GitWorktreeHandle>('p12-agent')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema)
      .onChildInterrupt(EscalationInterrupt, ($ci) => $ci.suspendAndReturnToParent());
    expect(agentShorthand.toAST()).toEqual(agentExplicit.toAST());

    const flow = P.flow('p12-flow')
      .input(FlowInputSchema)
      .scope(SAMPLE_TIER3_SCOPE_NODE)
      .step('work', agentShorthand)
      .exit('done');

    const laneShorthand = P.lane('p12-lane')
      .input(FlowInputSchema)
      .key((i) => i.id)
      .maxCostUsd(25, bidirectionalHuman)
      .runs(flow);
    const laneExplicit = P.lane('p12-lane')
      .input(FlowInputSchema)
      .key((i) => i.id)
      .maxCostUsd(
        25,
        bidirectionalHuman.withName('tech-lead:budget-approver').output(BudgetApprovalSchema),
      )
      .runs(flow);
    expect(laneShorthand.toAST().maxCostUsd?.approver.alias).toBe('tech-lead:budget-approver');
    expect(laneShorthand.toAST().maxCostUsd?.approver.human).toEqual(bidirectionalHuman.toAST());
    expect(laneShorthand.toAST().maxCostUsd?.approver.outputSchema).toBe(BudgetApprovalSchema);
    expect(laneExplicit.toAST().maxCostUsd?.approver.alias).toBe('tech-lead:budget-approver');

    expect(() =>
      P.lane('p12-bad-lane').maxCostUsd(25, notifyOnlyHuman),
    ).toThrow(
      "Invalid human channel on 'webhook-only' in P.lane.maxCostUsd(): channel 'slack:notifier' has interactionMode 'notify-only', but interactive decisions require 'bidirectional'.",
    );

    const mapper = (p: { readonly runId: string; readonly failureLog: string }): string =>
      `Failed:${p.runId}:${p.failureLog}`;
    const harnessShorthand = P.harness('p12-harness')
      .ledger(SAMPLE_LEDGER_NODE)
      .onSignal(RewindSignal, bidirectionalHuman, mapper);
    const harnessExplicit = P.harness('p12-harness')
      .ledger(SAMPLE_LEDGER_NODE)
      .onSignal(RewindSignal, ($s) => $s.notify(bidirectionalHuman, mapper));
    expect(harnessShorthand.toAST()).toEqual(harnessExplicit.toAST());
  });

  it('supports pass-through defaults on cap.fork(toolName, child, configure?) and 1-arg speculate.arbiter(arbiterActor) preserving TCandidate (P15)', () => {
    const WorkerInSchema = z.object({ task: z.string() });
    const WorkerOutSchema = z.object({ diff: z.string() });
    const ReceiptSchema = z.object({ headSha: z.string() });
    const ArbiterInSchema = SpeculationInputSchema(WorkerInSchema, WorkerOutSchema, ReceiptSchema);
    const ArbiterOutSchema = z.discriminatedUnion('decision', [
      z.object({
        decision: z.literal('select-winner'),
        winnerBranchIndex: z.number(),
        needsRefinement: z.boolean(),
      }),
      z.object({
        decision: z.literal('unpark-escalation'),
        parkedBranchIndex: z.number(),
        rationale: z.string(),
      }),
      z.object({
        decision: z.literal('reject-all'),
        rationale: z.string(),
      }),
    ]);

    const worker = P.agent<GitWorktreeHandle>('p15-worker')
      .model(SAMPLE_MODEL_NODE)
      .input(WorkerInSchema)
      .output(WorkerOutSchema);

    const arbiter = P.agent<GitWorktreeHandle>('p15-arbiter')
      .model(SAMPLE_MODEL_NODE)
      .input(ArbiterInSchema)
      .output(ArbiterOutSchema);

    const coordinator = P.agent<GitWorktreeHandle>('p15-coord')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema)
      .capabilities(($cap) =>
        $cap
          .fork('delegate-worker', worker)
          .fork('delegate-clone', worker, ($f) => $f.historyMode('clone-transcript'))
          .speculate('race-workers', ($s) =>
            $s
              .requestSchema(z.object({ tasks: z.array(z.string()) }))
              .worker(worker)
              .branches(2, (_parentIn, req) => req.tasks.map((task) => ({ task })))
              .arbiter(arbiter)
              .refineWinnerWhen(
                (verdict) => verdict.decision === 'select-winner' && verdict.needsRefinement,
                worker,
                (_parentIn, _verdict, candidates) => {
                  const first = candidates[0];
                  const sha = first?.status === 'COMPLETED' ? first.scopeReceipt.headSha : 'none';
                  return { task: `refine:${sha}` };
                },
              ),
          ),
      );

    const ast = coordinator.toAST();
    const fork0 = ast.capabilities?.forks[0];
    const fork1 = ast.capabilities?.forks[1];
    expect(fork0?.toolName).toBe('delegate-worker');
    expect(fork0?.historyMode).toBe('shared-prefix-only');
    expect(fork0?.requestSchema).toBe(WorkerInSchema);
    expect(fork0?.mapInput({ id: '1', title: 'item', mode: 'fast' }, { task: 'run' })).toEqual({
      task: 'run',
    });
    expect(fork1?.historyMode).toBe('clone-transcript');
    expect(fork1?.requestSchema).toBe(WorkerInSchema);

    const spec0 = ast.capabilities?.speculations[0];
    expect(spec0?.arbiter.actor.id).toBe('p15-arbiter');
    expect(
      spec0?.arbiter.resolveDecision({
        decision: 'select-winner',
        winnerBranchIndex: 1,
        needsRefinement: false,
      }),
    ).toEqual({
      decision: 'select-winner',
      winnerBranchIndex: 1,
      needsRefinement: false,
    });

    expect(() =>
      P.agent<GitWorktreeHandle>('p15-bad-fork')
        .model(SAMPLE_MODEL_NODE)
        .input(FlowInputSchema)
        .output(StepOutputSchema)
        .capabilities(($cap) =>
          $cap.fork('custom-req-missing-map', worker, ($f) =>
            $f.requestSchema(z.object({ custom: z.string() })),
          ),
        )
        .toAST(),
    ).toThrow(
      "Fork capability 'custom-req-missing-map' is missing required .mapInput(fn) configuration before .toAST().",
    );
  });

  it('produces pinpoint missing-method diagnostics on .toAST() across AgentBuilder, FlowBuilder, LoopBuilder, LaneBuilder, CommandBuilder, SpeculateCapabilityBuilder, and ForkCapabilityBuilder (P16)', () => {
    expect(() =>
      P.agent('triage')
        .model(SAMPLE_MODEL_NODE)
        .input(FlowInputSchema)
        .toAST(),
    ).toThrow(
      "Agent 'triage' is missing required .output(schema) configuration before .toAST().",
    );

    expect(() =>
      P.flow('incomplete-flow')
        .input(FlowInputSchema)
        .scope(SAMPLE_TIER1_SCOPE_NODE)
        .toAST(),
    ).toThrow(
      "Flow 'incomplete-flow' is missing required .exit(state) configuration before .toAST().",
    );

    const worker = P.agent('loop-worker')
      .model(SAMPLE_MODEL_NODE)
      .input(FlowInputSchema)
      .output(StepOutputSchema);
    expect(() =>
      P.loop('incomplete-loop')
        .act('work', worker)
        .toAST(),
    ).toThrow(
      "Loop 'incomplete-loop' is missing required .evaluate(stepId, evaluator, options) configuration before .toAST().",
    );

    expect(() =>
      P.lane('incomplete-lane')
        .input(FlowInputSchema)
        .key((i) => i.id)
        .toAST(),
    ).toThrow(
      "Lane 'incomplete-lane' is missing required .flow(flow) configuration before .toAST().",
    );

    expect(() =>
      P.command('incomplete-cmd')
        .input(FlowInputSchema)
        .output(StepOutputSchema)
        .toAST(),
    ).toThrow(
      "Command 'incomplete-cmd' is missing required .run(fn) configuration before .toAST().",
    );

    expect(() =>
      P.agent<GitWorktreeHandle>('incomplete-spec')
        .model(SAMPLE_MODEL_NODE)
        .input(FlowInputSchema)
        .output(StepOutputSchema)
        .capabilities(($cap) =>
          $cap.speculate('race-incomplete', ($s) =>
            $s
              .requestSchema(z.object({ tasks: z.array(z.string()) }))
              .worker(worker)
              .branches(2, () => []),
          ),
        )
        .toAST(),
    ).toThrow(
      "Speculate capability 'race-incomplete' is missing required .arbiter(actor) configuration before .toAST().",
    );
  });
});




