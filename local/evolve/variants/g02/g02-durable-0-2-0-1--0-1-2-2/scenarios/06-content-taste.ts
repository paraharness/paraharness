import { z } from 'zod';
import { H, LineupCtx, Assignment } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sections = H.resources('section', ['sports', 'opinion', 'news', 'culture']);

const InReview = H.state('InReview', 'pending');
const ReviewStalled = H.state('ReviewStalled', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'failure');

const draftAttrs = z.object({ entryId: z.string(), title: z.string(), section: sections.schema, body: z.string() });

const draftKind = H.kind('Draft')
  .attributes(draftAttrs)
  .states(InReview, ReviewStalled, Accepted, Returned)
  .key(a => a.entryId)
  .initial(InReview);

const editorial = H.halt('editorial-decision').decision(z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.enum(['a', 'b', 'both', 'neither']),
}));

const quota = sqlite.quota('anthropic-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('review-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const reviewPool = H.pool('review').accounts(apiAccount);

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const reviewerModels = [opus, sonnet, haiku];

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for the editor: structure, accuracy, tone. List concrete issues.');

function chooseReviewerModels(ctx: LineupCtx): readonly Assignment[] {
  const current: readonly Assignment[] = ctx.seats.map(seat => ({
    seat,
    model: ctx.current(seat) ?? (seat === reviewerA ? opus : sonnet),
  }));
  const scored = current.map(assignment => ({
    seat: assignment.seat,
    rate: ctx.metrics.rate(actedOn, { seat: assignment.seat, model: assignment.model, window: { lastDays: 90 } }),
  }));
  const ready = scored.filter(s => s.rate.samples >= 50);
  if (ready.length === 0 || ready.length < scored.length) return current;
  const weakest = ready.reduce((w, s) => (s.rate.rate < w.rate.rate ? s : w));
  const spare = reviewerModels.find(model => current.every(assignment => assignment.model !== model));
  if (spare === undefined) return current;
  return current.map(assignment => (assignment.seat === weakest.seat ? { seat: assignment.seat, model: spare } : assignment));
}

const reviewerLineup = H.policy.lineup('reviewer-lineup', reviewerModels, chooseReviewerModels);

const critique = z.object({ critique: z.string(), issues: z.array(z.string()) });

const reviewerA = H.seat('reviewer-a')
  .role(reviewerRole)
  .model(reviewerLineup)
  .pool(reviewPool)
  .output(critique);

const reviewerB = H.seat('reviewer-b')
  .role(reviewerRole)
  .model(reviewerLineup)
  .pool(reviewPool)
  .output(critique);

const taste = H.journal('editor-taste', H.memory('editor-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(reviewerRole);

const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/memory/fact-checks.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const localRunner = local.runner('local');

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(i => ['./bin/fact-check', i.entryId, i.body])
  .output(z.object({ findings: z.array(z.string()), repeatLesson: z.string().nullable() }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(i => ['./bin/merge-critiques', i.a, i.b])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const review = H.flow('review-draft')
  .input(draftAttrs)
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('reviewA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}".\nFact-check findings:\n${ctx.steps.factCheck.findings.join('\n')}\n\n${ctx.unit.attributes.body}`,
    resources: [sections.get(ctx.unit.attributes.section)],
  }))
  .step('reviewB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}".\nFact-check findings:\n${ctx.steps.factCheck.findings.join('\n')}\n\n${ctx.unit.attributes.body}`,
    resources: [sections.get(ctx.unit.attributes.section)],
  }))
  .step('merge', mergeCritiques, ctx => ({
    a: JSON.stringify(ctx.steps.reviewA),
    b: JSON.stringify(ctx.steps.reviewB),
  }))
  .halt('editorial', editorial, {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', ctx => ctx.steps.editorial.verdict === 'accept')
  .exit('returned');

const drafts = H.lane('drafts', draftKind)
  .supply(contentful.drafts({ space: 'publication', token: H.env('CONTENTFUL_TOKEN'), everyMinutes: 10 }), (entry, to) => {
    const section = sections.schema.safeParse(entry.section);
    return section.success
      ? to.create({ entryId: entry.id, title: entry.title, section: section.data, body: entry.body })
      : to.skip();
  })
  .handler(review, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store({ space: 'publication', token: H.env('CONTENTFUL_TOKEN') }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: ReviewStalled });

const actedOn = H.metric('critique-acted-on', H.when.decision(draftKind, editorial))
  .samples(e => [
    {
      hit: e.decision.actedOn === 'a' || e.decision.actedOn === 'both',
      seat: reviewerA,
      model: e.modelOf(reviewerA),
    },
    {
      hit: e.decision.actedOn === 'b' || e.decision.actedOn === 'both',
      seat: reviewerB,
      model: e.modelOf(reviewerB),
    },
  ]);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.decision(draftKind, editorial))
  .record(taste, e => e.decision.verdict === 'return'
    ? {
        text: e.decision.notes,
        when: { roles: [reviewerRole], resources: [sections.get(e.unit.attributes.section)] },
        status: 'candidate',
      }
    : undefined);

const repeatMistakeBecomesLesson = H.trigger('repeat-mistake-becomes-lesson')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factLessons, e => {
    const lesson = e.output?.repeatLesson;
    return lesson === undefined || lesson === null
      ? undefined
      : { text: lesson, when: { roles: [reviewerRole] }, status: 'active' };
  });

const editorDesk = claudeCode.supervisor('editor-desk', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorial),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(drafts)
  .journals(taste, factLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakeBecomesLesson)
  .metrics(actedOn)
  .scheduler(H.scheduler('content').standard(drafts))
  .clients(editorDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
