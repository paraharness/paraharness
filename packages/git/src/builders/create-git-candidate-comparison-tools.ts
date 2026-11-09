import {
  DEFAULT_NODE_RUNNER_AST_NODE,
  extractAST,
  type GitCandidateComparisonToolNode,
  type GitWorktreeHandle,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@paraharness/core';
import {
  DiffCandidatesInputSchema,
  EvalInCandidatesInputSchema,
  ReadCandidateFileInputSchema,
} from '../schemas/git-receipts.schema.js';

/**
 * Creates the speculative candidate comparison and benchmark tool bundle (`git.candidateComparisonTools(runner?)`).
 *
 * Emits passive `GitCandidateComparisonToolNode` descriptors for `diffCandidates`, `readCandidateFile`,
 * and checkpoint-sandboxed `evalInCandidates` over `refs/harness/candidates/<run-id>/<branch-index>`,
 * defaulting `runner` to `DEFAULT_NODE_RUNNER_AST_NODE` when omitted.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} [runner=DEFAULT_NODE_RUNNER_AST_NODE] - Optional subprocess runner pool governing git and benchmark command slots.
 *
 * @returns {readonly GitCandidateComparisonToolNode<GitWorktreeHandle>[]} Frozen tuple of candidate comparison tool AST nodes.
 */
export function createGitCandidateComparisonTools(
  runner: MaybeBuilder<NodeRunnerNode> = DEFAULT_NODE_RUNNER_AST_NODE,
): readonly GitCandidateComparisonToolNode<GitWorktreeHandle>[] {
  const runnerNode = extractAST(runner);
  const diffCandidatesNode = Object.freeze<GitCandidateComparisonToolNode<GitWorktreeHandle>>({
    type: 'git:candidate-comparison-tool',
    name: 'diffCandidates',
    description: 'Computes the unified diff between two speculative candidate branches.',
    inputSchema: DiffCandidatesInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const readCandidateFileNode = Object.freeze<GitCandidateComparisonToolNode<GitWorktreeHandle>>({
    type: 'git:candidate-comparison-tool',
    name: 'readCandidateFile',
    description: 'Reads a file from a speculative candidate branch by branchIndex and path.',
    inputSchema: ReadCandidateFileInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const evalInCandidatesNode = Object.freeze<GitCandidateComparisonToolNode<GitWorktreeHandle>>({
    type: 'git:candidate-comparison-tool',
    name: 'evalInCandidates',
    description: 'Executes a benchmark or check command across candidate worktrees inside a serialize/restore checkpoint sandbox.',
    inputSchema: EvalInCandidatesInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
  return Object.freeze([diffCandidatesNode, readCandidateFileNode, evalInCandidatesNode]);
}
