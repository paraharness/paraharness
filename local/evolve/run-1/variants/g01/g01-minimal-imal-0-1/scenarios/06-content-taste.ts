import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import * as claude from 'harness-dsl/claude-code';

const Sections = H.resources('section', ['news', 'sports', 'opinion', 'culture']);

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const merging = H.state('merging', 'active');
const withEditor = H.state('with-editor', 'active');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const stuck = H.state('stuck', 'waiting');

const Draft = H.kind('draft')
  .data(z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    section: Sections.schema,
    editorNotes: z.string().optional(),
  }))
  .states([submitted, reviewing, merging, withEditor, returned, accepted, withdrawn, stuck], {
    initial: 'submitted',
    afterFailure: 'stuck',
  });

const Taste = H.memory('editorial-taste', 'taste');
const FactChecking = H.memory('fact-checking', 'experience');

const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .filter(item => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const tasteLibrary = H.library('editorial-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);
const factLibrary = H.library('fact-checking', FactChecking, jsonl.memory('memory/fact-checking.jsonl')).recall(specificFirst);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const candidates: readonly [Model, Model, Model] = [opus, sonnet, haiku];

function combine(a: Rate, b: Rate): Rate {
  const hits = a.hits + b.hits;
  const samples = a.samples + b.samples;
  return { hits, samples, value: samples === 0 ? null : hits / samples };
}

function actedOnRate(metrics: Metrics, model: Model): Rate {
  const slot = (tag: string, field: string): Rate =>
    metrics.rate({
      among: { entry: 'halt', halt: 'editor', status: 'resolved', tags: { [tag]: model.name } },
      count: { entry: 'halt', halt: 'editor', status: 'resolved', tags: { [tag]: model.name }, decision: { [field]: true } },
      days: 60,
    });
  return combine(slot('reviewer-a-model', 'actedOnA'), slot('reviewer-b-model', 'actedOnB'));
}

function lineup(metrics: Metrics): readonly [Model, Model] {
  const [first, second, challenger] = candidates;
  const a = actedOnRate(metrics, first);
  const b = actedOnRate(metrics, second);
  if (a.samples < 50 || b.samples < 50 || a.value === null || b.value === null) return [first, second];
  return a.value >= b.value ? [first, challenger] : [challenger, second];
}

const reviewerAModel = H.policy.model('reviewer-a-model', choice => lineup(choice.metrics)[0]);
const reviewerBModel = H.policy.model('reviewer-b-model', choice => lineup(choice.metrics)[1]);

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: z.string() }))
  .output(z.object({ critique: z.string(), issues: z.array(z.string()) }))
  .prompt(d => `Critique this ${d.section} draft for the editor.\n\n# ${d.title}\n\n${d.body}`)
  .intents(['read']);

const reviewerA = H.agent('reviewer-a', reviewerRole).model(reviewerAModel).recalls(tasteLibrary, factLibrary);
const reviewerB = H.agent('reviewer-b', reviewerRole).model(reviewerBModel).recalls(tasteLibrary, factLibrary);

const local = shell.local('local', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(i => ['merge-critiques', '--a', i.a, '--b', i.b])
  .on(local)
  .ifInterrupted('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ id: z.string(), body: z.string() }))
  .output(z.object({ repeatMistake: z.object({ text: z.string(), because: z.string() }).nullable() }))
  .argv(i => ['fact-check', '--draft', i.id, '--body', i.body])
  .on(local)
  .ifInterrupted('rerun');

const reviewFlow = H.flow('review').for(Draft).does(async ctx => {
  const d = ctx.unit.data;
  await ctx.move('reviewing');
  const input = { title: d.title, body: d.body, section: d.section };
  const a = await ctx.run(reviewerA, input);
  if (!a.ok) return ctx.fail(a.error);
  const b = await ctx.run(reviewerB, input);
  if (!b.ok) return ctx.fail(b.error);
  ctx.tag({ 'reviewer-a-model': a.model ?? 'unknown', 'reviewer-b-model': b.model ?? 'unknown' });

  const checked = await ctx.run(factCheck, { id: d.id, body: d.body });
  if (!checked.ok) return ctx.fail(checked.error);
  const repeat = checked.value.repeatMistake;
  if (repeat !== null) {
    await ctx.remember(factLibrary, {
      text: repeat.text,
      because: repeat.because,
      when: { kinds: [Draft], roles: [reviewerRole], resources: [Sections.get(d.section)] },
    });
  }

  await ctx.move('merging');
  const merged = await ctx.run(mergeCritiques, { a: a.value.critique, b: b.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);

  await ctx.move('with-editor');
  const verdict = await ctx.halt({
    name: 'editor',
    show: merged.value.merged,
    decision: z.object({
      accept: z.boolean(),
      notes: z.string(),
      actedOnA: z.boolean(),
      actedOnB: z.boolean(),
    }),
  });
  if (verdict.accept) return 'accepted';
  await ctx.update({ editorNotes: verdict.notes });
  return 'returned';
});

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=submitted,resubmitted,withdrawn',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      section: Sections.schema,
      status: z.enum(['submitted', 'resubmitted', 'withdrawn']),
    })),
  }),
  read: body => body.drafts.map((d): SupplyOf<typeof Draft> => {
    if (d.status === 'submitted') return { create: { id: d.id, title: d.title, body: d.body, section: d.section }, key: d.id };
    if (d.status === 'withdrawn') return { update: d.id, state: 'withdrawn' };
    return { update: d.id, patch: { title: d.title, body: d.body }, state: 'submitted' };
  }),
});

const drafts = H.lane('drafts', Draft)
  .handler(reviewFlow)
  .suppliers(cmsPoll)
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'reviewStatus' }))
  .touches(d => [Sections.get(d.section)])
  .wip(3);

const notesBecomeTasteCandidates = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const d = event.unit.data;
  if (d.editorNotes === undefined || d.editorNotes.trim() === '') return [];
  return act.remember(tasteLibrary, {
    text: `When reviewing a ${d.section} draft, check for this: ${d.editorNotes}`,
    because: `the editor returned "${d.title}" with this note`,
    when: { kinds: [Draft], roles: [reviewerRole], resources: [Sections.get(d.section)] },
    status: 'candidate',
  });
});

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const firstEligible = H.policy.account('first-eligible', choice =>
  choice.accounts.find(a => a.eligible)?.account ?? null
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('content-review.db'))
  .lanes(drafts)
  .pools(H.pool('models', [{ account: api, share: 1 }], firstEligible))
  .triggers(notesBecomeTasteCandidates)
  .scheduler(oldestFirst)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
