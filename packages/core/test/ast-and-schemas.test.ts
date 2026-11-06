import { describe, expect, it } from 'vitest';
import {
  BudgetApprovalSchema,
  type CustomDomainAST,
  GlobalRuleSchema,
  H,
  type IsolationScopeASTNode,
  ResumeForkInputSchema,
  ScopedRuleSchema,
  ScopePredicateSchema,
  SpeculationCandidateSchema,
  SpeculationInputSchema,
  extractAST,
  z,
  zodToJsonSchema,
} from '../src/index.js';
import {
  SAMPLE_CROSS_REPORT_SCHEMA,
  SAMPLE_SCOPE_RECEIPT_SCHEMA,
  SAMPLE_TIER1_SCOPE_NODE,
  SAMPLE_TIER2_SCOPE_NODE,
} from './fixtures/sample-domain-nodes.constants.js';

describe('AST extraction, symbolic EnvRef, and CustomDomainASTRegistry merging', () => {
  it('extracts passive AST nodes from both builders and raw AST objects', () => {
    const signalBuilder = H.signal('pr-merged').payload(z.object({ prNumber: z.number() }));
    const fromBuilder = extractAST(signalBuilder);
    const fromNode = extractAST(fromBuilder);

    expect(fromBuilder).toEqual({
      type: 'harness:signal',
      id: 'pr-merged',
      schema: signalBuilder.schema,
    });
    expect(fromNode).toBe(fromBuilder);
    expect(Object.isFrozen(fromBuilder)).toBe(true);
  });

  it('creates symbolic EnvRef descriptors via H.env(key) without reading process.env', () => {
    const secretKey = 'HARNESS_TEST_UNSET_SECRET_KEY_991';
    const envRef = H.env(secretKey);

    expect(envRef).toEqual({
      type: 'harness:env-ref',
      key: secretKey,
    });
    expect(Object.isFrozen(envRef)).toBe(true);
  });

  it('rejects empty or whitespace-only H.env(key) identifiers', () => {
    expect(() => H.env('')).toThrowError(
      "H.env requires a non-empty string identifier (received '').",
    );
    expect(() => H.env('   ')).toThrowError(
      "H.env requires a non-empty string identifier (received '   ').",
    );
  });

  it('merges both exact keys and namespaced keys in CustomDomainASTRegistry', () => {
    const tier1AsCustom: CustomDomainAST<'scope'> = SAMPLE_TIER1_SCOPE_NODE;
    const tier2AsCustom: CustomDomainAST<'scope'> = SAMPLE_TIER2_SCOPE_NODE;
    const scopes: readonly IsolationScopeASTNode[] = [tier1AsCustom, tier2AsCustom];

    expect(scopes[0]?.type).toBe('sample:tier1-scope');
    expect(scopes[0]?.capabilityTier).toBe('scope');
    expect(scopes[1]?.type).toBe('sample:tier2-scope');
    expect(scopes[1]?.capabilityTier).toBe('checkpointable');
  });
});

describe('Built-in Zod schemas and SpeculationInputSchema', () => {
  it('validates ScopePredicateSchema, GlobalRuleSchema, and ScopedRuleSchema', () => {
    const predicate = ScopePredicateSchema.parse({
      partitions: ['db', 'api'],
    });
    expect(predicate).toEqual({ partitions: ['db', 'api'] });

    const globalRule = GlobalRuleSchema.parse({
      id: 'rule-no-secrets',
      directive: 'Never hardcode secrets in source files.',
    });
    expect(globalRule).toEqual({
      id: 'rule-no-secrets',
      directive: 'Never hardcode secrets in source files.',
    });

    const scopedRule = ScopedRuleSchema.parse({
      id: 'rule-db-migrations',
      when: { partitions: ['db'] },
      directive: 'Include a reversible down migration.',
    });
    expect(scopedRule).toEqual({
      id: 'rule-db-migrations',
      when: { partitions: ['db'] },
      directive: 'Include a reversible down migration.',
      checks: [],
    });
  });

  it('validates BudgetApprovalSchema and ResumeForkInputSchema with default fields', () => {
    const approval = BudgetApprovalSchema.parse({
      approved: true,
      increaseLimitToUsd: 15,
    });
    expect(approval).toEqual({
      approved: true,
      increaseLimitToUsd: 15,
    });

    const resumeFork = ResumeForkInputSchema.parse({
      suspendedForkIds: ['fork-42'],
      resolutionSummary: 'Approved lease and synced parent.',
    });
    expect(resumeFork).toEqual({
      suspendedForkIds: ['fork-42'],
      action: 'resume',
      resolutionSummary: 'Approved lease and synced parent.',
    });
  });

  it('validates SpeculationCandidateSchema and 5-argument SpeculationInputSchema', () => {
    const branchInSchema = z.object({ approach: z.string() });
    const branchOutSchema = z.object({ summary: z.string(), testsAdded: z.number().default(1) });
    const escalationUnionSchema = z.union([
      z.object({ kind: z.literal('lease'), path: z.string() }),
      z.object({ kind: z.literal('normative'), question: z.string() }),
    ]);

    const candidateSchema = SpeculationCandidateSchema(
      branchInSchema,
      branchOutSchema,
      SAMPLE_SCOPE_RECEIPT_SCHEMA,
      SAMPLE_CROSS_REPORT_SCHEMA,
      escalationUnionSchema,
    );

    const completedCandidate = candidateSchema.parse({
      status: 'COMPLETED',
      branchIndex: 0,
      input: { approach: 'minimal-diff' },
      output: { summary: 'Fixed query index' },
      scopeReceipt: {
        headRef: 'sha-head-0',
        baseRef: 'sha-base',
        diffStat: '1 file changed',
        mutatedFiles: ['src/db.ts'],
      },
      crossVerifyReport: {
        matrixPassed: true,
        failingPairs: [],
      },
    });
    expect(completedCandidate).toEqual({
      status: 'COMPLETED',
      branchIndex: 0,
      input: { approach: 'minimal-diff' },
      output: { summary: 'Fixed query index', testsAdded: 1 },
      scopeReceipt: {
        headRef: 'sha-head-0',
        baseRef: 'sha-base',
        baseBranch: 'main',
        diffStat: '1 file changed',
        mutatedFiles: ['src/db.ts'],
      },
      crossVerifyReport: {
        matrixPassed: true,
        failingPairs: [],
      },
    });

    const arbiterInputSchema = SpeculationInputSchema(
      branchInSchema,
      branchOutSchema,
      SAMPLE_SCOPE_RECEIPT_SCHEMA,
      SAMPLE_CROSS_REPORT_SCHEMA,
      escalationUnionSchema,
    );

    const parsedArbiterInput = arbiterInputSchema.parse({
      candidates: [
        completedCandidate,
        {
          status: 'PARKED_ON_ESCALATION',
          branchIndex: 1,
          input: { approach: 'schema-migration' },
          scopeReceipt: {
            headRef: 'sha-head-1',
            baseRef: 'sha-base',
            baseBranch: 'main',
            diffStat: '2 files changed',
            mutatedFiles: ['migrations/001.sql'],
          },
          interruptId: 'lease-request',
          escalationPayload: { kind: 'lease', path: 'migrations/001.sql' },
        },
      ],
    });

    expect(parsedArbiterInput.candidates.length).toBe(2);
    expect(parsedArbiterInput.failedBranches).toEqual([]);
    expect(parsedArbiterInput.humanRulingsHistory).toEqual([]);
  });
});

describe('Deterministic canonical zodToJsonSchema converter', () => {
  it('converts primitives, literals, enums, arrays, tuples, records, and nested objects with sorted keys', () => {
    const complexSchema = z
      .object({
        zebra: z.string().describe('Zebra field'),
        alpha: z.number(),
        optionalFlag: z.boolean().optional(),
        defaultedCount: z.number().default(5),
        nullableNote: z.string().nullable(),
        mode: z.enum(['fast', 'thorough']),
        exactTag: z.literal('v1'),
        items: z.array(z.string()),
        pair: z.tuple([z.string(), z.number()]),
        labels: z.record(z.string(), z.number()),
      })
      .describe('Canonical test object');

    const jsonSchema = zodToJsonSchema(complexSchema);

    expect(Object.isFrozen(jsonSchema)).toBe(true);
    expect(jsonSchema).toEqual({
      additionalProperties: false,
      description: 'Canonical test object',
      properties: {
        alpha: { type: 'number' },
        defaultedCount: { default: 5, type: 'number' },
        exactTag: { const: 'v1', type: 'string' },
        items: { items: { type: 'string' }, type: 'array' },
        labels: { additionalProperties: { type: 'number' }, type: 'object' },
        mode: { enum: ['fast', 'thorough'], type: 'string' },
        nullableNote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        optionalFlag: { type: 'boolean' },
        pair: {
          items: false,
          prefixItems: [{ type: 'string' }, { type: 'number' }],
          type: 'array',
        },
        zebra: { description: 'Zebra field', type: 'string' },
      },
      required: ['alpha', 'exactTag', 'items', 'labels', 'mode', 'nullableNote', 'pair', 'zebra'],
      type: 'object',
    });

    expect(Object.keys(jsonSchema)).toEqual([
      'additionalProperties',
      'description',
      'properties',
      'required',
      'type',
    ]);
    const propsValue = jsonSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(propsValue)).toEqual([
      'alpha',
      'defaultedCount',
      'exactTag',
      'items',
      'labels',
      'mode',
      'nullableNote',
      'optionalFlag',
      'pair',
      'zebra',
    ]);
    expect(Object.keys(propsValue['defaultedCount'] ?? {})).toEqual(['default', 'type']);
    expect(Object.keys(propsValue['exactTag'] ?? {})).toEqual(['const', 'type']);
    expect(Object.keys(propsValue['items'] ?? {})).toEqual(['items', 'type']);
    expect(Object.keys(propsValue['labels'] ?? {})).toEqual(['additionalProperties', 'type']);
    expect(Object.keys(propsValue['mode'] ?? {})).toEqual(['enum', 'type']);
    expect(Object.keys(propsValue['pair'] ?? {})).toEqual(['items', 'prefixItems', 'type']);
    expect(Object.keys(propsValue['zebra'] ?? {})).toEqual(['description', 'type']);
  });

  it('handles literal null, literal bigint, and numeric nativeEnum without reverse-mapping keys', () => {
    enum NumericSeverity {
      Low = 0,
      Medium = 1,
      High = 2,
    }
    expect(zodToJsonSchema(z.literal(null))).toEqual({ const: null, type: 'null' });
    expect(zodToJsonSchema(z.literal(42n))).toEqual({ const: 42, type: 'integer' });
    expect(zodToJsonSchema(z.nativeEnum(NumericSeverity))).toEqual({ enum: [0, 1, 2] });
  });

  it('converts discriminated unions, intersections, and effects deterministically', () => {
    const unionSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), value: z.string() }),
      z.object({ kind: z.literal('b'), count: z.number() }),
    ]);
    const intersectionSchema = z.intersection(
      z.object({ id: z.string() }),
      z.object({ active: z.boolean() }),
    );
    const refinedSchema = z.string().refine((val: string) => val.length > 0);

    expect(zodToJsonSchema(unionSchema)).toEqual({
      anyOf: [
        {
          additionalProperties: false,
          properties: {
            kind: { const: 'a', type: 'string' },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            count: { type: 'number' },
            kind: { const: 'b', type: 'string' },
          },
          required: ['count', 'kind'],
          type: 'object',
        },
      ],
      discriminator: {
        propertyName: 'kind',
      },
    });

    expect(zodToJsonSchema(intersectionSchema)).toEqual({
      allOf: [
        {
          additionalProperties: false,
          properties: { id: { type: 'string' } },
          required: ['id'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: { active: { type: 'boolean' } },
          required: ['active'],
          type: 'object',
        },
      ],
    });

    expect(zodToJsonSchema(refinedSchema)).toEqual({ type: 'string' });
  });
});
