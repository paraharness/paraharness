import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, Metrics, Model, Rate, StateOf, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const Section = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.resource('section');

const submitted = H.state.pending('submitted');
const reviewing = H.state.active('reviewing');
const awaitingEditor = H.state.active('awaiting-editor');
const returned = H.state.waiting('returned');
const accepted = H.state.terminal('accepted', 'success');
const withdrawn = H.state.terminal('withdrawn', 'neutral');

const Draft = H.kind('draft')
  .data(z.object({
    id: z.string(),
    title: z.string(),
    section: Section,
    body: z.string(),
    notes: z.string().optional(),
  }))
  .states([submitted, reviewing, awaitingEditor, returned, accepted, withdrawn], 'submitted');

const Taste = H.memory('taste', 'owner');
const FactLesson = H.memory('fact-lesson', 'fallible');

const specificThenProven = H.policy.recall('specific-then-proven', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 15));

const editorTaste = H.library('editor-taste', Taste, jsonl.memory('memory/editor-taste.jsonl')).recall(specificThenProven);
const factLessons = H.library('fact-lessons', FactLesson, jsonl.memory('memory/fact-lessons.jsonl')).recall(specificThenProven);

const reviewer = H.role('reviewer')
  .input(z.object({ title: z.string(), section: Section, body: z.string() }))
  .output(z.object({ critique: z.string(), claims: z.array(z.string()) }))
  .prompt(draft => `Critique this ${draft.section} draft titled "${draft.title}". List every factual claim separately.\n\n${draft.body}`)
  .intents(['read']);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const reviewerCandidates: readonly Model[] = [opus, sonnet, haiku];
const minSamplesPerModel = 50;

function slotRate(metrics: Metrics, slot: 'A' | 'B', model: Model): Rate {
  return metrics.rate({
    among: { entry: 'halt', halt: 'editor-decision', status: 'resolved', tags: { [`model${slot}`]: model.name } },
    count: { decision: { [`used${slot}`]: true } },
    days: 60,
  });
}

function actedOnRate(metrics: Metrics, model: Model): Rate {
  const asA = slotRate(metrics, 'A', model);
  const asB = slotRate(metrics, 'B', model);
  const hits = asA.hits + asB.hits;
  const samples = asA.samples + asB.samples;
  return { value: samples === 0 ? null : hits / samples, hits, samples };
}

function standings(metrics: Metrics): { readonly model: Model; readonly rate: Rate }[] {
  return reviewerCandidates.map(model => ({ model, rate: actedOnRate(metrics, model) }));
}

function incumbent(metrics: Metrics): Model {
  const proven = standings(metrics)
    .filter(entry => entry.rate.samples >= minSamplesPerModel)
    .sort((x, y) => (y.rate.value ?? 0) - (x.rate.value ?? 0));
  const best = proven[0];
  return best ? best.model : opus;
}

function challenger(metrics: Metrics): Model {
  const top = incumbent(metrics);
  const others = standings(metrics).filter(entry => entry.model.name !== top.name);
  const inTrial = others
    .filter(entry => entry.rate.samples < minSamplesPerModel)
    .sort((x, y) => y.rate.samples - x.rate.samples);
  const strongestOther = [...others].sort((x, y) => (y.rate.value ?? 0) - (x.rate.value ?? 0));
  const pick = inTrial[0] ?? strongestOther[0];
  return pick ? pick.model : sonnet;
}

const reviewerA = H.agent('reviewer-a', reviewer)
  .model(H.policy.model('incumbent-reviewer-model', choice => incumbent(choice.metrics)))
  .recalls(editorTaste, factLessons);

const reviewerB = H.agent('reviewer-b', reviewer)
  .model(H.policy.model('challenger-reviewer-model', choice => challenger(choice.metrics)))
  .recalls(editorTaste, factLessons);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ draftId: z.string(), claims: z.array(z.string()) }))
  .output(z.object({
    report: z.string(),
    repeatMistakes: z.array(z.object({ mistake: z.string(), lesson: z.string() })),
  }))
  .argv(input => ['fact-check', '--draft', input.draftId, ...input.claims.flatMap(claim => ['--claim', claim])])
  .on(local)
  .restart('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string(), factReport: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.first, '--second', input.second, '--facts', input.factReport])
  .on(local)
  .restart('rerun');

const reviewDraft = H.flow('review-draft').for(Draft).does(async ctx => {
  const draft = ctx.unit.data;
  const scope = { resources: [section.of(draft.section)] };
  const input = { title: draft.title, section: draft.section, body: draft.body };

  await ctx.move('reviewing');
  const [first, second] = await Promise.all([
    ctx.run(reviewerA, input, { scope }),
    ctx.run(reviewerB, input, { scope }),
  ]);
  if (!first.ok) return ctx.fail(`reviewer-a: ${first.error}`);
  if (!second.ok) return ctx.fail(`reviewer-b: ${second.error}`);
  ctx.tag({ modelA: first.model ?? 'unknown', modelB: second.model ?? 'unknown' });

  const checked = await ctx.run(factCheck, {
    draftId: draft.id,
    claims: [...first.value.claims, ...second.value.claims],
  });
  if (!checked.ok) return ctx.fail(`fact-check: ${checked.error}`);
  for (const repeat of checked.value.repeatMistakes) {
    await ctx.remember(factLessons, {
      text: repeat.lesson,
      because: `the same mistake recurred: ${repeat.mistake}`,
      when: { kinds: [Draft], roles: [reviewer] },
      status: 'candidate',
    });
  }

  const merged = await ctx.run(mergeCritiques, {
    first: first.value.critique,
    second: second.value.critique,
    factReport: checked.value.report,
  });
  if (!merged.ok) return ctx.fail(`merge: ${merged.error}`);

  await ctx.move('awaiting-editor');
  const decision = await ctx.halt({
    name: 'editor-decision',
    show: `${draft.title}\n\n${merged.value.merged}`,
    decision: z.object({
      verdict: z.enum(['accept', 'return']),
      notes: z.string(),
      usedA: z.boolean(),
      usedB: z.boolean(),
    }),
  });
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ notes: decision.notes });
  return ctx.rest('returned');
});

const CmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  section: Section,
  body: z.string(),
  status: z.enum(['ready', 'revised', 'withdrawn']),
});
type CmsDraft = z.infer<typeof CmsDraft>;

function fromCms(draft: CmsDraft): Supply<DataOf<typeof Draft>, StateOf<typeof Draft>> {
  if (draft.status === 'ready') {
    return { create: { id: draft.id, title: draft.title, section: draft.section, body: draft.body }, key: draft.id };
  }
  if (draft.status === 'revised') {
    return { update: draft.id, patch: { title: draft.title, body: draft.body }, state: 'submitted' };
  }
  return { update: draft.id, state: 'withdrawn' };
}

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=ready,revised,withdrawn',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(CmsDraft) }),
  read: body => body.drafts.map(fromCms),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const drafts = H.lane('drafts', Draft)
  .handler(reviewDraft)
  .suppliers(cmsPoll)
  .store(cmsStore)
  .wip(3);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste',
  H.on.enters(Draft, 'returned'),
  (event, act) =>
    (event.unit.data.notes ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => act.remember(editorTaste, {
        text: line,
        because: `the editor returned "${event.unit.data.title}" with this note`,
        when: { kinds: [Draft], roles: [reviewer], resources: [section.of(event.unit.data.section)] },
        status: 'candidate',
      })),
);

const apiPool = H.pool(
  'anthropic-api',
  [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null),
);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

const editorSupervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content-review.db'))
  .lanes(drafts)
  .pools(apiPool)
  .triggers(returnedNotesBecomeTaste)
  .scheduler(oldestFirst)
  .clients(editorSupervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
