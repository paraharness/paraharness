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
import {
  OpenAiModelDriver,
  createOpenAiExecutors,
  openai,
  openaiExecutors,
} from '../src/index.js';
import { RecordedOpenAiTransport } from './fixtures/recorded-openai-transport.js';

declare module '../../core/src/ast/custom-domain-ast-registry.js' {
  interface CustomDomainASTRegistry {
    readonly 'scope:openai-test': BaseIsolationScopeASTNode<'openai:test-scope', unknown, Record<string, unknown>, Record<string, unknown>, 'scope'>;
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
    systemPromptText: 'Pinned OpenAI instructions byte 0.',
    systemDigest: 'sha256:oai-pinned',
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

describe('@paraharness/openai builders and AST invariants', () => {
  it('compiles passive OpenAiAccountSeatNode and OpenAiModelNode without import or build I/O', () => {
    const apiSeat = openai.account('seat-a').apiKey(P.env('OPENAI_API_KEY_A')).toAST();
    const cliSeat = openai.cliAccount('codex-b').configDir('~/.codex-b').toAST();
    expect(apiSeat).toEqual({
      type: 'openai:account-seat',
      id: 'seat-a',
      configDir: undefined,
      apiKey: { type: 'harness:env-ref', key: 'OPENAI_API_KEY_A' },
    });
    expect(cliSeat).toEqual({
      type: 'openai:account-seat',
      id: 'codex-b',
      configDir: '~/.codex-b',
      apiKey: undefined,
    });

    const pool = P.pool('openai-seats').with(apiSeat, cliSeat).strategy('round-robin');
    const gpt5 = openai.model('gpt5', { id: 'gpt-5', effort: 'medium' }).accountPool(pool).toAST();
    const o3 = openai.model('o3', { id: 'o3' }).effort('high').pool(pool).toAST();

    expect(gpt5).toEqual({
      type: 'openai:model',
      vendor: 'openai',
      alias: 'gpt5',
      modelId: 'gpt-5',
      effort: 'medium',
      accountPool: pool.toAST(),
    });
    expect(o3.effort).toBe('high');
    expect(o3.accountPool).toEqual(pool.toAST());
    expect(openaiExecutors.models?.['openai:model']).toBeTypeOf('function');
  });
});

describe('@paraharness/openai invokeTurn, prepareFork, cross-seat failover stripping, and appendToolResultNotes', () => {
  it('enforces text.format JSON schema, preserves tools on toolChoice none, and strips server IDs and encrypted_content on cross-seat failover', async () => {
    const seatA = openai.account('seat-a').apiKey(P.env('OPENAI_API_KEY_A')).toAST();
    const seatB = openai.account('seat-b').apiKey(P.env('OPENAI_API_KEY_B')).toAST();
    const modelNode = openai.model('gpt5', { id: 'gpt-5' }).toAST();
    const transport = new RecordedOpenAiTransport([
      {
        status: 200,
        body: {
          id: 'resp_seat_a_01',
          output: [
            {
              type: 'reasoning',
              id: 'rs_001',
              encrypted_content: 'enc_org_a_secret_blob',
              summary: [{ type: 'summary_text', text: 'Analyzed schema constraints.' }],
            },
            {
              type: 'message',
              id: 'msg_001',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify({ status: 'ok' }) }],
            },
          ],
          usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 90 }, output_tokens: 30 },
        },
      },
      {
        status: 200,
        body: {
          id: 'resp_seat_a_02',
          output: [
            {
              type: 'message',
              id: 'msg_002',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify({ status: 'same-seat' }) }],
            },
          ],
          usage: { input_tokens: 140, output_tokens: 20 },
        },
      },
      {
        status: 200,
        body: {
          id: 'resp_seat_b_01',
          output: [
            {
              type: 'message',
              id: 'msg_003',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify({ status: 'failover-seat-b' }) }],
            },
          ],
          usage: { input_tokens: 150, output_tokens: 25 },
        },
      },
    ]);
    const ctx = createDriverContext({
      OPENAI_API_KEY_A: 'sk-proj-seat-a',
      OPENAI_API_KEY_B: 'sk-proj-seat-b',
    });
    const slice = createOpenAiExecutors(transport);
    const driver = slice.models?.['openai:model']?.(modelNode, ctx) ?? new OpenAiModelDriver(transport, modelNode, ctx);
    const prefix = createSampleWirePrefix();
    const outSchema = z.object({ status: z.string() });

    const turn1 = await driver.invokeTurn({
      modelId: 'gpt-5',
      accountConfig: seatA,
      effort: 'low',
      toolChoice: 'none',
      wirePrefix: prefix,
      roleKey: 'worker',
      history: [],
      outputSchema: outSchema,
    });

    expect(turn1.structuredOutput).toEqual({ status: 'ok' });
    const req1 = transport.requests[0];
    expect(req1?.headers['authorization']).toBe('Bearer sk-proj-seat-a');
    expect(req1?.body['instructions']).toBe('Pinned OpenAI instructions byte 0.');
    expect(req1?.body['tool_choice']).toBe('none');
    expect(req1?.body['tools']).toHaveLength(1);
    expect(req1?.body['text']).toEqual({
      format: {
        type: 'json_schema',
        name: 'structured_output',
        schema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
          additionalProperties: false,
        },
        strict: true,
      },
    });

    const recordedFrameA: WireFrameRecord = {
      messageId: 'msg-a-1',
      parentMessageId: null,
      vendorId: 'openai',
      rawWireFrame: turn1.wireFrame,
      canonical: turn1.canonical,
      prefixDigest: 'sha256:oai-pinned',
    };

    await driver.invokeTurn({
      modelId: 'gpt-5',
      accountConfig: seatA,
      history: [recordedFrameA],
    });
    const reqSameSeat = transport.requests[1]?.body;
    expect(reqSameSeat?.['previous_response_id']).toBe('resp_seat_a_01');
    const sameSeatItems = reqSameSeat?.['input'] as readonly Readonly<Record<string, unknown>>[];
    expect(sameSeatItems[0]?.['id']).toBe('rs_001');
    expect(sameSeatItems[0]?.['encrypted_content']).toBe('enc_org_a_secret_blob');

    await driver.invokeTurn({
      modelId: 'gpt-5',
      accountConfig: seatB,
      history: [recordedFrameA],
    });
    const reqFailoverSeatB = transport.requests[2]?.body;
    expect(reqFailoverSeatB?.['previous_response_id']).toBeUndefined();
    const failoverItems = reqFailoverSeatB?.['input'] as readonly Readonly<Record<string, unknown>>[];
    expect(failoverItems[0]?.['id']).toBeUndefined();
    expect(failoverItems[0]?.['encrypted_content']).toBeUndefined();
    expect(failoverItems[0]?.['summary']).toEqual([{ type: 'summary_text', text: 'Analyzed schema constraints.' }]);
    expect(failoverItems[1]?.['id']).toBeUndefined();
  });

  it('handles prepareFork with full-turn (1..k) function_call_output pairing and substituteTombstones stripping', async () => {
    const driver = new OpenAiModelDriver(new RecordedOpenAiTransport());
    const skillToolFrame: WireFrameRecord = {
      messageId: 'oai-1',
      parentMessageId: null,
      vendorId: 'openai',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          seatId: 'seat-a',
          items: [{ type: 'function_call_output', call_id: 'call-skill', output: 'Full 40KB skill instructions' }],
        }),
      ),
      canonical: {
        role: 'tool',
        visibleText: '',
        toolResults: [{ callId: 'call-skill', content: 'Full 40KB skill instructions', isError: false }],
      },
      prefixDigest: 'sha256:p1',
      compactedTombstones: { 'call-skill': "[Skill 'ui-verification' completed and unmounted]" },
    };

    const assistantTurn: WireFrameRecord = {
      messageId: 'oai-2',
      parentMessageId: 'oai-1',
      vendorId: 'openai',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          seatId: 'seat-a',
          responseId: 'resp_parent_99',
          items: [
            { type: 'reasoning', id: 'rs_99', encrypted_content: 'enc_99', summary: [{ type: 'summary_text', text: 'Plan' }] },
            { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"x.ts"}' },
            { type: 'function_call', id: 'fc_2', call_id: 'call-2', name: 'delegate', arguments: '{"partition":"api"}' },
            { type: 'function_call', id: 'fc_3', call_id: 'call-3', name: 'delegate', arguments: '{"partition":"web"}' },
          ],
        }),
      ),
      canonical: {
        role: 'assistant',
        visibleText: '',
        toolCalls: [
          { id: 'call-1', name: 'read_file', argsJson: '{"path":"x.ts"}' },
          { id: 'call-2', name: 'delegate', argsJson: '{"partition":"api"}' },
          { id: 'call-3', name: 'delegate', argsJson: '{"partition":"web"}' },
        ],
      },
      prefixDigest: 'sha256:p1',
    };

    const sharedFrames = await driver.prepareFork(
      { historyMode: 'shared-prefix-only', parentChain: [skillToolFrame, assistantTurn], forkPointMessageId: 'oai-2', childRoleContextFrameText: '[ROLE_CONTEXT: api]', childTaskPromptText: 'Implement api endpoints' },
      { modelId: 'gpt-5', accountConfig: { id: 'seat-a' }, substituteTombstones: false },
    );
    expect(sharedFrames).toHaveLength(1);
    expect(sharedFrames[0]?.canonical.visibleText).toBe('[ROLE_CONTEXT: api]\n\nImplement api endpoints');

    const forkCtx = {
      historyMode: 'clone-transcript' as const,
      parentChain: [skillToolFrame, assistantTurn],
      forkPointMessageId: 'oai-2',
      forkCallId: 'call-2',
      precedingCompletedResults: [{ callId: 'call-1', content: 'x-contents', isError: false }],
      childRoleContextFrameText: '[ROLE_CONTEXT: api]',
      childTaskPromptText: 'Implement api endpoints',
    };
    const sameModelFork = await driver.prepareFork(forkCtx, { modelId: 'gpt-5', accountConfig: { id: 'seat-a' }, substituteTombstones: false });
    expect(sameModelFork).toHaveLength(3);
    const sameForkAsst = JSON.parse(new TextDecoder().decode(sameModelFork[1]?.rawWireFrame)) as Readonly<Record<string, unknown>>;
    expect(sameForkAsst['previous_response_id']).toBe('resp_parent_99');
    expect(sameModelFork[2]?.canonical.toolResults).toEqual([
      { callId: 'call-1', content: 'x-contents', isError: false },
      { callId: 'call-2', content: '[ROLE_CONTEXT: api]\n\nImplement api endpoints', isError: false },
      { callId: 'call-3', content: '[Dispatched/Deferred in parent turn]', isError: false },
    ]);

    const crossSeatFork = await driver.prepareFork(forkCtx, { modelId: 'gpt-5', accountConfig: { id: 'seat-b' }, substituteTombstones: false });
    expect(crossSeatFork).toHaveLength(3);
    expect(crossSeatFork[0]?.canonical.toolResults?.[0]?.content).toBe('Full 40KB skill instructions');
    const crossSeatAsst = JSON.parse(new TextDecoder().decode(crossSeatFork[1]?.rawWireFrame)) as {
      readonly previous_response_id?: string;
      readonly items: readonly Readonly<Record<string, unknown>>[];
    };
    expect(crossSeatAsst.previous_response_id).toBeUndefined();
    expect(crossSeatAsst.items[0]?.['id']).toBeUndefined();
    expect(crossSeatAsst.items[0]?.['encrypted_content']).toBeUndefined();

    const crossModelFork = await driver.prepareFork(forkCtx, { modelId: 'o3', substituteTombstones: true });

    expect(crossModelFork).toHaveLength(3);
    expect(crossModelFork[0]?.canonical.toolResults?.[0]?.content).toBe(
      "[Skill 'ui-verification' completed and unmounted]",
    );
    const crossForkAsst = JSON.parse(new TextDecoder().decode(crossModelFork[1]?.rawWireFrame)) as {
      readonly previous_response_id?: string;
      readonly items: readonly Readonly<Record<string, unknown>>[];
    };
    expect(crossForkAsst.previous_response_id).toBeUndefined();
    expect(crossForkAsst.items[0]?.['id']).toBeUndefined();
    expect(crossForkAsst.items[0]?.['encrypted_content']).toBeUndefined();
    expect(crossModelFork[2]?.canonical.toolResults).toEqual([
      { callId: 'call-1', content: 'x-contents', isError: false },
      { callId: 'call-2', content: '[ROLE_CONTEXT: api]\n\nImplement api endpoints', isError: false },
      { callId: 'call-3', content: '[Dispatched/Deferred in parent turn]', isError: false },
    ]);
  });

  it('appends synchronization notes to tool and user frames in both rawWireFrame and canonical', async () => {
    const driver = new OpenAiModelDriver(new RecordedOpenAiTransport());
    const toolFrame: WireFrameRecord = {
      messageId: 'oai-tool-1',
      parentMessageId: 'oai-asst-1',
      vendorId: 'openai',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          items: [
            { type: 'function_call_output', call_id: 'c1', output: 'res-1' },
            { type: 'function_call_output', call_id: 'c2', output: 'res-2' },
          ],
        }),
      ),
      canonical: {
        role: 'tool',
        visibleText: '',
        toolResults: [
          { callId: 'c1', content: 'res-1', isError: false },
          { callId: 'c2', content: 'res-2', isError: false },
        ],
      },
      prefixDigest: 'sha256:p1',
    };

    const updatedTool = await driver.appendToolResultNotes(toolFrame, ['[PREREQUISITE_SYNC]'], 'c2', { isError: true });
    expect(updatedTool.canonical.toolResults?.[1]).toEqual({
      callId: 'c2',
      content: 'res-2\n[PREREQUISITE_SYNC]',
      isError: true,
    });
    const parsedWire = JSON.parse(new TextDecoder().decode(updatedTool.rawWireFrame)) as {
      readonly items: readonly Readonly<Record<string, unknown>>[];
    };
    expect(parsedWire.items[1]).toEqual({
      type: 'function_call_output',
      call_id: 'c2',
      output: 'res-2\n[PREREQUISITE_SYNC]',
      is_error: true,
    });

    const userFrame: WireFrameRecord = {
      messageId: 'oai-user-1',
      parentMessageId: null,
      vendorId: 'openai',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({ items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Initial prompt' }] }] }),
      ),
      canonical: { role: 'user', visibleText: 'Initial prompt' },
      prefixDigest: 'sha256:p1',
    };
    const updatedUser = await driver.appendToolResultNotes(userFrame, ['[LIMIT_EXCEEDED_FLUSH]']);
    expect(updatedUser.canonical.visibleText).toBe('Initial prompt\n[LIMIT_EXCEEDED_FLUSH]');
    expect(JSON.parse(new TextDecoder().decode(updatedUser.rawWireFrame))).toEqual({
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Initial prompt\n[LIMIT_EXCEEDED_FLUSH]' }] }],
    });
  });
});
