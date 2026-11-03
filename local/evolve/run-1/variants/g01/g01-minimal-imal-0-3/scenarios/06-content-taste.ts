import { z } from 'zod';
import { H } from 'harness-dsl';
import type { DataOf, StateOf, EntryFilter, Metrics, Model, Rate, Supply } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const queued = H.state('queued', 'pending');
const reviewing = H.state('reviewing', 'active');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('Draft')
  .data(z.object({
    cmsId: z.string(),
    title: z.string(),
    section: z.string(),
    body: z.string(),
    notes: z.string(),
  }))
  .states([queued, reviewing, accepted, returned, failed, withdrawn], {
    initial: 'queued',
    afterFailure: 'failed',
    afterCancel: 'withdrawn',
  });

type DraftSupply = Supply<DataOf<typeof Draft>, StateOf<typeof Draft>>;

const cmsHeaders = { 'X-Api-Key': H.env('CMS_API_KEY') };

const cmsDrafts = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=ready,resubmitted',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      section: z.string(),
      body: z.string(),
      status: z.enum(['ready', 'resubmitted']),
    })),
  }),
  read: body => body.drafts.map((d): DraftSupply =>
    d.status === 'ready'
      ? { create: { cmsId: d.id, title: d.title, section: d.section, body: d.body, notes: '' }, key: d.id }
      : { update: d.id, patch: { body: d.body, notes: '' }, state: 'queued' }
  ),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const editorTaste = H.library('editor-taste', taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);
const factCheckingLessons = H.library('fact-checking-lessons', experience, jsonl.memory('memory/fact-checking.jsonl')).recall(specificFirst);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const reviewerCandidates: readonly Model[] = [opus, sonnet, haiku];

function actedOnByModel(metrics: Metrics): Readonly<Record<string, Rate>> {
  const editorActions: EntryFilter = { entry: 'transition', kind: 'Draft', state: ['accepted', 'returned'] };
  const first = metrics.rateBy({
    among: editorActions,
    count: { ...editorActions, tags: { firstActedOn: 'yes' } },
    by: { tag: 'firstModel' },
    days: 90,
  });
  const second = metrics.rateBy({
    among: editorActions,
    count: { ...editorActions, tags: { secondActedOn: 'yes' } },
    by: { tag: 'secondModel' },
    days: 90,
  });
  const combined: Record<string, Rate> = {};
  for (const [model, rate] of [...Object.entries(first), ...Object.entries(second)]) {
    const prior = combined[model];
    const hits = (prior?.hits ?? 0) + rate.hits;
    const samples = (prior?.samples ?? 0) + rate.samples;
    combined[model] = { value: samples === 0 ? null : hits / samples, hits, samples };
  }
  return combined;
}

const reviewerPair = H.policy.model('reviewer-pair-swaps-weaker-after-50', choice => {
  const rates = actedOnByModel(choice.metrics);
  const samplesOf = (m: Model) => rates[m.name]?.samples ?? 0;
  const valueOf = (m: Model) => rates[m.name]?.value ?? 0;
  const proven = reviewerCandidates.filter(m => samplesOf(m) >= 50).sort((a, b) => valueOf(b) - valueOf(a));
  const unproven = reviewerCandidates.filter(m => samplesOf(m) < 50);
  const pair = proven.length < 2
    ? [...proven, ...unproven].slice(0, 2)
    : [proven[0] ?? opus, unproven[0] ?? proven[1] ?? sonnet];
  return choice.agent === 'first-reviewer' ? pair[0] ?? opus : pair[1] ?? sonnet;
});

const critique = z.object({ critique: z.string(), issues: z.array(z.string()) });

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(critique)
  .prompt(d => `Critique the ${d.section} draft "${d.title}" against the editor's taste.\n\n${d.body}`)
  .intents(['read']);

const firstReviewer = H.agent('first-reviewer', reviewerRole).model(reviewerPair).recalls(editorTaste, factCheckingLessons);
const secondReviewer = H.agent('second-reviewer', reviewerRole).model(reviewerPair).recalls(editorTaste, factCheckingLessons);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ cmsId: z.string(), body: z.string() }))
  .output(z.object({
    problems: z.array(z.string()),
    repeatMistake: z.object({ lesson: z.string(), because: z.string() }).nullable(),
  }))
  .argv(d => ['fact-check', '--draft', d.cmsId])
  .on(local)
  .restart('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: critique, second: critique, factProblems: z.array(z.string()) }))
  .argv(d => ['merge-critiques', JSON.stringify(d)])
  .on(local)
  .restart('rerun');

const EditorDecision = z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnFirst: z.boolean(),
  actedOnSecond: z.boolean(),
});

const reviewFlow = H.flow('review-draft').for(Draft).does(async ctx => {
  const draft = ctx.unit.data;
  await ctx.move('reviewing');
  const input = { title: draft.title, section: draft.section, body: draft.body };
  const scope = { resources: [`section:${draft.section}`] };
  const first = await ctx.run(firstReviewer, input, { scope });
  if (!first.ok) return ctx.fail(first.error);
  const second = await ctx.run(secondReviewer, input, { scope });
  if (!second.ok) return ctx.fail(second.error);
  const facts = await ctx.run(factCheck, { cmsId: draft.cmsId, body: draft.body });
  if (!facts.ok) return ctx.fail(facts.error);
  const repeat = facts.value.repeatMistake;
  if (repeat) {
    await ctx.remember(factCheckingLessons, {
      text: repeat.lesson,
      because: repeat.because,
      when: { kinds: ['Draft'], roles: ['reviewer'] },
    });
  }
  const merged = await ctx.run(mergeCritiques, { first: first.value, second: second.value, factProblems: facts.value.problems });
  if (!merged.ok) return ctx.fail(merged.error);
  const decision = await ctx.halt({ name: 'editor-decision', show: merged.value, decision: EditorDecision });
  ctx.tag({
    firstModel: first.model ?? 'unknown',
    secondModel: second.model ?? 'unknown',
    firstActedOn: decision.actedOnFirst ? 'yes' : 'no',
    secondActedOn: decision.actedOnSecond ? 'yes' : 'no',
  });
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ notes: decision.notes });
  return 'returned';
});

const draftLane = H.lane('drafts', Draft)
  .handler(reviewFlow)
  .suppliers(cmsDrafts)
  .store(cmsStore)
  .wip(3);

const returnedNotesBecomeTasteCandidates = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(Draft, 'returned'),
  (event, act) => event.unit.data.notes.trim() === ''
    ? []
    : act.remember(editorTaste, {
        text: event.unit.data.notes,
        because: `the editor returned "${event.unit.data.title}" with these notes`,
        when: { kinds: ['Draft'], resources: [`section:${event.unit.data.section}`] },
        status: 'candidate',
      })
);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(a => a.eligible)?.account ?? null);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('content-review.db'))
  .lanes(draftLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }], firstEligible))
  .triggers(returnedNotesBecomeTasteCandidates)
  .scheduler(H.policy.scheduler('oldest-first', view => ({
    start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
