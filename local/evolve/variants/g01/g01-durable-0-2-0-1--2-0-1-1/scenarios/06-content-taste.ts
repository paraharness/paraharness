import { H } from 'harness-dsl';
import type { AgentTask, MetricRef, Model, PolicyCtx, Seat, SeatRef } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const Section = z.enum(['news', 'sports', 'opinion']);
type SectionName = z.infer<typeof Section>;

const sections = {
  news: H.resource('news'),
  sports: H.resource('sports'),
  opinion: H.resource('opinion'),
};

const DraftAttributes = z.object({ entryId: z.string(), title: z.string(), section: Section, body: z.string() });

const Critique = z.object({ critique: z.string(), issues: z.array(z.string()) });
type CritiqueOutput = z.infer<typeof Critique>;

const Submitted = H.state('Submitted', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const WithEditor = H.state('WithEditor', 'waiting');
const ReviewStuck = H.state('ReviewStuck', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Draft = H.kind('Draft')
  .attributes(DraftAttributes)
  .states(Submitted, Reviewing, WithEditor, ReviewStuck, Accepted, Returned, Withdrawn)
  .key(draft => draft.entryId)
  .initial(Submitted);

const apiAccount = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('editorial').accounts(apiAccount);
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft against the publication taste. List concrete issues.');
const editorRole = H.role('editor');

const EditorReview = H.halt('editor-review').decision(
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.enum(['a', 'b', 'both', 'neither']),
    notesApplyTo: z.enum(['all', 'section']),
  }),
);

function chooseReviewerModel(ctx: PolicyCtx, rival: SeatRef, incumbent: Model): Model {
  const own = ctx.metrics.rate(critiqueActedOn, { seat: ctx.seat, model: incumbent, window: { lastDays: 90 } });
  const other = ctx.metrics.rate(critiqueActedOn, { seat: rival, window: { lastDays: 90 } });
  return own.samples >= 50 && other.samples >= 50 && own.rate < other.rate ? challenger : incumbent;
}

const reviewerAModel = H.policy.model('reviewer-a-model', [opus, challenger], ctx => chooseReviewerModel(ctx, reviewerB, opus));
const reviewerBModel = H.policy.model('reviewer-b-model', [sonnet, challenger], ctx => chooseReviewerModel(ctx, reviewerA, sonnet));

const reviewerA: Seat<CritiqueOutput> = H.seat('reviewer-a').role(reviewerRole).model(reviewerAModel).pool(pool).output(Critique);
const reviewerB: Seat<CritiqueOutput> = H.seat('reviewer-b').role(reviewerRole).model(reviewerBModel).pool(pool).output(Critique);

const critiqueActedOn: MetricRef<'rate', never> = H.metric('critique-acted-on', H.when.decision(Draft, EditorReview)).samples(event => [
  {
    seat: reviewerA,
    model: event.seats.find(choice => choice.seat === reviewerA)?.model,
    hit: event.decision.actedOn === 'a' || event.decision.actedOn === 'both',
  },
  {
    seat: reviewerB,
    model: event.seats.find(choice => choice.seat === reviewerB)?.model,
    hit: event.decision.actedOn === 'b' || event.decision.actedOn === 'both',
  },
]);

const editorialRunner = local.runner('editorial').slots(4);

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv(input => ['./editorial/fact-check.sh', input.body])
  .runner(editorialRunner)
  .output(z.object({ repeatMistakes: z.array(z.object({ lesson: z.string(), reason: z.string() })) }));

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['./editorial/merge.sh', input.first, input.second])
  .runner(editorialRunner)
  .output(z.object({ merged: z.string() }));

const reviewTask = (draft: { readonly title: string; readonly section: SectionName; readonly body: string }): AgentTask => ({
  task: `Critique the ${draft.section} draft "${draft.title}":\n\n${draft.body}`,
  resources: [sections[draft.section]],
});

const review = H.flow('review')
  .input(DraftAttributes)
  .step('critiqueA', reviewerA, ctx => reviewTask(ctx.unit.attributes))
  .step('critiqueB', reviewerB, ctx => reviewTask(ctx.unit.attributes))
  .step('factCheck', factCheck, ctx => ({ body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({ first: ctx.steps.critiqueA.critique, second: ctx.steps.critiqueB.critique }))
  .halt('editor', EditorReview, {
    ask: ctx => `Draft "${ctx.unit.attributes.title}" (${ctx.unit.attributes.section}).\n\nCritique A:\n${ctx.steps.critiqueA.critique}\n\nCritique B:\n${ctx.steps.critiqueB.critique}\n\nMerged:\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', ctx => ctx.steps.editor.verdict === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 5 }), (entry, to) => {
    const section = Section.safeParse(entry.section);
    return section.success
      ? to.create({ entryId: entry.id, title: entry.title, section: section.data, body: entry.body })
      : to.skip();
  })
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .handler(review, {
    exits: { accepted: Accepted, returned: Returned },
    during: { critiqueA: Reviewing, critiqueB: Reviewing, factCheck: Reviewing, merge: Reviewing, editor: WithEditor },
    cancelled: Withdrawn,
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 120_000, exhausted: ReviewStuck });

const taste = H.journal('editorial-taste', H.memory('editorial-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factLessons = H.journal('fact-check-lessons', H.memory('fact-check', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/fact-check.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.decision(Draft, EditorReview))
  .record(taste, event =>
    event.decision.verdict === 'return'
      ? {
          text: `When reviewing ${event.decision.notesApplyTo === 'section' ? event.unit.attributes.section : 'any'} drafts, ${event.decision.notes}`,
          status: 'candidate',
          when:
            event.decision.notesApplyTo === 'section'
              ? { roles: [reviewerRole], resources: [sections[event.unit.attributes.section]] }
              : { roles: [reviewerRole], kinds: [Draft] },
        }
      : undefined,
  );

const repeatMistakesBecomeLessons = H.trigger('repeat-mistakes-become-lessons')
  .on(H.when.step(drafts, 'factCheck', { if: event => (event.output?.repeatMistakes.length ?? 0) > 0 }))
  .record(factLessons, event => {
    const mistake = event.output?.repeatMistakes[0];
    return mistake === undefined
      ? undefined
      : { text: `When fact-checking, ${mistake.lesson}, because ${mistake.reason}`, when: { roles: [reviewerRole], kinds: [Draft] } };
  });

const editorDesk = H.client('editor-desk', {
  transport: claudeCode.mcp('editorial-mcp'),
  grants: [
    H.ops.workRead,
    H.ops.workCancel,
    H.ops.resolve(EditorReview),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: './.harness/editorial.db' }))
  .lanes(drafts)
  .journals(taste, factLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakesBecomeLessons)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('editorial').wip(drafts, 3))
  .clients(editorDesk)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

export const supervisor = claudeCode.session('editor', { clients: [editorDesk] });
