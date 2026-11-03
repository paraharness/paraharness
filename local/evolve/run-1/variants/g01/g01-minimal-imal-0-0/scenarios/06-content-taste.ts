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

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const returned = H.state('returned', 'waiting');
const stalled = H.state('stalled', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('Draft')
  .data(z.object({
    id: z.string(),
    section: z.string(),
    title: z.string(),
    body: z.string(),
    editorNotes: z.array(z.string()),
  }))
  .states([submitted, reviewing, returned, stalled, accepted, withdrawn], { initial: 'submitted', afterFailure: 'stalled' });

const taste = H.memory('taste', 'owner');
const experience = H.memory('fact-check-experience', 'fallible');

const sectionFirst = H.policy.recall('section-first', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .filter(item => (item.when.resources ?? []).every(r => view.scope.resources.includes(r)))
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 20));

const tasteLibrary = H.library('editor-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(sectionFirst);
const factLessons = H.library('fact-lessons', experience, jsonl.memory('memory/fact-lessons.jsonl')).recall(sectionFirst);

const critic = H.role('critic')
  .input(z.object({ title: z.string(), body: z.string(), section: z.string() }))
  .output(z.object({ critique: z.string(), points: z.array(z.string()) }))
  .prompt(i => `Critique the ${i.section} draft "${i.title}" for the editor.\n\n${i.body}`)
  .intents(['read']);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-opus-4');

type Slot = 'first' | 'second';

function actedOn(metrics: Metrics, slot: Slot, model: Model): Rate {
  const decided = { entry: 'halt' as const, halt: 'editor', status: 'resolved', tags: { [slot]: model.name } };
  return metrics.rate({
    among: decided,
    count: { ...decided, decision: slot === 'first' ? { actedOnFirst: true } : { actedOnSecond: true } },
  });
}

function pickFor(metrics: Metrics, slot: Slot): Model {
  const mine = slot === 'first' ? opus : sonnet;
  const rivalModel = slot === 'first' ? sonnet : opus;
  const self = actedOn(metrics, slot, mine);
  const rival = actedOn(metrics, slot === 'first' ? 'second' : 'first', rivalModel);
  const enough = self.samples >= 50 && rival.samples >= 50;
  if (enough && self.value !== null && rival.value !== null && self.value < rival.value) return challenger;
  return mine;
}

const firstReviewerModel = H.policy.model('first-reviewer-model', c => pickFor(c.metrics, 'first'));
const secondReviewerModel = H.policy.model('second-reviewer-model', c => pickFor(c.metrics, 'second'));

const firstReviewer = H.agent('first-reviewer', critic).model(firstReviewerModel).recalls(tasteLibrary, factLessons);
const secondReviewer = H.agent('second-reviewer', critic).model(secondReviewerModel).recalls(tasteLibrary, factLessons);

const local = shell.local('local', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(i => ['merge-critiques', JSON.stringify(i)])
  .on(local)
  .onCrash('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ section: z.string(), body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ rule: z.string(), because: z.string() })) }))
  .argv(i => ['fact-check', '--section', i.section, JSON.stringify(i)])
  .on(local)
  .onCrash('rerun');

const reviewDraft = H.flow('review-draft').for(Draft).does(async ctx => {
  const draft = ctx.unit.data;
  await ctx.move('reviewing');
  const input = { title: draft.title, body: draft.body, section: draft.section };
  const scope = { resources: [`section:${draft.section}`] };
  const first = await ctx.run(firstReviewer, input, { scope });
  if (!first.ok) return ctx.fail(first.error);
  const second = await ctx.run(secondReviewer, input, { scope });
  if (!second.ok) return ctx.fail(second.error);
  ctx.tag({ first: first.model ?? 'unknown', second: second.model ?? 'unknown' });

  const facts = await ctx.run(factCheck, { section: draft.section, body: draft.body });
  if (facts.ok) {
    for (const lesson of facts.value.repeatMistakes) {
      await ctx.remember(factLessons, {
        text: lesson.rule,
        because: lesson.because,
        when: { kinds: ['Draft'], roles: ['critic'] },
        status: 'candidate',
      });
    }
  }

  const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);

  const editor = await ctx.halt({
    name: 'editor',
    show: merged.value.merged,
    decision: z.object({
      action: z.enum(['accept', 'return']),
      actedOnFirst: z.boolean(),
      actedOnSecond: z.boolean(),
      notes: z.array(z.string()),
    }),
  });
  if (editor.action === 'accept') return 'accepted';
  await ctx.update({ editorNotes: editor.notes });
  return 'returned';
});

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=in-review,resubmitted',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      section: z.string(),
      title: z.string(),
      body: z.string(),
      status: z.enum(['in-review', 'resubmitted']),
    })),
  }),
  read: b => b.drafts.map(d => d.status === 'resubmitted'
    ? { update: d.id, patch: { body: d.body, title: d.title, editorNotes: [] }, state: 'submitted' }
    : { create: { id: d.id, section: d.section, title: d.title, body: d.body, editorNotes: [] }, key: d.id }),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'reviewStatus',
});

const drafts = H.lane('drafts', Draft).handler(reviewDraft).suppliers(cmsPoll).store(cmsStore).wip(3);

const notesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) =>
  event.unit.data.editorNotes.map(note => act.remember(tasteLibrary, {
    text: note,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { kinds: ['Draft'], resources: [`section:${event.unit.data.section}`] },
    status: 'candidate',
  })));

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api', [{ account: api, share: 1 }],
  H.policy.account('provider-match', c => c.accounts.find(a => a.eligible && a.account.provider === c.model.provider)?.account ?? null));

const oldestFirst = H.policy.scheduler('oldest-first', v => ({
  start: [...v.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const editorDesk = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.db'))
  .lanes(drafts)
  .pools(pool)
  .triggers(notesBecomeTaste)
  .scheduler(oldestFirst)
  .clients(editorDesk)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
