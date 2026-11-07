import {
  extractAST,
  z,
  type GitCandidateComparisonToolNode,
  type GitWorktreeHandle,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';

/**
 * Creates the speculative candidate comparison and benchmark tool bundle (`git.candidateComparisonTools(runner)`).
 *
 * Emits passive `GitCandidateComparisonToolNode` descriptors for `diffCandidates`, `readCandidateFile`,
 * and checkpoint-sandboxed `evalInCandidates` over `refs/harness/candidates/<run-id>/<branch-index>`.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} runner - Subprocess runner pool governing git and benchmark command slots.
 *
 * @returns {readonly GitCandidateComparisonToolNode<GitWorktreeHandle>[]} Frozen tuple of candidate comparison tool AST nodes.
 */
export function createGitCandidateComparisonTools(
  runner: MaybeBuilder<NodeRunnerNode>,
): readonly GitCandidateComparisonToolNode<GitWorktreeHandle>[] {
  const runnerNode = extractAST(runner);
  const diffCandidatesNode = Object.freeze<GitCandidateComparisonToolNode<GitWorktreeHandle>>({
    type: 'git:candidate-comparison-tool',
    name: 'diffCandidates',
    description: 'Computes the unified diff between two speculative candidate branches.',
    inputSchema: z.object({
      fromBranchIndex: z.number().int().min(0),
      toBranchIndex: z.number().int().min(0),
      paths: z.array(z.string()).optional(),
    }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const readCandidateFileNode = Object.freeze<GitCandidateComparisonToolNode<GitWorktreeHandle>>({
    type: 'git:candidate-comparison-tool',
    name: 'readCandidateFile',
    description: 'Reads a file from a speculative candidate branch by branchIndex and path.',
    inputSchema: z.object({
      branchIndex: z.number().int().min(0),
      path: z.string(),
    }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const evalInCandidatesNode = Object.freeze<GitCandidateComparisonToolNode<GitWorktreeHandle>>({
    type: 'git:candidate-comparison-tool',
    name: 'evalInCandidates',
    description: 'Executes a benchmark or check command across candidate worktrees inside a serialize/restore checkpoint sandbox.',
    inputSchema: z.object({
      branchIndices: z.array(z.number().int().min(0)).optional(),
      branchIndex: z.number().int().min(0).optional(),
      argv: z.array(z.string()).optional(),
      command: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  return Object.freeze([diffCandidatesNode, readCandidateFileNode, evalInCandidatesNode]);
}
