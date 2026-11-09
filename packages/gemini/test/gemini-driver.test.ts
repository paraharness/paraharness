import { P, z, type BaseIsolationScopeASTNode, type CompiledWirePrefix, type RuntimeDriverContext, type RuntimeExecutorRegistry, type WireFrameRecord } from '@paraharness/core';
import { describe, expect, it } from 'vitest';
import { GeminiModelDriver, createGeminiExecutors, gemini, geminiExecutors } from '../src/index.js';
import { RecordedGeminiTransport } from './fixtures/recorded-gemini-transport.js';

declare module '../../core/src/ast/custom-domain-ast-registry.js' {
  interface CustomDomainASTRegistry {
    readonly 'scope:gemini-test': BaseIsolationScopeASTNode<'gemini:test-scope', unknown, Record<string, unknown>, Record<string, unknown>, 'scope'>;
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
    prefixGroupId: 'gemini-prefix',
    toolsMode: 'role-scoped',
    systemPromptText: 'Pinned Gemini instructions byte 0.',
    systemDigest: 'sha256:gemini-pinned',
    groundingSnapshots: Object.freeze([]),
    wireToolSchemasByRoleKey: Object.freeze({
      worker: Object.freeze([
        Object.freeze({
          name: 'search_docs',
          description: 'Search engineering docs',
          inputJsonSchema: Object.freeze({ type: 'object', properties: { query: { type: 'string' } } }),
        }),
      ]),
    }),
  });
}

describe('@paraharness/gemini builders and AST invariants', () => {
  it('compiles passive GeminiAccountSeatNode and GeminiModelNode without import or build I/O', () => {
    const apiSeat = gemini.account('g-seat-a').apiKey(P.env('GEMINI_API_KEY_A')).toAST();
    const cliSeat = gemini.cliAccount('g-cli-b').configDir('~/.config/gcloud-b').toAST();
    expect(apiSeat).toEqual({ type: 'gemini:account-seat', id: 'g-seat-a', configDir: undefined, apiKey: { type: 'harness:env-ref', key: 'GEMINI_API_KEY_A' } });
    expect(cliSeat).toEqual({ type: 'gemini:account-seat', id: 'g-cli-b', configDir: '~/.config/gcloud-b', apiKey: undefined });

    const pool = P.pool('gemini-seats').with(apiSeat, cliSeat).strategy('round-robin');
    const pro = gemini.model('geminiPro', { id: 'gemini-3.1-pro', effort: 'high' }).accountPool(pool).toAST();
    const flash = gemini.model('geminiFlash', { id: 'gemini-3.1-flash' }).effort('low').pool(pool).toAST();

    expect(pro).toEqual({
      type: 'gemini:model',
      vendor: 'google',
      alias: 'geminiPro',
      modelId: 'gemini-3.1-pro',
      effort: 'high',
      accountPool: pool.toAST(),
    });
    expect(flash.effort).toBe('low');
    expect(flash.accountPool).toEqual(pool.toAST());
    expect(geminiExecutors.models?.['gemini:model']).toBeTypeOf('function');

    const shorthandFlash = gemini.model('gemini-3.1-flash').toAST();
    expect(shorthandFlash).toEqual(gemini.model('gemini-3.1-flash', { id: 'gemini-3.1-flash' }).toAST());
    const shorthandProEffort = gemini.model('gemini-3.1-pro', { effort: 'high' }).toAST();
    expect(shorthandProEffort).toEqual(
      gemini.model('gemini-3.1-pro', { id: 'gemini-3.1-pro', effort: 'high' }).toAST(),
    );
  });
});

describe('@paraharness/gemini invokeTurn, role alternation coalescing, functionResponse errors, and HTTP 429', () => {
  it('maps systemInstruction, functionDeclarations, thinkingConfig, responseJsonSchema, strict role alternation, and functionResponse errors', async () => {
    const seatA = gemini.account('g-seat-a').apiKey(P.env('GEMINI_API_KEY_A')).toAST();
    const modelNode = gemini.model('geminiPro', { id: 'gemini-3.1-pro' }).toAST();
    const transport = new RecordedGeminiTransport([
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Planning search', thought: true, thoughtSignature: 'sig-g1' },
                  { text: '{"answer":"42"}' },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30, cachedContentTokenCount: 90 },
        },
      },
    ]);
    const ctx = createDriverContext({ GEMINI_API_KEY_A: 'AIza-secret-a' });
    const slice = createGeminiExecutors(transport);
    const driver = slice.models?.['gemini:model']?.(modelNode, ctx) ?? new GeminiModelDriver(transport, modelNode, ctx);
    const prefix = createSampleWirePrefix();
    const outSchema = z.object({ answer: z.string() });

    const history: readonly WireFrameRecord[] = [
      {
        messageId: 'm-1',
        parentMessageId: null,
        vendorId: 'google',
        rawWireFrame: new TextEncoder().encode(JSON.stringify({ role: 'user', parts: [{ text: 'First prompt' }] })),
        canonical: { role: 'user', visibleText: 'First prompt' },
        prefixDigest: 'sha256:gemini-pinned',
      },
      {
        messageId: 'm-2',
        parentMessageId: 'm-1',
        vendorId: 'google',
        rawWireFrame: new TextEncoder().encode(JSON.stringify({ role: 'user', parts: [{ text: 'Consecutive user prompt' }] })),
        canonical: { role: 'user', visibleText: 'Consecutive user prompt' },
        prefixDigest: 'sha256:gemini-pinned',
      },
      {
        messageId: 'm-3',
        parentMessageId: 'm-2',
        vendorId: 'google',
        rawWireFrame: new TextEncoder().encode(
          JSON.stringify({
            role: 'model',
            parts: [
              { functionCall: { id: 'call_0', name: 'search_docs', args: { query: 'missing' } } },
              { functionCall: { id: 'call_1', name: 'search_docs', args: { query: 'found' } } },
            ],
          }),
        ),
        canonical: {
          role: 'assistant',
          visibleText: '',
          toolCalls: [
            { id: 'call_0', name: 'search_docs', argsJson: '{"query":"missing"}' },
            { id: 'call_1', name: 'search_docs', argsJson: '{"query":"found"}' },
          ],
        },
        prefixDigest: 'sha256:gemini-pinned',
      },
      {
        messageId: 'm-4',
        parentMessageId: 'm-3',
        vendorId: 'other',
        rawWireFrame: new Uint8Array(),
        canonical: {
          role: 'tool',
          visibleText: '',
          toolResults: [
            { callId: 'call_0', content: 'Doc not found', isError: true },
            { callId: 'call_1', content: 'Doc contents ok', isError: false },
          ],
        },
        prefixDigest: 'sha256:gemini-pinned',
      },
    ];

    const turnRes = await driver.invokeTurn({
      modelId: 'gemini-3.1-pro',
      accountConfig: seatA,
      effort: 'high',
      toolChoice: 'none',
      wirePrefix: prefix,
      roleKey: 'worker',
      history,
      outputSchema: outSchema,
    });

    expect(turnRes.structuredOutput).toEqual({ answer: '42' });
    expect(turnRes.canonical.visibleText).toBe('{"answer":"42"}');
    expect(turnRes.usage).toEqual({
      inputTokens: 150,
      cachedInputTokens: 90,
      outputTokens: 30,
      costUsd: (150 * 0.00125 + 30 * 0.005) / 1_000,
    });

    const sentReq = transport.requests[0];
    expect(sentReq?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent');
    expect(sentReq?.headers['x-goog-api-key']).toBe('AIza-secret-a');
    expect(sentReq?.body).toEqual({
      systemInstruction: { parts: [{ text: 'Pinned Gemini instructions byte 0.' }] },
      contents: [
        {
          role: 'user',
          parts: [{ text: 'First prompt' }, { text: 'Consecutive user prompt' }],
        },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_0', name: 'search_docs', args: { query: 'missing' } } },
            { functionCall: { id: 'call_1', name: 'search_docs', args: { query: 'found' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'call_0', name: 'search_docs', response: { error: 'Doc not found' } } },
            { functionResponse: { id: 'call_1', name: 'search_docs', response: { result: 'Doc contents ok' } } },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'search_docs',
              description: 'Search engineering docs',
              parametersJsonSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
      },
    });
  });

  it('throws structured rate-limit error with status 429 and resetAtMs on HTTP 429', async () => {
    const resetAtMs = Date.now() + 10_000;
    const transport = new RecordedGeminiTransport([
      { status: 429, resetAtMs, body: { error: 'resource_exhausted' } },
    ]);
    const driver = new GeminiModelDriver(transport);
    await expect(
      driver.invokeTurn({
        modelId: 'gemini-3.1-pro',
        history: [],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const record = err as { readonly status?: number; readonly resetAtMs?: number };
      return record.status === 429 && record.resetAtMs === resetAtMs;
    });
  });
});

describe('@paraharness/gemini prepareFork and appendToolResultNotes', () => {
  it('supports shared-prefix-only and clone-transcript preserving vs stripping thought/thoughtSignature and full-turn (1..k) pairing', async () => {
    const driver = new GeminiModelDriver(new RecordedGeminiTransport());
    const skillToolFrame: WireFrameRecord = {
      messageId: 'gem-1',
      parentMessageId: null,
      vendorId: 'google',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          role: 'user',
          parts: [{ functionResponse: { id: 'call-skill', name: 'load_skill', response: { result: 'Full skill text' } } }],
        }),
      ),
      canonical: {
        role: 'tool',
        visibleText: '',
        toolResults: [{ callId: 'call-skill', content: 'Full skill text', isError: false }],
      },
      prefixDigest: 'sha256:g1',
      compactedTombstones: { 'call-skill': '[Skill load_skill compacted]' },
    };

    const assistantTurn: WireFrameRecord = {
      messageId: 'gem-2',
      parentMessageId: 'gem-1',
      vendorId: 'google',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          role: 'model',
          parts: [
            { text: 'Deep reasoning', thought: true, thoughtSignature: 'sig-1' },
            { functionCall: { id: 'call-1', name: 'search_docs', args: { query: 'a' } }, thoughtSignature: 'sig-2' },
            { functionCall: { id: 'call-2', name: 'delegate', args: { partition: 'api' } } },
            { functionCall: { id: 'call-3', name: 'delegate', args: { partition: 'web' } } },
          ],
        }),
      ),
      canonical: {
        role: 'assistant',
        visibleText: '',
        toolCalls: [
          { id: 'call-1', name: 'search_docs', argsJson: '{"query":"a"}' },
          { id: 'call-2', name: 'delegate', argsJson: '{"partition":"api"}' },
          { id: 'call-3', name: 'delegate', argsJson: '{"partition":"web"}' },
        ],
      },
      prefixDigest: 'sha256:g1',
    };

    const sharedOnly = await driver.prepareFork(
      { historyMode: 'shared-prefix-only', parentChain: [skillToolFrame, assistantTurn], forkPointMessageId: 'gem-2', childRoleContextFrameText: '[ROLE_CONTEXT: api]', childTaskPromptText: 'Build API' },
      { modelId: 'gemini-3.1-pro', substituteTombstones: false },
    );
    expect(sharedOnly).toHaveLength(1);
    expect(sharedOnly[0]?.canonical.visibleText).toBe('[ROLE_CONTEXT: api]\n\nBuild API');

    const forkCtx = {
      historyMode: 'clone-transcript' as const,
      parentChain: [skillToolFrame, assistantTurn],
      forkPointMessageId: 'gem-2',
      forkCallId: 'call-2',
      precedingCompletedResults: [{ callId: 'call-1', content: 'doc-a', isError: false }],
      childRoleContextFrameText: '[ROLE_CONTEXT: api]',
      childTaskPromptText: 'Build API',
    };
    const sameModelFork = await driver.prepareFork(forkCtx, { modelId: 'gemini-3.1-pro', substituteTombstones: false });
    expect(sameModelFork).toHaveLength(3);
    const sameAsst = JSON.parse(new TextDecoder().decode(sameModelFork[1]?.rawWireFrame)) as {
      readonly parts: readonly Readonly<Record<string, unknown>>[];
    };
    expect(sameAsst.parts[0]).toEqual({ text: 'Deep reasoning', thought: true, thoughtSignature: 'sig-1' });
    expect(sameAsst.parts[1]?.['thoughtSignature']).toBe('sig-2');
    expect(sameModelFork[2]?.canonical.toolResults).toEqual([
      { callId: 'call-1', content: 'doc-a', isError: false },
      { callId: 'call-2', content: '[ROLE_CONTEXT: api]\n\nBuild API', isError: false },
      { callId: 'call-3', content: '[Dispatched/Deferred in parent turn]', isError: false },
    ]);

    const crossModelFork = await driver.prepareFork(forkCtx, { modelId: 'gemini-3.1-flash', substituteTombstones: true });
    expect(crossModelFork).toHaveLength(3);
    expect(crossModelFork[0]?.canonical.toolResults?.[0]?.content).toBe('[Skill load_skill compacted]');
    const crossAsst = JSON.parse(new TextDecoder().decode(crossModelFork[1]?.rawWireFrame)) as {
      readonly parts: readonly Readonly<Record<string, unknown>>[];
    };
    expect(crossAsst.parts).toHaveLength(3);
    expect(crossAsst.parts[0]?.['thought']).toBeUndefined();
    expect(crossAsst.parts[0]?.['thoughtSignature']).toBeUndefined();

    const anthropicFrame: WireFrameRecord = {
      messageId: 'ant-1',
      parentMessageId: null,
      vendorId: 'anthropic',
      rawWireFrame: new TextEncoder().encode(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Claude analysis' }] })),
      canonical: { role: 'assistant', visibleText: 'Claude analysis' },
      prefixDigest: 'sha256:g1',
    };
    const crossVendorFork = await driver.prepareFork(
      { historyMode: 'clone-transcript', parentChain: [anthropicFrame], forkPointMessageId: 'ant-1', childRoleContextFrameText: '[ROLE_CONTEXT: api]', childTaskPromptText: 'Escalate' },
      { modelId: 'gemini-3.1-pro', substituteTombstones: true },
    );
    expect(JSON.parse(new TextDecoder().decode(crossVendorFork[0]?.rawWireFrame))).toEqual({
      role: 'model',
      parts: [{ text: 'Claude analysis' }],
    });
  });

  it('appends synchronization notes to tool and user frames in both rawWireFrame and canonical', async () => {
    const driver = new GeminiModelDriver(new RecordedGeminiTransport());
    const toolFrame: WireFrameRecord = {
      messageId: 'gem-tool-1',
      parentMessageId: 'gem-asst-1',
      vendorId: 'google',
      rawWireFrame: new TextEncoder().encode(
        JSON.stringify({
          role: 'user',
          parts: [
            { functionResponse: { id: 'c1', name: 'search_docs', response: { result: 'res-1' } } },
            { functionResponse: { id: 'c2', name: 'read_file', response: { result: 'res-2' } } },
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
      prefixDigest: 'sha256:g1',
    };

    const updatedTool = await driver.appendToolResultNotes(toolFrame, ['[PREREQUISITE_SYNC]'], 'c2', { isError: true });
    expect(updatedTool.canonical.toolResults?.[1]).toEqual({ callId: 'c2', content: 'res-2\n[PREREQUISITE_SYNC]', isError: true });
    const parsedWire = JSON.parse(new TextDecoder().decode(updatedTool.rawWireFrame)) as {
      readonly parts: readonly Readonly<Record<string, unknown>>[];
    };
    expect(parsedWire.parts[0]).toEqual({ functionResponse: { id: 'c1', name: 'search_docs', response: { result: 'res-1' } } });
    expect(parsedWire.parts[1]).toEqual({ functionResponse: { id: 'c2', name: 'read_file', response: { error: 'res-2\n[PREREQUISITE_SYNC]' } } });

    const userFrame: WireFrameRecord = {
      messageId: 'gem-user-1',
      parentMessageId: null,
      vendorId: 'google',
      rawWireFrame: new TextEncoder().encode(JSON.stringify({ role: 'user', parts: [{ text: 'Initial prompt' }] })),
      canonical: { role: 'user', visibleText: 'Initial prompt' },
      prefixDigest: 'sha256:g1',
    };
    const updatedUser = await driver.appendToolResultNotes(userFrame, ['[LIMIT_EXCEEDED_FLUSH]']);
    expect(updatedUser.canonical.visibleText).toBe('Initial prompt\n[LIMIT_EXCEEDED_FLUSH]');
    expect(JSON.parse(new TextDecoder().decode(updatedUser.rawWireFrame))).toEqual({
      role: 'user',
      parts: [{ text: 'Initial prompt\n[LIMIT_EXCEEDED_FLUSH]' }],
    });
  });
});
