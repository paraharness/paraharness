import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, Rate, Resource } from 'harness-dsl';
import type { EntryFilter } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
type Section = z.infer<typeof sectionSchema>;

const sportsSection = H.resource('sports');
const opinionSection = H.resource('opinion');
const sectionScope: Record<Section, readonly Resource[]> = {
  news: [],
  sports: [sportsSection],
  opinion: [opinionSection],
  culture: [],
};

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', { terminal: 'success' });
const withdrawn = H.state('withdrawn', { terminal: 'neutral' });

const Draft = H.kind('draft')
  .data(z.object({
    title: z.string(),
    body: z.string(),
    section: sectionSchema,
    notes: z.array(z.string()),
  }))
  .states([submitted, returned, accepted, withdrawn], 'submitted');

const taste = H.memory('editorial-taste', 'owner');
const factLesson = H.memory('fact-checking-lesson', 'fallible');

const mostSpecificFirst = H.policy.recall('most-specific-first', view =>
  [...view.items]
    .filter(item => item.status === 'accepted')
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 15));

const tasteLibrary = H.library('editor-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(mostSpecificFirst);
const factLibrary = H.library('fact-checking', factLesson, jsonl.memory('memory/fact-checking.jsonl')).recall(mostSpecificFirst);

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const challenger = anthropic.model('claude-haiku-4-5');

type Slot = 'a' | 'b';
const incumbents: Record<Slot, Model> = { a: sonnet, b: opus };
const rivalOf: Record<Slot, Slot> = { a: 'b', b: 'a' };
const usedKey: Record<Slot, string> = { a: 'usedA', b: 'usedB' };

function actedOnRate(metrics: Metrics, slot: Slot, model: Model): Rate {
  const decided: EntryFilter = {
    entry: 'halt',
    halt: 'editor-review',
    status: 'resolved',
    tags: { [`model-${slot}`]: model.name },
  };
  return metrics.rate({ among: decided, count: { ...decided, decision: { [usedKey[slot]]: true } }, days: 60 });
}

function reviewerModel(slot: Slot) {
  return H.policy.model(`reviewer-${slot}-model`, choice => {
    const own = actedOnRate(choice.metrics, slot, incumbents[slot]);
    const rival = actedOnRate(choice.metrics, rivalOf[slot], incumbents[rivalOf[slot]]);
    if (own.samples < 50 || rival.samples < 50 || own.value === null || rival.value === null) return incumbents[slot];
    return own.value < rival.value ? challenger : incumbents[slot];
  });
}

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sectionSchema }))
  .output(z.object({ critique: z.string() }))
  .prompt(draft => `Critique this ${draft.section} draft for the editor.\n\nTitle: ${draft.title}\n\n${draft.body}`)
  .intents(['read']);

const reviewerA = H.agent('reviewer-a', reviewerRole).model(reviewerModel('a')).recalls(tasteLibrary, factLibrary);
const reviewerB = H.agent('reviewer-b', reviewerRole).model(reviewerModel('b')).recalls(tasteLibrary, factLibrary);

const local = shell.local('newsroom-box', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(input => ['fact-check', '--text', input.body])
  .on(local)
  .restart('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(input => ['merge-critiques', input.first, input.second])
  .on(local)
  .restart('rerun');

const editorDecision = z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.array(z.string()),
  usedA: z.boolean(),
  usedB: z.boolean(),
});

const reviewDraft = H.flow('review-draft').for(Draft).does(async ctx => {
  const draft = ctx.unit.data;
  const input = { title: draft.title, body: draft.body, section: draft.section };
  const scope = { resources: sectionScope[draft.section] };

  const first = await ctx.run(reviewerA, input, { scope });
  if (first.ok === false) return ctx.fail(first.error);
  const second = await ctx.run(reviewerB, input, { scope });
  if (second.ok === false) return ctx.fail(second.error);

  const checked = await ctx.run(factCheck, { body: draft.body });
  if (checked.ok === false) return ctx.fail(checked.error);
  for (const repeat of checked.value.repeats) {
    await ctx.remember(factLibrary, {
      text: repeat.lesson,
      because: repeat.because,
      when: { kinds: [Draft], roles: [reviewerRole] },
      status: 'accepted',
    });
  }

  const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
  if (merged.ok === false) return ctx.fail(merged.error);

  ctx.tag({ 'model-a': first.model ?? 'unknown', 'model-b': second.model ?? 'unknown', section: draft.section });
  const decision = await ctx.halt({ name: 'editor-review', show: merged.value.merged, decision: editorDecision });
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ notes: decision.notes });
  return 'returned';
});

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=in-review',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({ id: z.string(), title: z.string(), body: z.string(), section: sectionSchema })),
  }),
  read: body => body.drafts.map(d => ({
    create: { title: d.title, body: d.body, section: d.section, notes: [] },
    key: d.id,
  })),
});

const drafts = H.lane('drafts', Draft)
  .handler(reviewDraft)
  .suppliers(cmsPoll)
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'reviewStatus' }))
  .wip(3);

const notesBecomeTasteCandidates = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(Draft, 'returned'),
  (event, act) => event.unit.data.notes.map(note => act.remember(tasteLibrary, {
    text: `When reviewing a ${event.unit.data.section} draft, check this: ${note}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { kinds: [Draft], roles: [reviewerRole], resources: sectionScope[event.unit.data.section] },
    status: 'candidate',
  })),
);

const newsroomApi = anthropic.account('newsroom-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const firstEligible = H.policy.account('first-eligible', choice => {
  const [first] = choice.accounts.filter(view => view.eligible);
  return first ? first.account : null;
});

const newsroom = H.pool('newsroom', [{ account: newsroomApi, share: 1 }], firstEligible);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

const editorDesk = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('content-review.db'))
  .lanes(drafts)
  .pools(newsroom)
  .triggers(notesBecomeTasteCandidates)
  .scheduler(oldestFirst)
  .clients(editorDesk)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
