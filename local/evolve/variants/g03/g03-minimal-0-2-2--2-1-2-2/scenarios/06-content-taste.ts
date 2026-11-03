import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, ModelRates, ModelPolicy, EntryFilter, SupplyOf } from 'harness-dsl';
import type { SeatRef } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const inReview = H.state('in-review', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const draftKind = H.kind('Draft')
  .data(z.object({
    title: z.string(),
    body: z.string(),
    section: sections,
    editorNotes: z.string().optional(),
  }))
  .states(inReview, returned, accepted, withdrawn, failed);

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sections }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}":\n\n${input.body}`);

const taste = H.memory('editorial-taste', 'taste');
const factChecking = H.memory('fact-checking', 'experience');
const tasteJournal = H.journal('editorial-taste', taste, jsonl.memory('./memory/taste.jsonl'));
const factJournal = H.journal('fact-checking', factChecking, jsonl.memory('./memory/fact-checking.jsonl'));

const apiAccount = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: apiAccount, share: 1 }]);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-opus-4-5');

const editorial = H.halt('editorial-decision', z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
}));

const editorialResolved: EntryFilter = { entry: 'halt', halt: editorial, status: 'resolved', resolver: 'human' };

type ActedOn = 'actedOnA' | 'actedOnB';

const actedOnRates = (metrics: Metrics, seat: SeatRef, flag: ActedOn): ModelRates =>
  metrics.rateBy({
    by: { modelOf: seat },
    among: editorialResolved,
    count: { ...editorialResolved, decision: { [flag]: true } },
    days: 90,
  });

interface ReviewerSlot {
  readonly seat: SeatRef;
  readonly flag: ActedOn;
  readonly incumbent: Model;
}

const swapWeaker = (metrics: Metrics, mine: ReviewerSlot, rival: ReviewerSlot): Model => {
  const own = actedOnRates(metrics, mine.seat, mine.flag).of(mine.incumbent);
  const other = actedOnRates(metrics, rival.seat, rival.flag).of(rival.incumbent);
  if (own.samples < 50 || other.samples < 50) return mine.incumbent;
  return (own.value ?? 0) < (other.value ?? 0) ? challenger : mine.incumbent;
};

const reviewerAModel: ModelPolicy = H.policy.model('reviewer-a-model', [opus, challenger], choice =>
  swapWeaker(
    choice.metrics,
    { seat: reviewerA, flag: 'actedOnA', incumbent: opus },
    { seat: reviewerB, flag: 'actedOnB', incumbent: sonnet },
  ));

const reviewerBModel: ModelPolicy = H.policy.model('reviewer-b-model', [sonnet, challenger], choice =>
  swapWeaker(
    choice.metrics,
    { seat: reviewerB, flag: 'actedOnB', incumbent: sonnet },
    { seat: reviewerA, flag: 'actedOnA', incumbent: opus },
  ));

const reviewerA = H.seat('reviewer-a', reviewerRole).model(reviewerAModel).recalls(tasteJournal, factJournal);
const reviewerB = H.seat('reviewer-b', reviewerRole).model(reviewerBModel).recalls(tasteJournal, factJournal);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ lesson: z.string(), reason: z.string() })) }))
  .argv(input => ['fact-check', '--known-mistakes', '--text', input.body])
  .on(local)
  .recovery('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.a, '--second', input.b])
  .on(local)
  .recovery('rerun');

const review = H.flow('review-draft')
  .for(draftKind)
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    const input = { title, body, section: ctx.unit.data.section };
    const first = await ctx.run(reviewerA, input);
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, input);
    if (!second.ok) return ctx.fail(second.error);
    const checked = await ctx.run(factCheck, { body });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(factJournal, { text: mistake.lesson, because: mistake.reason, when: { kinds: [draftKind] } });
    }
    const merged = await ctx.run(mergeCritiques, { a: first.value.critique, b: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorial, merged.value);
    if (decision.action === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { 'X-Api-Key': H.env('CMS_API_KEY') };

const cmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  section: sections,
  status: z.enum(['submitted', 'resubmitted']),
});
type CmsDraft = z.infer<typeof cmsDraft>;
type DraftSupply = SupplyOf<typeof draftKind>;

const toSupply = (item: CmsDraft): DraftSupply =>
  item.status === 'submitted'
    ? { create: { title: item.title, body: item.body, section: item.section }, key: item.id }
    : { update: item.id, patch: { title: item.title, body: item.body }, state: 'in-review' };

const cmsPoll = http.poll(draftKind, {
  url: 'https://cms.example.com/api/drafts?status=submitted,resubmitted',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(cmsDraft) }),
  read: body => body.drafts.map(toSupply),
});

const drafts = H.lane('drafts', draftKind)
  .handler(review)
  .retry({ times: 1, backoff: { first: { minutes: 10 } }, exhausted: 'failed' })
  .suppliers(cmsPoll)
  .store(http.store(draftKind, {
    url: 'https://cms.example.com/api/drafts',
    headers: cmsHeaders,
    stateField: 'review_state',
  }))
  .facet(section, data => data.section);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(draftKind, 'returned'),
  (event, act) => {
    const notes = event.unit.data.editorNotes;
    if (notes === undefined || notes === '') return [];
    return act.remember(tasteJournal, {
      text: notes,
      because: `the editor returned "${event.unit.data.title}" with these notes`,
      status: 'candidate',
      when: { kinds: [draftKind], roles: [reviewerRole], facets: [section.of(event.unit.data.section)] },
    });
  },
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(editorial, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

const harness = H.harness('content-review')
  .ledger(sqlite.ledger('./.harness/content.sqlite'))
  .lanes(drafts)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .clients(supervisor)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
