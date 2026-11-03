import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Submitted = H.state('submitted', 'pending');
const Returned = H.state('returned', 'waiting');
const Accepted = H.state('accepted', 'terminal', 'success');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('draft')
  .data(z.object({
    title: z.string(),
    body: z.string(),
    section: z.string(),
    editorNotes: z.array(z.string()).optional(),
  }))
  .states(Submitted, Returned, Accepted, Withdrawn);

const taste = H.library('editor-taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const factLessons = H.library('fact-check-lessons', H.memory('fact-checking', 'experience'), jsonl.memory('memory/fact-checks.jsonl'));

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };
const cmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  section: z.string(),
  status: z.enum(['submitted', 'resubmitted', 'withdrawn']),
});
type CmsDraft = z.infer<typeof cmsDraft>;

function supplyDraft(draft: CmsDraft): SupplyOf<typeof Draft> {
  const data = { title: draft.title, body: draft.body, section: draft.section };
  if (draft.status === 'resubmitted') return { update: draft.id, patch: data, state: 'submitted' };
  if (draft.status === 'withdrawn') return { update: draft.id, state: 'withdrawn' };
  return { create: data, key: draft.id };
}

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?review=pending',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(cmsDraft) }),
  read: body => body.drafts.map(supplyDraft),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_status',
});

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');
const candidates: readonly Model[] = [sonnet, opus, haiku];

const editorReview = H.decision('editor-review')
  .input(z.object({
    title: z.string(),
    section: z.string(),
    merged: z.string(),
    firstModel: z.string(),
    secondModel: z.string(),
  }))
  .output(z.object({
    accept: z.boolean(),
    notes: z.array(z.string()),
    actedOnFirst: z.boolean(),
    actedOnSecond: z.boolean(),
  }))
  .show(input => `${input.title} (${input.section})\n\n${input.merged}`);

const noSamples: Rate = { value: null, hits: 0, samples: 0 };
const swapAfterSamples = 50;

function actedOnRate(metrics: Metrics, model: Model): Rate {
  const among = editorReview.resolved(undefined, 'human');
  const asFirst = metrics.rateBy({
    among,
    count: editorReview.resolved({ actedOnFirst: true }, 'human'),
    by: H.by.input(editorReview, 'firstModel'),
    days: 90,
  })[model.name] ?? noSamples;
  const asSecond = metrics.rateBy({
    among,
    count: editorReview.resolved({ actedOnSecond: true }, 'human'),
    by: H.by.input(editorReview, 'secondModel'),
    days: 90,
  })[model.name] ?? noSamples;
  const hits = asFirst.hits + asSecond.hits;
  const samples = asFirst.samples + asSecond.samples;
  return { value: samples === 0 ? null : hits / samples, hits, samples };
}

function lineup(metrics: Metrics): readonly [Model, Model] {
  const tried = candidates.map(model => ({ model, rate: actedOnRate(metrics, model) }));
  const proven = tried
    .filter(entry => entry.rate.samples >= swapAfterSamples)
    .sort((a, b) => (b.rate.value ?? 0) - (a.rate.value ?? 0));
  const unproven = tried.filter(entry => entry.rate.samples < swapAfterSamples);
  const [first = sonnet, second = opus] = [...proven.slice(0, 1), ...unproven, ...proven.slice(1)].map(entry => entry.model);
  return [first, second];
}

const firstReviewerModel = H.policy.model('first-reviewer-model', choice => lineup(choice.metrics)[0]);
const secondReviewerModel = H.policy.model('second-reviewer-model', choice => lineup(choice.metrics)[1]);

const reviewer = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft as the editor would.\n\n# ${input.title}\n\n${input.body}`)
  .intents(['read']);

const firstReviewer = H.agent('first-reviewer', reviewer).model(firstReviewerModel).recalls(taste, factLessons);
const secondReviewer = H.agent('second-reviewer', reviewer).model(secondReviewerModel).recalls(taste, factLessons);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(input => ['fact-check', '--report-repeats', '--text', input.body])
  .on(local)
  .recover('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.first, '--second', input.second])
  .on(local)
  .recover('rerun');

const reviewDraft = H.flow('review-draft').for(Draft).does(async ctx => {
  const { title, body, section } = ctx.unit.data;
  const options = { scope: { resources: [`section/${section}`] } };
  const first = await ctx.run(firstReviewer, { title, body, section }, options);
  if (first.ok === false) return ctx.fail(first.error);
  const second = await ctx.run(secondReviewer, { title, body, section }, options);
  if (second.ok === false) return ctx.fail(second.error);

  const checked = await ctx.run(factCheck, { body });
  if (checked.ok === false) return ctx.fail(checked.error);
  for (const repeat of checked.value.repeats) {
    await ctx.remember(factLessons, {
      text: repeat.lesson,
      because: repeat.because,
      when: { roles: [reviewer.name] },
      status: 'accepted',
    });
  }

  const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
  if (merged.ok === false) return ctx.fail(merged.error);

  const verdict = await ctx.decide(editorReview, {
    title,
    section,
    merged: merged.value.merged,
    firstModel: first.model ?? 'unknown',
    secondModel: second.model ?? 'unknown',
  });
  if (verdict.accept) return 'accepted';
  await ctx.update({ editorNotes: verdict.notes });
  return 'returned';
});

const drafts = H.lane('drafts', Draft)
  .handler(reviewDraft)
  .suppliers(cmsPoll)
  .store(cmsStore);

const notesBecomeTaste = H.trigger(
  'returned-notes-become-taste',
  H.on.enters(Draft, 'returned'),
  (event, act) => (event.unit.data.editorNotes ?? []).map(note => act.remember(taste, {
    text: `When reviewing ${event.unit.data.section} drafts: ${note}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { kinds: [Draft.name], resources: [`section/${event.unit.data.section}`] },
    status: 'candidate',
  })),
);

export const running = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.db'))
  .pools(H.pool('anthropic', [{ account: api, share: 1 }]))
  .lanes(drafts)
  .triggers(notesBecomeTaste)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.resolveDecisions,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'))
  .start();
