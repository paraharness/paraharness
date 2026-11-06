import {
  extractAST,
  z,
  type FsEditToolNode,
  type FsGlobToolNode,
  type FsGrepToolNode,
  type FsReadToolNode,
  type FsWriteToolNode,
  type MaybeBuilder,
  type NodeRunnerNode,
} from '@harness-dsl/core';

/**
 * Compiles the 5-tool workspace-jailed coding bundle (`fs.codingTools(runner)`).
 *
 * Returns passive `ToolASTNode` descriptors (`read_file`, `edit_file`, `write_file`,
 * `glob_files`, `grep_files`) with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
 *
 * @returns {readonly [FsReadToolNode<THandle>, FsEditToolNode<THandle>, FsWriteToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>]} Frozen 5-tuple of filesystem coding tool AST nodes.
 */
export function createFsCodingTools<THandle = unknown>(
  runner: MaybeBuilder<NodeRunnerNode>,
): readonly [
  FsReadToolNode<THandle>,
  FsEditToolNode<THandle>,
  FsWriteToolNode<THandle>,
  FsGlobToolNode<THandle>,
  FsGrepToolNode<THandle>,
] {
  const runnerNode = extractAST(runner);
  const readTool = Object.freeze<FsReadToolNode<THandle>>({
    type: 'fs:read',
    name: 'read_file',
    description: 'Read UTF-8 text from a workspace-relative file path.',
    inputSchema: z.object({ path: z.string().min(1) }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const editTool = Object.freeze<FsEditToolNode<THandle>>({
    type: 'fs:edit',
    name: 'edit_file',
    description: 'Replace an exact target string in an existing workspace-relative file.',
    inputSchema: z.object({
      path: z.string().min(1),
      oldString: z.string(),
      newString: z.string(),
    }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const writeTool = Object.freeze<FsWriteToolNode<THandle>>({
    type: 'fs:write',
    name: 'write_file',
    description: 'Create or overwrite a workspace-relative UTF-8 file.',
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
    }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const globTool = Object.freeze<FsGlobToolNode<THandle>>({
    type: 'fs:glob',
    name: 'glob_files',
    description: 'List workspace-relative files matching a POSIX glob pattern.',
    inputSchema: z.object({ pattern: z.string().min(1) }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  const grepTool = Object.freeze<FsGrepToolNode<THandle>>({
    type: 'fs:grep',
    name: 'grep_files',
    description: 'Search workspace files for lines matching a regular expression pattern.',
    inputSchema: z.object({
      pattern: z.string().min(1),
      glob: z.string().optional(),
      flags: z.string().optional(),
    }),
    effectTracking: 'declared',
    runner: runnerNode,
  });
  return Object.freeze([readTool, editTool, writeTool, globTool, grepTool]);
}
