import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, ModelPolicy, Rate, SeatRef, SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const sectionFacet = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const stuck = H.state('stuck', 'terminal', 'failure');

const Draft = H.kind('Draft')
  .data(z.object({
    title: z.string(),
    body: z.string(),
    section: sections,
    editorNotes: z.string().optional(),
  }))
  .states(submitted, returned, accepted, stuck);

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sections }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft as the editor would.\n\n# ${input.title}\n\n${input.body}`);

const opusA = anthropic.model('claude-opus-4-1');
const opusB = anthropic.model('claude-opus-4');
const sonnetA = anthropic.model('claude-sonnet-4-5');
const sonnetB = anthropic.model('claude-sonnet-4');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1, serves: [opusA, opusB, sonnetA, sonnetB] }]);

const taste = H.journal('editorTaste', H.memory('editorTaste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const factLessons = H.journal('factLessons', H.memory('factLessons', 'experience'), jsonl.memory('memory/facts.jsonl'));

function actedOnRate(metrics: Metrics, seat: SeatRef): Rate {
  return metrics.rate({ among: editorial.resolved(), count: { ...editorial.resolved(), seat }, days: 90 });
}

function swapIfWeaker(metrics: Metrics, own: SeatRef, other: SeatRef, primary: Model, spare: Model): Model {
  const mine = metrics.rateBy({
    among: editorial.resolved(),
    count: { ...editorial.resolved(), seat: own },
    by: { modelOf: own },
    days: 90,
  }).of(primary);
  const theirs = actedOnRate(metrics, other);
  if (mine.samples < 50 || theirs.samples < 50) return primary;
  return (mine.value ?? 0) < (theirs.value ?? 0) ? spare : primary;
}

const reviewerAModel: ModelPolicy = H.policy.model('reviewerAModel', [opusA, opusB], choice =>
  swapIfWeaker(choice.metrics, reviewerA, reviewerB, opusA, opusB));
const reviewerBModel: ModelPolicy = H.policy.model('reviewerBModel', [sonnetA, sonnetB], choice =>
  swapIfWeaker(choice.metrics, reviewerB, reviewerA, sonnetA, sonnetB));

const reviewerA = H.seat('reviewerA', reviewerRole).model(reviewerAModel).recalls(taste, factLessons);
const reviewerB = H.seat('reviewerB', reviewerRole).model(reviewerBModel).recalls(taste, factLessons);

const editorial = H.halt('editorial', z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string().optional(),
  actedOn: z.array(z.enum(['reviewerA', 'reviewerB'])),
})).credits(decision => decision.actedOn.map(reviewer => reviewer === 'reviewerA' ? reviewerA : reviewerB));

const local = shell.local('local', { slots: 2 });

const factCheck = H.command('factCheck')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ mistake: z.string(), lesson: z.string() })) }))
  .argv(input => ['fact-check', '--text', input.body])
  .on(local)
  .recovery('rerun');

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', '--a', input.first, '--b', input.second])
  .on(local)
  .recovery('rerun');

const review = H.flow('review')
  .for(Draft)
  .does(async ctx => {
    const { title, body, section } = ctx.unit.data;
    const facts = await ctx.run(factCheck, { body });
    if (facts.ok) {
      for (const repeat of facts.value.repeats) {
        await ctx.remember(factLessons, {
          text: `When reviewing a draft, verify ${repeat.mistake}`,
          because: repeat.lesson,
          when: { roles: [reviewerRole] },
        });
      }
    }
    const first = await ctx.run(reviewerA, { title, body, section });
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, { title, body, section });
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorial, merged.value);
    if (decision.action === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes ?? '' });
    return 'returned';
  });

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=ready,revised',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      section: sections,
      status: z.enum(['ready', 'revised']),
    })),
  }),
  read: body => body.drafts.map((draft): SupplyOf<typeof Draft> => draft.status === 'ready'
    ? { create: { title: draft.title, body: draft.body, section: draft.section }, key: draft.id }
    : { update: draft.id, patch: { title: draft.title, body: draft.body }, state: 'submitted' }),
});

const drafts = H.lane('drafts', Draft)
  .handler(review)
  .attempts(2, { backoff: { first: { minutes: 5 } }, exhausted: 'stuck' })
  .suppliers(cmsPoll)
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_state' }))
  .facet(sectionFacet, data => data.section);

const notesBecomeTaste = H.trigger(
  'notesBecomeTaste',
  H.on.enters(Draft, 'returned'),
  (event, act) => act.remember(taste, {
    text: `When reviewing a ${event.unit.data.section} draft, check for what the editor asked: ${event.unit.data.editorNotes ?? ''}`,
    because: `the editor returned "${event.unit.data.title}" with these notes`,
    when: { roles: [reviewerRole], facets: [sectionFacet.of(event.unit.data.section)] },
    status: 'candidate',
  }),
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorial),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(drafts)
  .pools(pool)
  .triggers(notesBecomeTaste)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
