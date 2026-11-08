import type {
  LocalServiceNode,
  ServiceToolSchemaDescriptor,
} from '@paraharness/core';
import type { LocalDaemonBuilderState } from './local-daemon-builder-state.js';

/**
 * Compiles `LocalDaemonBuilderState` into a deeply frozen `LocalServiceNode`.
 *
 * Validates that `.start(...)` is configured and populates `toolSchemas` up front from all
 * registered `.interact(...)` tools.
 *
 * @param {LocalDaemonBuilderState} state - Current immutable builder state.
 *
 * @returns {LocalServiceNode} Frozen passive service AST node.
 *
 * @throws {Error} If `.start(...)` was not configured on the builder.
 */
export function compileLocalDaemonNode(state: LocalDaemonBuilderState): LocalServiceNode {
  if (state.startArgv === undefined) {
    throw new Error(`local.daemon('${state.id}') requires .start(...) before compilation.`);
  }
  const toolSchemas: ServiceToolSchemaDescriptor[] = [];
  for (const interaction of state.interactions) {
    toolSchemas.push(
      Object.freeze<ServiceToolSchemaDescriptor>({
        name: interaction.toolName,
        description: interaction.description,
        inputSchema: interaction.inputSchema,
      }),
    );
  }
  return Object.freeze<LocalServiceNode>({
    type: 'node:service',
    id: state.id,
    lifecycle: state.lifecycle,
    toolSchemas: Object.freeze(toolSchemas),
    runner: state.runner,
    ports: Object.freeze([...state.ports]),
    startArgv: state.startArgv,
    stopArgv: state.stopArgv,
    readyWhenStdoutRegex: state.readyWhenStdoutRegex,
    interactions: Object.freeze([...state.interactions]),
  });
}
