import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, ModelPolicy, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sectionSchema = z.enum(['news', 'sports', 'opinion']);
const section = H.facet('section', sectionSchema.options);
const reviewerAModel = H.facet('reviewer-a-model');
const reviewerBModel = H.facet('reviewer-b-model');

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const draftSchema = z.object({
  title: z.string(),
  body: z.string(),
  section: sectionSchema,
  author: z.string(),
  notes: z.string().optional(),
});
const Draft = H.kind('Draft').data(draftSchema).states(submitted, reviewing, returned, accepted, withdrawn);

const editorTaste = H.memory('editor-taste', 'taste');
const factLessons = H.memory('fact-lessons', 'experience');
const tasteArchive = H.archive('editor-taste', editorTaste, jsonl.memory('content-review/taste.jsonl'));
const lessonArchive = H.archive('fact-lessons', factLessons, jsonl.memory('content-review/fact-lessons.jsonl'));
const reviewerBriefing = H.briefing('reviewer-briefing', [tasteArchive, lessonArchive]);

const editorReview = H.halt(
  'editor-review',
  z.object({ accept: z.boolean(), notes: z.string(), usedA: z.boolean(), usedB: z.boolean() })
);

const reviewer = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sectionSchema }))
  .output(z.object({ critique: z.string(), claims: z.array(z.string()) }))
  .prompt(draft => `Critique this ${draft.section} draft titled "${draft.title}". List every factual claim.\n\n${draft.body}`);

const incumbentA = anthropic.model('claude-opus-4');
const incumbentB = anthropic.model('claude-sonnet-4');
const challenger = anthropic.model('claude-haiku-4');

function actedOn(metrics: Metrics, model: Model): Rate {
  const asA = metrics.rate({
    among: { ...editorReview.resolved(), facets: [reviewerAModel.is(model.name)] },
    count: { ...editorReview.resolved({ usedA: true }), facets: [reviewerAModel.is(model.name)] },
    days: 90,
  });
  const asB = metrics.rate({
    among: { ...editorReview.resolved(), facets: [reviewerBModel.is(model.name)] },
    count: { ...editorReview.resolved({ usedB: true }), facets: [reviewerBModel.is(model.name)] },
    days: 90,
  });
  const hits = asA.hits + asB.hits;
  const samples = asA.samples + asB.samples;
  return { value: samples === 0 ? null : hits / samples, hits, samples };
}

function reviewerSlot(name: string, mine: Model, rival: Model): ModelPolicy {
  return H.policy.model(name, choice => {
    const own = actedOn(choice.metrics, mine);
    const other = actedOn(choice.metrics, rival);
    const settled = own.samples >= 50 && other.samples >= 50;
    return settled && (own.value ?? 0) < (other.value ?? 0) ? challenger : mine;
  });
}

const reviewerA = H.agent('reviewer-a', reviewer).model(reviewerSlot('reviewer-a-model', incumbentA, incumbentB)).recalls(reviewerBriefing);
const reviewerB = H.agent('reviewer-b', reviewer).model(reviewerSlot('reviewer-b-model', incumbentB, incumbentA)).recalls(reviewerBriefing);

const local = shell.local('local', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .output(z.object({ summary: z.string() }))
  .argv(critiques => ['critique-merge', '--a', critiques.a, '--b', critiques.b])
  .on(local)
  .recovers('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ section: sectionSchema, claims: z.array(z.string()) }))
  .output(z.object({ repeatMistakes: z.array(z.object({ rule: z.string(), because: z.string() })) }))
  .argv(check => ['fact-check', '--section', check.section, ...check.claims])
  .on(local)
  .recovers('rerun');

const reviewFlow = H.flow('review').for(Draft).does(async ctx => {
  const draft = ctx.unit.data;
  ctx.facet(section, draft.section);
  await ctx.move('reviewing');
  const input = { title: draft.title, body: draft.body, section: draft.section };
  const a = await ctx.run(reviewerA, input);
  const b = await ctx.run(reviewerB, input);
  if (!a.ok || !b.ok) return ctx.fail('a reviewer did not produce a critique');
  if (a.model) ctx.facet(reviewerAModel, a.model);
  if (b.model) ctx.facet(reviewerBModel, b.model);
  const checked = await ctx.run(factCheck, { section: draft.section, claims: [...a.value.claims, ...b.value.claims] });
  if (checked.ok) {
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(lessonArchive, { text: mistake.rule, because: mistake.because, when: { roles: [reviewer] } });
    }
  }
  const merged = await ctx.run(mergeCritiques, { a: a.value.critique, b: b.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);
  const verdict = await ctx.halt(editorReview, merged.value.summary);
  if (verdict.accept) return 'accepted';
  await ctx.update({ notes: verdict.notes });
  return 'returned';
});

const cmsBody = z.object({
  drafts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      section: sectionSchema,
      author: z.string(),
      status: z.enum(['submitted', 'resubmitted', 'withdrawn']),
    })
  ),
});

function readCms(body: z.infer<typeof cmsBody>): SupplyOf<typeof Draft>[] {
  const supply: SupplyOf<typeof Draft>[] = [];
  for (const d of body.drafts) {
    if (d.status === 'withdrawn') supply.push({ update: d.id, state: 'withdrawn' });
    else if (d.status === 'resubmitted') supply.push({ update: d.id, patch: { title: d.title, body: d.body }, state: 'submitted' });
    else supply.push({ create: { title: d.title, body: d.body, section: d.section, author: d.author }, key: d.id });
  }
  return supply;
}

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const draftLane = H.lane('drafts', Draft)
  .handler(reviewFlow)
  .suppliers(http.poll(Draft, { url: 'https://cms.example.com/api/drafts', every: { minutes: 10 }, headers: cmsHeaders, body: cmsBody, read: readCms }))
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_state' }))
  .wip(3);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const notes = event.unit.data.notes;
  if (!notes) return [];
  return act.remember(tasteArchive, {
    text: `When reviewing ${event.unit.data.section} drafts, ${notes}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    status: 'candidate',
    when: { kinds: [Draft], roles: [reviewer], facets: [section.is(event.unit.data.section)] },
  });
});

const apiPool = H.pool('api', [{ account: anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('content-review/ledger.db'))
  .lanes(draftLane)
  .pools(apiPool)
  .triggers(returnedNotesBecomeTaste)
  .scheduler(oldestFirst)
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('content-review/board.md'), markdown.telemetry('content-review/telemetry.md'));
