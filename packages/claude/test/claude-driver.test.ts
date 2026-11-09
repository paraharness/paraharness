import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  P,
  z,
  type BaseIsolationScopeASTNode,
  type CompiledWirePrefix,
  type RuntimeDriverContext,
  type RuntimeExecutorRegistry,
  type WireFrameRecord,
} from '@paraharness/core';
import { describe, expect, it } from 'vitest';
import { ClaudeModelDriver, claude, claudeExecutors, createClaudeExecutors } from '../src/index.js';
import { RecordedClaudeTransport } from './fixtures/recorded-claude-transport.js';

declare module '../../core/src/ast/custom-domain-ast-registry.js' {
  interface CustomDomainASTRegistry {
    readonly 'scope:claude-test': BaseIsolationScopeASTNode<'claude:test-scope', unknown, Record<string, unknown>, Record<string, unknown>, 'scope'>;
  }
}

function createDriverContext(envMap: Readonly<Record<string, string>>): RuntimeDriverContext {
  return {
    registry: {} as RuntimeExecutorRegistry,
    resolveEnv: (value) => (typeof value === 'string' ? value : envMap[value.key]),
    getRunner: () => {
      throw new Error('Runner not used in model driver unit tests.');
    },
  };
}

function createSampleWirePrefix(): CompiledWirePrefix {
  return Object.freeze<CompiledWirePrefix>({
    prefixGroupId: 'engineering-prefix',
    toolsMode: 'role-scoped',
    systemPromptText: 'Pinned system instructions byte 0.',
    systemDigest: 'sha256:sys-pinned',
    groundingSnapshots: Object.freeze([]),
    wireToolSchemasByRoleKey: Object.freeze({
      worker: Object.freeze([
        Object.freeze({
          name: 'read_file',
          description: 'Read file contents',
          inputJsonSchema: Object.freeze({ type: 'object', properties: { path: { type: 'string' } } }),
        }),
      ]),
    }),
  });
}

describe('@paraharness/claude builders and AST invariants', () => {
  it('compiles passive ClaudeAccountSeatNode and ClaudeModelNode without import or build I/O', () => {
    const cliSeat = claude.cliAccount('sub-a').configDir('~/.claude-a').toAST();
    const apiSeat = claude.account('api-fallback').apiKey(P.env('ANTHROPIC_API_KEY')).toAST();
    expect(cliSeat).toEqual({
      type: 'claude:account-seat',
      id: 'sub-a',
      configDir: '~/.claude-a',
      apiKey: undefined,
    });
    expect(apiSeat).toEqual({
      type: 'claude:account-seat',
      id: 'api-fallback',
      configDir: undefined,
      apiKey: { type: 'harness:env-ref', key: 'ANTHROPIC_API_KEY' },
    });

    const pool = P.pool('claude-accounts').with(cliSeat).strategy('soonest-reset').fallback(apiSeat);
    const sonnet = claude.model('sonnet', { id: 'claude-sonnet-4-6', effort: 'medium' }).accountPool(pool).toAST();
    const opus = claude.model('opus', { id: 'claude-opus-4-6' }).effort('high').pool(pool).toAST();

    expect(sonnet).toEqual({
      type: 'claude:model',
      vendor: 'anthropic',
      alias: 'sonnet',
      modelId: 'claude-sonnet-4-6',
      effort: 'medium',
      accountPool: pool.toAST(),
    });
    expect(opus.effort).toBe('high');
    expect(opus.accountPool).toEqual(pool.toAST());
    expect(claudeExecutors.models?.['claude:model']).toBeTypeOf('function');

    const shorthandSonnet = claude.model('claude-sonnet-4-6').toAST();
    const explicitSonnet = claude.model('claude-sonnet-4-6', { id: 'claude-sonnet-4-6' }).toAST();
    expect(shorthandSonnet).toEqual(explicitSonnet);
    const shorthandOpusEffort = claude.model('claude-opus-4-6', { effort: 'high' }).toAST();
    expect(shorthandOpusEffort).toEqual(
      claude.model('claude-opus-4-6', { id: 'claude-opus-4-6', effort: 'high' }).toAST(),
    );
  });

  it('extracts OAuth credentials from configDir and falls back to EnvRef apiKey when configDir is absent', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-oauth-'));
    try {
      writeFileSync(
        join(tempDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-live-token' } }),
        'utf8',
      );
      const oauthSeat = claude.cliAccount('sub-a').configDir(tempDir).toAST();
      const fallbackSeat = claude
        .cliAccount('sub-missing')
        .configDir(join(tempDir, 'non-existent-subdir'))
        .apiKey(P.env('ANTHROPIC_API_KEY'))
        .toAST();
      const modelNode = claude.model('sonnet', { id: 'claude-sonnet-4-6' }).toAST();
      const transport = new RecordedClaudeTransport([
        { status: 200, body: { content: [{ type: 'text', text: 'ok-oauth' }], usage: { input_tokens: 10, output_tokens: 5 } } },
        { status: 200, body: { content: [{ type: 'text', text: 'ok-apikey' }], usage: { input_tokens: 12, output_tokens: 6 } } },
      ]);
      const ctx = createDriverContext({ ANTHROPIC_API_KEY: 'sk-ant-api03-fallback-secret' });
      const slice = createClaudeExecutors(transport);
      const driver = slice.models?.['claude:model']?.(modelNode, ctx) ?? new ClaudeModelDriver(transport, modelNode, ctx);

      await driver.invokeTurn({ modelId: 'claude-sonnet-4-6', accountConfig: oauthSeat, history: [] });
      await driver.invokeTurn({ modelId: 'claude-sonnet-4-6', accountConfig: fallbackSeat, history: [] });

      expect(transport.requests[0]?.authSource).toBe('cli-oauth');
      expect(transport.requests[0]?.headers['authorization']).toBe('Bearer sk-ant-oat01-live-token');
      expect(transport.requests[1]?.authSource).toBe('api-key');
      expect(transport.requests[1]?.headers['x-api-key']).toBe('sk-ant-api03-fallback-secret');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('@paraharness/claude invokeTurn, prepareFork, and appendToolResultNotes', () => {
  it('enforces output_config.format JSON schema, preserves wireToolSchemas on toolChoice none, and preserves thinking signatures', async () => {
    const transport = new RecordedClaudeTransport([
      {
        status: 200,
        body: {
          content: [
            { type: 'thinking', thinking: 'Verify invariants first.', signature: 'sig-crypto-991' },
            { type: 'text', text: JSON.stringify({ summary: 'completed cleanly' }) },
          ],
          usage: { input_tokens: 100, cache_read_input_tokens: 80, output_tokens: 40 },
        },
      },
      {
        status: 429,
        body: { error: { message: 'rate_limit_error' } },
        resetAtMs: 1_700_000_060_000,
      },
    ]);
    const driver = new ClaudeModelDriver(transport);
    const prefix = createSampleWirePrefix();
    const outSchema = z.object({ summary: z.string() });

    const turnRes = await driver.invokeTurn({
      modelId: 'claude-opus-4-6',
      effort: 'low',
      toolChoice: 'none',
      wirePrefix: prefix,
      roleKey: 'worker',
      history: [],
      outputSchema: outSchema,
    });

    const sentBody = transport.requests[0]?.body;
    expect(sentBody?.['system']).toBe('Pinned system instructions byte 0.');
    expect(sentBody?.['tool_choice']).toEqual({ type: 'none' });
    expect(sentBody?.['tools']).toEqual([
      {
        name: 'read_file',
        description: 'Read file contents',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    expect(sentBody?.['output_config']).toEqual({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
          additionalProperties: false,
        },
      },
    });
    expect(turnRes.structuredOutput).toEqual({ summary: 'completed cleanly' });
    const rawDecoded = JSON.parse(new TextDecoder().decode(turnRes.wireFrame)) as Readonly<Record<string, unknown>>;
    expect(rawDecoded).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Verify invariants first.', signature: 'sig-crypto-991' },
        { type: 'text', text: '{"summary":"completed cleanly"}' },
      ],
    });

    await expect(
      driver.invokeTurn({ modelId: 'claude-opus-4-6', history: [] }),
    ).rejects.toMatchObject({
      status: 429,
      resetAtMs: 1_700_000_060_000,
    });
  });

  it('handles prepareFork across shared-prefix-only, clone-transcript tombstone modes, and full-turn (1..k) tool_result pairing', async () => {
    const driver = new ClaudeModelDriver(new RecordedClaudeTransport());
    const sharedFrames = await driver.prepareFork(
      {
        historyMode: 'shared-prefix-only',
        parentChain: [],
        forkPointMessageId: null,
        childRoleContextFrameText: '[ROLE_AND_SCOPE_CONTEXT]\nRole: worker',
        childTaskPromptText: 'Implement partition db',
      },
      { modelId: 'claude-sonnet-4-6', substituteTombstones: false },
    );
    expect(sharedFrames).toHaveLength(1);
    expect(sharedFrames[0]?.canonical.visibleText).toBe(
      '[ROLE_AND_SCOPE_CONTEXT]\nRole: worker\n\nImplement partition db',
    );

    const skillToolFrame: WireFrameRecord = {
      messageId: 'msg-1',
      parentMessageId: null,
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-skill', content: 'Full bulky 50KB skill instructions' }],
        }),
      ),
      canonical: {
        role: 'tool',
        visibleText: '',
        toolResults: [{ callId: 'call-skill', content: 'Full bulky 50KB skill instructions', isError: false }],
      },
      prefixDigest: 'sha256:p1',
      compactedTombstones: { 'call-skill': "[Skill 'db-migrations' completed and unmounted]" },
    };

    const assistantForkTurn: WireFrameRecord = {
      messageId: 'msg-2',
      parentMessageId: 'msg-1',
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Delegating across partitions', signature: 'sig-parent-42' },
            { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 'call-2', name: 'delegate_partition', input: { partition: 'db' } },
            { type: 'tool_use', id: 'call-3', name: 'delegate_partition', input: { partition: 'api' } },
          ],
        }),
      ),
      canonical: {
        role: 'assistant',
        visibleText: '',
        toolCalls: [
          { id: 'call-1', name: 'read_file', argsJson: '{"path":"a.ts"}' },
          { id: 'call-2', name: 'delegate_partition', argsJson: '{"partition":"db"}' },
          { id: 'call-3', name: 'delegate_partition', argsJson: '{"partition":"api"}' },
        ],
      },
      prefixDigest: 'sha256:p1',
    };

    const sameModelFork = await driver.prepareFork(
      {
        historyMode: 'clone-transcript',
        parentChain: [skillToolFrame, assistantForkTurn],
        forkPointMessageId: 'msg-2',
        forkCallId: 'call-2',
        siblingForkCallIds: ['call-3'],
        precedingCompletedResults: [{ callId: 'call-1', content: 'file-a-contents', isError: false }],
        childRoleContextFrameText: '[ROLE_CONTEXT: db]',
        childTaskPromptText: 'Build db schema',
      },
      { modelId: 'claude-sonnet-4-6', substituteTombstones: false },
    );

    expect(sameModelFork).toHaveLength(3);
    expect(sameModelFork[0]?.rawWireFrame).toEqual(skillToolFrame.rawWireFrame);
    const forkPointWire = JSON.parse(new TextDecoder().decode(sameModelFork[1]?.rawWireFrame)) as Readonly<Record<string, unknown>>;
    expect(forkPointWire['cache_control']).toEqual({ type: 'ephemeral' });
    expect((forkPointWire['content'] as readonly Readonly<Record<string, unknown>>[])[0]).toEqual({
      type: 'thinking',
      thinking: 'Delegating across partitions',
      signature: 'sig-parent-42',
    });
    expect(sameModelFork[2]?.canonical.toolResults).toEqual([
      { callId: 'call-1', content: 'file-a-contents', isError: false },
      { callId: 'call-2', content: '[ROLE_CONTEXT: db]\n\nBuild db schema', isError: false },
      { callId: 'call-3', content: '[Dispatched/Deferred in parent turn]', isError: false },
    ]);

    const crossModelFork = await driver.prepareFork(
      {
        historyMode: 'clone-transcript',
        parentChain: [skillToolFrame, assistantForkTurn],
        forkPointMessageId: 'msg-2',
        forkCallId: 'call-2',
        precedingCompletedResults: [{ callId: 'call-1', content: 'file-a-contents', isError: false }],
        childRoleContextFrameText: '[ROLE_CONTEXT: db]',
        childTaskPromptText: 'Build db schema',
      },
      { modelId: 'claude-opus-4-6', substituteTombstones: true },
    );

    expect(crossModelFork).toHaveLength(3);
    expect(crossModelFork[0]?.canonical.toolResults?.[0]?.content).toBe(
      "[Skill 'db-migrations' completed and unmounted]",
    );
    const crossAssistantWire = JSON.parse(
      new TextDecoder().decode(crossModelFork[1]?.rawWireFrame),
    ) as { readonly content: readonly Readonly<Record<string, unknown>>[] };
    expect(crossAssistantWire.content.some((b) => b['type'] === 'text')).toBe(false);
    expect(crossAssistantWire.content.some((b) => b['type'] === 'thinking')).toBe(false);
    expect(crossModelFork[2]?.canonical.toolResults).toEqual([
      { callId: 'call-1', content: 'file-a-contents', isError: false },
      { callId: 'call-2', content: '[ROLE_CONTEXT: db]\n\nBuild db schema', isError: false },
      { callId: 'call-3', content: '[Dispatched/Deferred in parent turn]', isError: false },
    ]);
  });

  it('appends synchronization notes to tool and user frames in both rawWireFrame and canonical', async () => {
    const driver = new ClaudeModelDriver(new RecordedClaudeTransport());
    const toolFrame: WireFrameRecord = {
      messageId: 'msg-tool-1',
      parentMessageId: 'msg-asst-1',
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'out-1' },
            { type: 'tool_result', tool_use_id: 'c2', content: 'out-2' },
          ],
        }),
      ),
      canonical: {
        role: 'tool',
        visibleText: '',
        toolResults: [
          { callId: 'c1', content: 'out-1', isError: false },
          { callId: 'c2', content: 'out-2', isError: false },
        ],
      },
      prefixDigest: 'sha256:p1',
    };

    const updatedTool = await driver.appendToolResultNotes(
      toolFrame,
      ['[TOPOLOGY_SYNC]: db epoch 2', '[SERVICE_REACQUIRED: pg]'],
      'c1',
      { isError: true },
    );
    expect(updatedTool.canonical.toolResults).toEqual([
      { callId: 'c1', content: 'out-1\n[TOPOLOGY_SYNC]: db epoch 2\n[SERVICE_REACQUIRED: pg]', isError: true },
      { callId: 'c2', content: 'out-2', isError: false },
    ]);
    const parsedToolWire = JSON.parse(new TextDecoder().decode(updatedTool.rawWireFrame)) as {
      readonly content: readonly Readonly<Record<string, unknown>>[];
    };
    expect(parsedToolWire.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'out-1\n[TOPOLOGY_SYNC]: db epoch 2\n[SERVICE_REACQUIRED: pg]',
      is_error: true,
    });

    const userFrame: WireFrameRecord = {
      messageId: 'msg-user-1',
      parentMessageId: null,
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'Initial prompt' }] }),
      ),
      canonical: { role: 'user', visibleText: 'Initial prompt' },
      prefixDigest: 'sha256:p1',
    };
    const updatedUser = await driver.appendToolResultNotes(userFrame, ['[LIMIT_EXCEEDED_FLUSH]']);
    expect(updatedUser.canonical.visibleText).toBe('Initial prompt\n[LIMIT_EXCEEDED_FLUSH]');
    expect(JSON.parse(new TextDecoder().decode(updatedUser.rawWireFrame))).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Initial prompt\n[LIMIT_EXCEEDED_FLUSH]' }],
    });
  });
});
