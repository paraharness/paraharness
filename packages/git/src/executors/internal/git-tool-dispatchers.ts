import type {
  GitCandidateComparisonToolNode,
  GitRefReaderToolNode,
  GitWorktreeHandle,
  StepExecutionContext,
  ToolExecutionResult,
} from '@metaharness/core';
import {
  DiffCandidatesInputSchema,
  DiffRefsInputSchema,
  EvalInCandidatesInputSchema,
  ListRefFilesInputSchema,
  ReadCandidateFileInputSchema,
  ReadRefFileInputSchema,
  type EvalInCandidatesInput,
} from '../../schemas/git-receipts.schema.js';
import { runGitCommand } from './git-cli-runner.js';
import { runEvalCommandInSandboxedCandidate } from './git-cross-test-import-scanner.js';

/**
 * Resolves the git ref or commit SHA for a speculative candidate branch index.
 *
 * Prefers `refs/harness/candidates/<runId>/<branchIndex>` when pinned on the host repo, falling back to `candidateHandles`.
 *
 * @param {number}                                  branchIndex - Zero-based speculative candidate branch index.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx         - Active step execution context.
 *
 * @returns {Promise<string>} Resolved git ref or commit SHA for `branchIndex`.
 */
async function resolveCandidateBranchRef(
  branchIndex: number,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<string> {
  const pinnedRef = `refs/harness/candidates/${ctx.runId}/${String(branchIndex)}`;
  const check = await runGitCommand({
    cwd: ctx.scopeHandle.worktreePath,
    args: ['rev-parse', '--verify', pinnedRef],
    allowNonZeroExit: true,
  });
  if (check.exitCode === 0 && check.stdout.trim().length > 0) {
    return check.stdout.trim();
  }
  const handle = ctx.candidateHandles?.get(branchIndex);
  if (handle !== undefined) return handle.headRef ?? handle.baseRef;
  return pinnedRef;
}

/**
 * Resolves the list of candidate branch indices targeted by an `evalInCandidates` tool invocation.
 *
 * @param {EvalInCandidatesInput}                   parsed - Validated `evalInCandidates` input payload.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx    - Active step execution context.
 *
 * @returns {readonly number[]} Target zero-based candidate branch indices.
 */
function resolveEvalCandidateBranchIndices(
  parsed: EvalInCandidatesInput,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): readonly number[] {
  if (parsed.branchIndices !== undefined) {
    return parsed.branchIndices;
  }
  if (parsed.branchIndex !== undefined) {
    return [parsed.branchIndex];
  }
  if (ctx.candidateHandles !== undefined) {
    return [...ctx.candidateHandles.keys()];
  }
  return [0];
}

/**
 * Executes the underlying Git CLI command for a `GitRefReaderToolNode` tool call.
 *
 * @param {GitRefReaderToolNode<GitWorktreeHandle>} node      - Ref-reader tool AST node.
 * @param {unknown}                                 validated - Schema-validated tool input arguments.
 * @param {string}                                  cwd       - Worktree directory path.
 *
 * @returns {Promise<ToolExecutionResult>} Serialized git command output.
 */
async function executeRefReaderGitCommand(
  node: GitRefReaderToolNode<GitWorktreeHandle>,
  validated: unknown,
  cwd: string,
): Promise<ToolExecutionResult> {
  if (node.name === 'readRefFile') {
    const parsed = ReadRefFileInputSchema.parse(validated);
    const showOutput = await runGitCommand({
      cwd,
      args: ['show', `${parsed.ref}:${parsed.path}`],
    });
    return { content: showOutput.stdout };
  }
  if (node.name === 'diffRefs') {
    const parsed = DiffRefsInputSchema.parse(validated);
    const paths = parsed.paths ?? [];
    const args = [
      'diff',
      parsed.fromRef,
      parsed.toRef,
      ...(paths.length > 0 ? ['--', ...paths] : []),
    ];
    const diffOutput = await runGitCommand({ cwd, args });
    return { content: diffOutput.stdout };
  }
  const parsed = ListRefFilesInputSchema.parse(validated);
  const prefix =
    parsed.prefix !== undefined && parsed.prefix.length > 0
      ? parsed.prefix
      : undefined;
  const args = [
    'ls-tree',
    '-r',
    '--name-only',
    parsed.ref,
    ...(prefix !== undefined ? ['--', prefix] : []),
  ];
  const lsTreeOutput = await runGitCommand({ cwd, args });
  return { content: lsTreeOutput.stdout };
}

/**
 * Dispatches a `GitRefReaderToolNode` invocation (`readRefFile`, `diffRefs`, `listRefFiles`) against the object store.
 *
 * Runs read-only `git show`, `git diff`, or `git ls-tree` inside `node.runner` concurrency slots.
 *
 * @param {GitRefReaderToolNode<GitWorktreeHandle>} node    - Ref-reader tool AST node.
 * @param {unknown}                                 rawArgs - Unvalidated tool input arguments.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx     - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Serialized git output.
 */
export async function dispatchRefReaderToolCall(
  node: GitRefReaderToolNode<GitWorktreeHandle>,
  rawArgs: unknown,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<ToolExecutionResult> {
  const validated = node.inputSchema.parse(rawArgs);
  const cwd = ctx.scopeHandle.worktreePath;
  const runCmd = (): Promise<ToolExecutionResult> =>
    executeRefReaderGitCommand(node, validated, cwd);
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    return ctx.getRunner(node.runner).withSlot(runCmd, ctx.signal);
  }
  return runCmd();
}

/**
 * Executes the underlying Git CLI or sandboxed evaluation command for a `GitCandidateComparisonToolNode`.
 *
 * @param {GitCandidateComparisonToolNode<GitWorktreeHandle>} node      - Candidate comparison tool AST node.
 * @param {unknown}                                           validated - Schema-validated tool input arguments.
 * @param {StepExecutionContext<GitWorktreeHandle>}           ctx       - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Serialized candidate comparison or benchmark output.
 */
async function executeCandidateComparisonGitCommand(
  node: GitCandidateComparisonToolNode<GitWorktreeHandle>,
  validated: unknown,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<ToolExecutionResult> {
  const cwd = ctx.scopeHandle.worktreePath;
  if (node.name === 'diffCandidates') {
    const parsed = DiffCandidatesInputSchema.parse(validated);
    const leftRef = await resolveCandidateBranchRef(parsed.fromBranchIndex, ctx);
    const rightRef = await resolveCandidateBranchRef(parsed.toBranchIndex, ctx);
    const paths = parsed.paths ?? [];
    const args = [
      'diff',
      leftRef,
      rightRef,
      ...(paths.length > 0 ? ['--', ...paths] : []),
    ];
    return { content: (await runGitCommand({ cwd, args })).stdout };
  }
  if (node.name === 'readCandidateFile') {
    const parsed = ReadCandidateFileInputSchema.parse(validated);
    const ref = await resolveCandidateBranchRef(parsed.branchIndex, ctx);
    return {
      content: (
        await runGitCommand({ cwd, args: ['show', `${ref}:${parsed.path}`] })
      ).stdout,
    };
  }
  const parsed = EvalInCandidatesInputSchema.parse(validated);
  const branchIndices = resolveEvalCandidateBranchIndices(parsed, ctx);
  const command: string | readonly string[] =
    parsed.argv ?? parsed.command ?? '';
  const outcomes: Array<Record<string, unknown>> = [];
  for (const branchIndex of branchIndices) {
    const candidateHandle =
      ctx.candidateHandles?.get(branchIndex) ?? ctx.scopeHandle;
    const evalOutcome = await runEvalCommandInSandboxedCandidate(
      candidateHandle,
      command,
      ctx,
    );
    outcomes.push({ branchIndex, ...evalOutcome });
  }
  return { content: JSON.stringify(outcomes) };
}

/**
 * Dispatches a `GitCandidateComparisonToolNode` invocation (`diffCandidates`, `readCandidateFile`, `evalInCandidates`).
 *
 * Wraps `evalInCandidates` benchmark runs in `serializeCheckpoint` + `try / finally { restoreCheckpoint }`.
 *
 * @param {GitCandidateComparisonToolNode<GitWorktreeHandle>} node    - Candidate comparison tool AST node.
 * @param {unknown}                                           rawArgs - Unvalidated tool input arguments.
 * @param {StepExecutionContext<GitWorktreeHandle>}           ctx     - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Serialized candidate comparison or benchmark output.
 */
export async function dispatchCandidateComparisonToolCall(
  node: GitCandidateComparisonToolNode<GitWorktreeHandle>,
  rawArgs: unknown,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<ToolExecutionResult> {
  const validated = node.inputSchema.parse(rawArgs);
  const runCmd = (): Promise<ToolExecutionResult> =>
    executeCandidateComparisonGitCommand(node, validated, ctx);
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    return ctx.getRunner(node.runner).withSlot(runCmd, ctx.signal);
  }
  return runCmd();
}
