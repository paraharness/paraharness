import { H } from 'harness-dsl';
import type { Metrics, Model, Rate } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = ['news', 'sports', 'opinion'] as const;

const submitted = H.state('submitted', 'pending');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'neutral');

const Draft = H.kind('Draft')
  .data(z.object({
    id: z.string(),
    title: z.string(),
    section: z.enum(sections),
    body: z.string(),
    editorNotes: z.string().optional(),
  }))
  .states(submitted, accepted, returned);

const taste = H.memory('editorial-taste', 'taste');
const factLessons = H.memory('fact-check-lessons', 'experience');
const tasteArchive = H.archive('editorial-taste', taste, jsonl.memory('memory/taste.jsonl'));
const factArchive = H.archive('fact-check-lessons', factLessons, jsonl.memory('memory/fact-check.jsonl'));
const reviewerBriefing = H.briefing('reviewer-briefing', [tasteArchive, factArchive]);

const reviewerAModel = H.tag('reviewer-a-model');
const reviewerBModel = H.tag('reviewer-b-model');

const editorReview = H.halt('editor-review', z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
}));

const candidates: readonly Model[] = [
  anthropic.model('claude-opus-4'),
  anthropic.model('claude-sonnet-4'),
  anthropic.model('claude-haiku-4'),
];

const minSamples = 50;

interface Standing {
  readonly model: Model;
  readonly rate: Rate;
}

const standings = (metrics: Metrics): readonly Standing[] => {
  const bySlotA = metrics.rateBy({
    among: editorReview.resolved(),
    count: editorReview.resolved({ actedOnA: true }),
    by: reviewerAModel,
    days: 60,
  });
  const bySlotB = metrics.rateBy({
    among: editorReview.resolved(),
    count: editorReview.resolved({ actedOnB: true }),
    by: reviewerBModel,
    days: 60,
  });
  return candidates.map((model) => {
    const a: Rate | undefined = bySlotA[model.name];
    const b: Rate | undefined = bySlotB[model.name];
    const hits = (a ? a.hits : 0) + (b ? b.hits : 0);
    const samples = (a ? a.samples : 0) + (b ? b.samples : 0);
    return { model, rate: { hits, samples, value: samples === 0 ? null : hits / samples } };
  });
};

const ranked = (metrics: Metrics): readonly Model[] =>
  [...standings(metrics)]
    .filter((s) => s.rate.samples >= minSamples)
    .sort((x, y) => (y.rate.value ?? 0) - (x.rate.value ?? 0))
    .map((s) => s.model);

const unexplored = (metrics: Metrics): readonly Model[] =>
  standings(metrics).filter((s) => s.rate.samples < minSamples).map((s) => s.model);

const championModel = H.policy.model('reviewer-champion', (choice) => {
  const best = ranked(choice.metrics);
  return best.length > 0 ? best[0] : candidates[0];
});

const challengerModel = H.policy.model('reviewer-challenger', (choice) => {
  const best = ranked(choice.metrics);
  const champion = best.length > 0 ? best[0] : candidates[0];
  const fresh = unexplored(choice.metrics).filter((m) => m.name !== champion.name);
  if (fresh.length > 0) return fresh[0];
  const runnerUp = best.filter((m) => m.name !== champion.name);
  return runnerUp.length > 0 ? runnerUp[0] : candidates[1];
});

const critic = H.role('critic')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ points: z.array(z.string()) }))
  .prompt((i) => `Critique the ${i.section} draft "${i.title}". List concrete points the editor can act on.\n\n${i.body}`)
  .intents(['read']);

const reviewerA = H.agent('reviewer-a', critic).model(championModel).recalls(reviewerBriefing);
const reviewerB = H.agent('reviewer-b', critic).model(challengerModel).recalls(reviewerBriefing);

const local = shell.local('local', { slots: 2 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.array(z.string()), b: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .argv((i) => ['merge-critiques', '--a', JSON.stringify(i.a), '--b', JSON.stringify(i.b)])
  .on(local)
  .recovers('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string(), section: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ text: z.string(), because: z.string() })) }))
  .argv((i) => ['fact-check', '--section', i.section, '--body', i.body])
  .on(local)
  .recovers('rerun');

const reviewFlow = H.flow('draft-review').for(Draft).does(async (ctx) => {
  const draft = ctx.unit.data;
  const input = { title: draft.title, section: draft.section, body: draft.body };
  const scope = { resources: [`section:${draft.section}`] };

  const a = await ctx.run(reviewerA, input, { scope });
  if (!a.ok) return ctx.fail(a.error);
  const b = await ctx.run(reviewerB, input, { scope });
  if (!b.ok) return ctx.fail(b.error);
  ctx.tag(reviewerAModel, a.model ?? 'unknown');
  ctx.tag(reviewerBModel, b.model ?? 'unknown');

  const merged = await ctx.run(mergeCritiques, { a: a.value.points, b: b.value.points });
  if (!merged.ok) return ctx.fail(merged.error);

  const checked = await ctx.run(factCheck, { body: draft.body, section: draft.section });
  if (checked.ok) {
    for (const repeat of checked.value.repeats) {
      await ctx.remember(factArchive, {
        text: repeat.text,
        because: repeat.because,
        when: { kinds: ['Draft'], roles: ['critic'] },
      });
    }
  }

  const decision = await ctx.halt(editorReview, merged.value.summary);
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ editorNotes: decision.notes });
  return 'returned';
});

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=submitted',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      section: z.enum(sections),
      body: z.string(),
    })),
  }),
  read: (body) => body.drafts.map((d) => ({ create: d, key: d.id })),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'reviewStatus',
});

const drafts = H.lane('drafts', Draft).handler(reviewFlow).suppliers(cmsPoll).store(cmsStore).wip(3);

const notesToTaste = H.trigger('returned-notes-to-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  if (!notes) return [];
  return act.remember(tasteArchive, {
    text: notes,
    because: `the editor returned "${event.unit.data.title}" with these notes`,
    when: { kinds: ['Draft'], roles: ['critic'], resources: [`section:${event.unit.data.section}`] },
    status: 'candidate',
  });
});

const pool = H.pool('anthropic', [
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const content = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.db'))
  .lanes(drafts)
  .pools(pool)
  .triggers(notesToTaste)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
