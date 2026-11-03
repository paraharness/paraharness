import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, StateOf, EntryFilter, Metrics, Model, ModelPolicy, Rate, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import * as claudeCode from 'harness-dsl/claude-code';

const sections = H.resources('sections', ['news', 'sports', 'opinion', 'culture']);

const Draft = H.kind('draft')
  .data(z.object({
    cmsId: z.string(),
    revision: z.number(),
    title: z.string(),
    body: z.string(),
    section: sections.schema,
    editorNotes: z.string().optional(),
    notesForSectionOnly: z.boolean().optional(),
  }))
  .states({ submitted: 'pending', accepted: 'success', returned: 'neutral' }, 'submitted');

type DraftData = DataOf<typeof Draft>;
type DraftState = StateOf<typeof Draft>;

const cmsDraft = z.object({
  id: z.string(),
  revision: z.number(),
  title: z.string(),
  body: z.string(),
  section: sections.schema,
});
type CmsDraft = z.infer<typeof cmsDraft>;

function fromCms(draft: CmsDraft): Supply<DraftData, DraftState> {
  return {
    create: {
      cmsId: draft.id,
      revision: draft.revision,
      title: draft.title,
      body: draft.body,
      section: draft.section,
    },
    key: `${draft.id}@${draft.revision}`,
  };
}

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=ready-for-review',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(cmsDraft) }),
  read: body => body.drafts.map(fromCms),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/reviews',
  headers: cmsHeaders,
  stateField: 'reviewStatus',
});

const taste = H.memory('taste', 'owner');
const experience = H.memory('fact-checking', 'fallible');

const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 12));

const tasteLibrary = H.library('editor-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);
const factLibrary = H.library('fact-lessons', experience, jsonl.memory('memory/fact-lessons.jsonl')).recall(specificFirst);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({
    report: z.string(),
    repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })),
  }))
  .argv(input => ['fact-check', '--json', JSON.stringify(input)])
  .on(local)
  .restart('rerun');

const critique = z.object({ critique: z.string(), mustFix: z.array(z.string()) });

const critic = H.role('critic')
  .input(z.object({ title: z.string(), body: z.string(), section: sections.schema, factCheck: z.string() }))
  .output(critique)
  .prompt(input => [
    `Critique this ${input.section} draft as the publication's reviewer.`,
    `Title: ${input.title}`,
    input.body,
    `Fact-check report:`,
    input.factCheck,
  ].join('\n\n'));

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique }))
  .output(z.object({ summary: z.string(), mustFix: z.array(z.string()) }))
  .argv(input => ['merge-critiques', '--json', JSON.stringify(input)])
  .on(local)
  .restart('rerun');

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-opus-4-5');

const editorReviews: EntryFilter = { entry: 'halt', halt: 'editor', status: 'resolved' };
const actedOn: Record<'A' | 'B', EntryFilter> = {
  A: { decision: { usedA: true } },
  B: { decision: { usedB: true } },
};
const noSamples: Rate = { value: null, hits: 0, samples: 0 };

function slotRate(metrics: Metrics, slot: 'A' | 'B', model: Model): Rate {
  const bySlotModel = metrics.rateBy({ among: editorReviews, count: actedOn[slot], by: { tag: `model-${slot}` }, days: 90 });
  return bySlotModel[model.name] ?? noSamples;
}

function reviewerModel(slot: 'A' | 'B', incumbent: Model, rival: Model): ModelPolicy {
  const other = slot === 'A' ? 'B' : 'A';
  return H.policy.model(`reviewer-${slot}-model`, ({ metrics }) => {
    const mine = slotRate(metrics, slot, incumbent);
    const theirs = slotRate(metrics, other, rival);
    if (mine.samples < 50 || theirs.samples < 50 || mine.value === null || theirs.value === null) return incumbent;
    return mine.value < theirs.value ? challenger : incumbent;
  });
}

const reviewerA = H.agent('reviewer-a', critic)
  .model(reviewerModel('A', opus, sonnet))
  .recalls(tasteLibrary, factLibrary);

const reviewerB = H.agent('reviewer-b', critic)
  .model(reviewerModel('B', sonnet, opus))
  .recalls(tasteLibrary, factLibrary);

const reviewFlow = H.flow('review').for(Draft).does(async ctx => {
  const { title, body, section } = ctx.unit.data;

  const checked = await ctx.run(factCheck, { title, body });
  if (!checked.ok) return ctx.fail(checked.error);
  for (const mistake of checked.value.repeatMistakes) {
    await ctx.remember(factLibrary, {
      text: mistake.lesson,
      because: mistake.because,
      when: { kinds: [Draft], roles: [critic] },
    });
  }

  const input = { title, body, section, factCheck: checked.value.report };
  const a = await ctx.run(reviewerA, input);
  if (!a.ok) return ctx.fail(a.error);
  const b = await ctx.run(reviewerB, input);
  if (!b.ok) return ctx.fail(b.error);
  ctx.tag({ 'model-A': a.model ?? 'unknown', 'model-B': b.model ?? 'unknown' });

  const merged = await ctx.run(mergeCritiques, { a: a.value, b: b.value });
  if (!merged.ok) return ctx.fail(merged.error);

  const editor = await ctx.halt({
    name: 'editor',
    show: [
      merged.value.summary,
      `Must fix: ${merged.value.mustFix.join('; ')}`,
      `Reviewer A: ${a.value.critique}`,
      `Reviewer B: ${b.value.critique}`,
    ].join('\n\n'),
    decision: z.object({
      accept: z.boolean(),
      usedA: z.boolean(),
      usedB: z.boolean(),
      notes: z.string(),
      notesForSectionOnly: z.boolean(),
    }),
  });

  if (editor.accept) return 'accepted';
  await ctx.update({ editorNotes: editor.notes, notesForSectionOnly: editor.notesForSectionOnly });
  return 'returned';
});

const drafts = H.lane('drafts', Draft)
  .handler(reviewFlow)
  .suppliers(cmsPoll)
  .store(cmsStore)
  .wip(3)
  .touches(data => [sections.of(data.section)]);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  if (!notes) return [];
  return act.remember(tasteLibrary, {
    text: notes,
    because: `the editor returned ${event.unit.key} with these notes`,
    status: 'candidate',
    when: event.unit.data.notesForSectionOnly
      ? { kinds: [Draft], resources: [sections.of(event.unit.data.section)] }
      : { kinds: [Draft] },
  });
});

const api = anthropic.account('publication-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('quota.db'),
});

const pool = H.pool('api', [{ account: api, share: 1 }], H.policy.account('only-api', choice =>
  choice.accounts.find(view => view.eligible)?.account ?? null));

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('content-review.db'))
  .lanes(drafts)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .scheduler(H.policy.scheduler('oldest-first', view => ({
    start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
  })))
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
