import { z } from 'zod';
import { H } from 'harness-dsl';
import type { MemoryItem, Model, PickContext, Rate, RecallContext } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { wordpress } from 'harness-dsl/wordpress';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const Draft = H.kind('Draft', {
  data: z.object({ postId: z.string(), title: z.string(), body: z.string(), section: z.string() }),
  states: {
    incoming: 'pending',
    reviewing: 'active',
    withEditor: 'active',
    accepted: 'succeeded',
    returned: 'concluded',
    failed: 'failed',
    withdrawn: 'cancelled',
  },
  initial: 'incoming',
  tags: (draft) => [draft.section],
});

const cms = wordpress.drafts(Draft, {
  url: 'https://cms.example.com',
  token: H.env('CMS_TOKEN'),
  pollMinutes: 15,
  statuses: {
    incoming: 'pending',
    reviewing: 'pending',
    withEditor: 'pending',
    accepted: 'future',
    returned: 'draft',
    failed: 'pending',
    withdrawn: 'trash',
  },
  map: (post) => ({ postId: post.id, title: post.title, body: post.content, section: post.categories[0] ?? 'general' }),
});

const api = anthropic.account({ name: 'review-api', key: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model({ name: 'opus', id: 'claude-opus-4-1', account: api, price: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 } });
const sonnet = anthropic.model({ name: 'sonnet', id: 'claude-sonnet-4-5', account: api, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
const haiku = anthropic.model({ name: 'haiku', id: 'claude-haiku-4-5', account: api, price: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 } });

const reviewer = H.role('reviewer', {
  instructions: "Critique the draft against the publication's taste. Be concrete; quote the passage you mean.",
  intents: ['read'],
});

const Critique = z.object({ points: z.array(z.object({ passage: z.string(), note: z.string() })) });
const Merged = z.object({ summary: z.string(), points: z.array(z.string()) });
const FactCheck = z.object({ issues: z.array(z.string()) });
const EditorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.enum(['a', 'b', 'both', 'neither']),
});

const factCheck = H.command('fact-check', { argv: ['bin/fact-check'], output: FactCheck, timeoutSeconds: 600 });

const reviewFlow = H.flow('draft-review', { kinds: [Draft] })
  .mark('reviewing')
  .step('critiqueA', (ctx) =>
    H.ask(reviewer, { seat: 'reviewerA', prompt: `${ctx.unit.data.title}\n\n${ctx.unit.data.body}`, output: Critique }),
  )
  .step('critiqueB', (ctx) =>
    H.ask(reviewer, { seat: 'reviewerB', prompt: `${ctx.unit.data.title}\n\n${ctx.unit.data.body}`, output: Critique }),
  )
  .step('factCheck', factCheck)
  .step('merge', (ctx) =>
    H.command('merge-critiques', {
      argv: ['bin/merge-critiques'],
      env: {
        CRITIQUE_A: JSON.stringify(ctx.out.critiqueA),
        CRITIQUE_B: JSON.stringify(ctx.out.critiqueB),
        FACT_ISSUES: JSON.stringify(ctx.out.factCheck.issues),
      },
      output: Merged,
    }),
  )
  .mark('withEditor')
  .halt('editor', {
    question: (ctx) => `"${ctx.unit.data.title}" (${ctx.unit.data.section})\n\n${ctx.out.merge.summary}\n\nAccept or return with notes.`,
    decision: EditorDecision,
  })
  .end((ctx) => (ctx.out.editor !== undefined && ctx.out.editor.action === 'accept' ? 'accepted' : 'returned'), {
    note: (ctx) => ctx.out.editor?.notes ?? '',
  });

const actedOnA = H.metric('editor-acted-on-reviewer-a', {
  on: 'halt',
  select: z.object({ step: z.literal('editor'), decision: EditorDecision, cast: z.object({ reviewerA: z.string() }) }),
  success: (event) => event.decision.actedOn === 'a' || event.decision.actedOn === 'both',
  key: (event) => event.cast.reviewerA,
});

const actedOnB = H.metric('editor-acted-on-reviewer-b', {
  on: 'halt',
  select: z.object({ step: z.literal('editor'), decision: EditorDecision, cast: z.object({ reviewerB: z.string() }) }),
  success: (event) => event.decision.actedOn === 'b' || event.decision.actedOn === 'both',
  key: (event) => event.cast.reviewerB,
});

const swapAfterSamples = 50;

const actedOnRate = (ctx: PickContext<Model>, model: Model): Rate => {
  const a = ctx.metrics.rate(actedOnA, { key: model.name, sinceDays: 90 });
  const b = ctx.metrics.rate(actedOnB, { key: model.name, sinceDays: 90 });
  const samples = a.samples + b.samples;
  return { value: samples === 0 ? 0 : (a.value * a.samples + b.value * b.samples) / samples, samples };
};

const lineup = (ctx: PickContext<Model>): readonly [Model, Model] => {
  const bench = ctx.candidates.filter((c) => c.eligible).map((c) => c.value);
  let pair: readonly [Model, Model] = [bench[0] ?? opus, bench[1] ?? sonnet];
  for (const challenger of bench.slice(2)) {
    const [first, second] = pair;
    const firstRate = actedOnRate(ctx, first);
    const secondRate = actedOnRate(ctx, second);
    if (firstRate.samples < swapAfterSamples || secondRate.samples < swapAfterSamples) break;
    pair = firstRate.value >= secondRate.value ? [first, challenger] : [challenger, second];
  }
  return pair;
};

const reviewerModels = H.policy.pick('reviewer-a-b', [opus, sonnet, haiku], (ctx) => {
  const [first, second] = lineup(ctx);
  return ctx.seat === 'reviewerB' ? second : first;
});

const draftLane = H.lane(Draft)
  .from(cms)
  .store(cms)
  .handle(reviewFlow)
  .cast({ reviewerA: reviewerModels, reviewerB: reviewerModels })
  .states({ reviewing: 'reviewing', withEditor: 'withEditor', accepted: 'accepted', returned: 'returned', failed: 'failed', cancelled: 'withdrawn' })
  .runOn(shell.local({ name: 'reviews', slots: 4 }));

const within = (allowed: readonly string[] | undefined, present: readonly string[]) =>
  allowed === undefined || allowed.length === 0 || allowed.some((entry) => present.includes(entry));

const applies = (item: MemoryItem, ctx: RecallContext) =>
  item.status === 'active' && within(item.when.roles, [ctx.scope.role]) && within(item.when.tags, ctx.scope.tags);

const Taste = H.memory('editorial-taste', { stance: 'taste' });
const FactExperience = H.memory('fact-check-experience', { stance: 'experience' });

const tasteJournal = H.journal('editorial-taste', Taste, jsonl.memory({ path: '.harness/taste.jsonl' }))
  .recall(
    H.policy.recall('taste-section-then-general', async (ctx) =>
      (await ctx.items()).filter((item) => applies(item, ctx)).sort((a, b) => ctx.specificity(b) - ctx.specificity(a)).slice(0, ctx.limit),
    ),
  )
  .recalledBy(reviewer)
  .recordedBy(H.operator);

const factJournal = H.journal('fact-check-experience', FactExperience, jsonl.memory({ path: '.harness/fact-checks.jsonl' }))
  .recall(
    H.policy.recall('facts-specific-then-proven', async (ctx) =>
      (await ctx.items())
        .filter((item) => applies(item, ctx))
        .sort((a, b) => ctx.specificity(b) - ctx.specificity(a) || ctx.trackRecord(b).value - ctx.trackRecord(a).value)
        .slice(0, ctx.limit),
    ),
  )
  .recalledBy(reviewer)
  .recordedBy(factCheck);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste-candidates',
  H.when.enters(Draft, 'returned').where((event) => (event.note ?? '').trim() !== ''),
  (then) =>
    then.record(tasteJournal, (event) => ({
      do: event.note ?? '',
      condition: `when reviewing a ${event.unit.data.section} draft`,
      because: `the editor returned "${event.unit.data.title}" with this note`,
      when: { kinds: [Draft.name], tags: [event.unit.data.section] },
      status: 'candidate',
    })),
);

const projections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: 'BOARD.md' })),
  then.run(markdown.telemetry({ path: 'TELEMETRY.md', sinceDays: 30 })),
]);

const editorConsole = claudeCode.supervisor({
  name: 'editor-console',
  endpoint: H.slot.port(7406),
  grants: [H.op.readWork, H.op.resolveBlocker, H.op.readMemory, H.op.writeMemory, H.op.curateMemory, H.op.readTelemetry],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(draftLane)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, projections)
  .metrics(actedOnA, actedOnB)
  .scheduler(H.policy.order('oldest-first', (ctx) => ({ order: [...ctx.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds) })))
  .clients(editorConsole);

export const running = contentReview.start();
