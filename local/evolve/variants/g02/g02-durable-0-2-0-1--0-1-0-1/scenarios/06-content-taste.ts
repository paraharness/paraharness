import { z } from 'zod';
import { H, Model, Resource } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const draftSchema = z.object({ entryId: z.string(), title: z.string(), section: z.string(), body: z.string() });

const Submitted = H.state('Submitted', 'pending');
const InReview = H.state('InReview', 'active');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const ReviewFailed = H.terminal('ReviewFailed', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftSchema)
  .states(Submitted, InReview, Accepted, Returned, ReviewFailed)
  .key(a => a.entryId);

const sports = H.resource('sports');
const opinion = H.resource('opinion');
const sectionResources = (section: string): readonly Resource[] =>
  section === 'sports' ? [sports] : section === 'opinion' ? [opinion] : [];

const editorReview = H.halt('editor-review').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string().optional(),
    actedOn: z.array(z.enum(['critiqueA', 'critiqueB'])),
  }),
);

const quota = sqlite.quota('content-accounts', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const pool = H.pool('content-pool').accounts(apiAccount);

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft against the publication taste; be specific and actionable.');
const editorRole = H.role('editor').intents('read', 'record').instructions('Accept or return drafts with notes.');

const taste = H.journal('editorial-taste', H.memory('editorial-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 25 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/fact-checks.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewerRole);

const reviewerPolicy = (incumbent: Model) =>
  H.policy.model(`reviewer-model-${incumbent.name}`, [incumbent, challenger], ctx => {
    const mine = ctx.metrics.rate(critiqueActedOn, {
      by: { seat: ctx.seat, model: incumbent },
      window: { lastDays: 60 },
    });
    const weaker = ctx.peers.some(peer => {
      const theirs = ctx.metrics.rate(critiqueActedOn, { by: { seat: peer }, window: { lastDays: 60 } });
      return mine.samples >= 50 && theirs.samples >= 50 && mine.rate < theirs.rate;
    });
    return weaker ? challenger : incumbent;
  });

const reviewerA = H.seat('reviewer-a').role(reviewerRole).model(reviewerPolicy(opus)).pool(pool);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).model(reviewerPolicy(sonnet)).pool(pool);

const localRunner = local.runner('local');

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv(i => ['./scripts/fact-check', i.body])
  .output(z.object({ repeatMistakes: z.array(z.string()) }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(i => ['./scripts/merge-critiques', i.a, i.b])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const review = H.flow('review')
  .input(draftSchema)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}`,
    resources: sectionResources(ctx.unit.attributes.section),
  }))
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}`,
    resources: sectionResources(ctx.unit.attributes.section),
  }))
  .step('factCheck', factCheck, ctx => ({ body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.critiqueA, b: ctx.steps.critiqueB }))
  .halt('editor', editorReview, { ask: ctx => ctx.steps.merge.merged })
  .exit('returned', ctx => ctx.steps.editor.action === 'return')
  .exit('accepted');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: H.env('CMS_TOKEN'), everyMinutes: 15 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: H.env('CMS_TOKEN') }))
  .handler(review, {
    exits: { returned: Returned, accepted: Accepted },
    during: { critiqueA: InReview, critiqueB: InReview, factCheck: InReview, merge: InReview },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: ReviewFailed });

const critiqueActedOn = H.metric('critique-acted-on', H.when.decision(drafts, editorReview)).samples(e => [
  {
    hit: e.decision.actedOn.includes('critiqueA'),
    by: { seat: e.invocations.critiqueA?.seat, model: e.invocations.critiqueA?.model },
  },
  {
    hit: e.decision.actedOn.includes('critiqueB'),
    by: { seat: e.invocations.critiqueB?.seat, model: e.invocations.critiqueB?.model },
  },
]);

const returnNotesBecomeTaste = H.trigger('return-notes-become-taste')
  .on(H.when.decision(drafts, editorReview))
  .record(taste, e =>
    e.decision.action === 'return' && e.decision.notes !== undefined
      ? {
          text: e.decision.notes,
          status: 'candidate',
          when: { kinds: [Draft], resources: sectionResources(e.unit.attributes.section) },
        }
      : undefined,
  );

const repeatMistakeBecomesLesson = H.trigger('repeat-mistake-becomes-lesson')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factLessons, e => {
    const lesson = e.output?.repeatMistakes[0];
    return lesson === undefined
      ? undefined
      : { text: lesson, status: 'active', when: { kinds: [Draft], roles: [reviewerRole] } };
  });

const editor = claudeCode.supervisor('editor').client('editor-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorReview),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(drafts)
  .journals(taste, factLessons)
  .triggers(returnNotesBecomeTaste, repeatMistakeBecomesLesson)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('content').priority(drafts).wip(drafts, 4))
  .clients(editor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
