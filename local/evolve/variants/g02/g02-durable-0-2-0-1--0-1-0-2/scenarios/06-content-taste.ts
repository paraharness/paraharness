import { z } from 'zod';
import { H, MetricRef, Model, Resource, Task } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { contentful } from 'harness-dsl/contentful';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const draftAttrs = z.object({ entryId: z.string(), title: z.string(), section: z.string(), body: z.string() });
type DraftAttrs = z.infer<typeof draftAttrs>;

const submitted = H.state('Submitted', 'pending');
const reviewing = H.state('Reviewing', 'active');
const withEditor = H.state('WithEditor', 'waiting');
const accepted = H.terminal('Accepted', 'success');
const returned = H.terminal('Returned', 'neutral');
const unreviewed = H.terminal('Unreviewed', 'failure');

const draft = H.kind('Draft')
  .attributes(draftAttrs)
  .states(submitted, reviewing, withEditor, accepted, returned, unreviewed)
  .key(a => a.entryId)
  .initial(submitted);

const sections = new Map<string, Resource>([
  ['sports', H.resource('sports')],
  ['opinion', H.resource('opinion')],
]);
const sectionScope = (section: string): Resource[] => {
  const resource = sections.get(section);
  return resource ? [resource] : [];
};

const editorReview = H.halt('editor-review').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.array(z.enum(['review-a', 'review-b'])),
    sectionOnly: z.boolean(),
  }),
);

const quota = sqlite.quota('content-quota', { path: '.harness/quota.db' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('content').accounts(api);

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft against the editor taste you are given.');
const editorRole = H.role('editor').instructions('Accept the draft or return it with notes.');

const editorTaste = H.journal('editor-taste', H.memory('editor-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/fact-check.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const swapWhenBehind = (name: string, incumbent: Model, challenger: Model) =>
  H.policy.model(name, [incumbent, challenger], ctx => {
    const current = ctx.current ?? incumbent;
    const mine = ctx.metrics.rate(critiqueActedOn, { by: { seat: ctx.seat, model: current }, window: { lastDays: 90 } });
    const behind = ctx.peers.some(peer => {
      const theirs = ctx.metrics.rate(critiqueActedOn, { by: { seat: peer }, window: { lastDays: 90 } });
      return theirs.samples >= 50 && theirs.rate > mine.rate;
    });
    if (mine.samples < 50 || behind === false) return current;
    return current === challenger ? incumbent : challenger;
  });

const reviewerA = H.seat('reviewer-a').role(reviewerRole).model(swapWhenBehind('reviewer-a-model', opus, haiku)).pool(pool);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).model(swapWhenBehind('reviewer-b-model', sonnet, haiku)).pool(pool);

const critiqueTask = (d: DraftAttrs): Task => ({
  task: `Critique the draft "${d.title}" for the ${d.section} section:\n\n${d.body}`,
  resources: sectionScope(d.section),
  skills: ['critique'],
});

const localRunner = local.runner('local');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(i => ['./bin/merge-critiques', i.a, i.b])
  .output(z.object({ critique: z.string() }))
  .runner(localRunner);

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv(i => ['./bin/fact-check', i.body])
  .output(z.object({ findings: z.array(z.string()), repeatMistake: z.string().optional() }))
  .runner(localRunner);

const review = H.flow('review-draft')
  .input(draftAttrs)
  .step('review-a', reviewerA, ctx => critiqueTask(ctx.unit.attributes))
  .step('review-b', reviewerB, ctx => critiqueTask(ctx.unit.attributes))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps['review-a'], b: ctx.steps['review-b'] }))
  .step('fact-check', factCheck, ctx => ({ body: ctx.unit.attributes.body }))
  .halt('editor', editorReview, {
    ask: ctx => `${ctx.unit.attributes.title}\n\n${ctx.steps.merge.critique}\n\nFact check: ${ctx.steps['fact-check'].findings.join('; ')}`,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', draft)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 15 }), (e, to) =>
    to.create({ entryId: e.id, title: e.title, section: e.section, body: e.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .handler(review, {
    exits: { accepted, returned },
    during: { 'review-a': reviewing, 'review-b': reviewing, merge: reviewing, 'fact-check': reviewing, editor: withEditor },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120000, exhausted: unreviewed });

const critiqueActedOn: MetricRef<'rate'> = H.metric('critique-acted-on', H.when.decision(drafts, editorReview)).samples(e => [
  {
    hit: e.decision.actedOn.includes('review-a'),
    by: { seat: e.invocations['review-a']?.seat, model: e.invocations['review-a']?.model },
  },
  {
    hit: e.decision.actedOn.includes('review-b'),
    by: { seat: e.invocations['review-b']?.seat, model: e.invocations['review-b']?.model },
  },
]);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.decision(drafts, editorReview))
  .record(editorTaste, e =>
    e.decision.action === 'return'
      ? {
          text: e.decision.notes,
          when: e.decision.sectionOnly ? { resources: sectionScope(e.unit.attributes.section) } : undefined,
          status: 'candidate',
        }
      : undefined,
  );

const repeatMistakesBecomeExperience = H.trigger('repeat-mistakes-become-experience')
  .on(H.when.step(drafts, 'fact-check'))
  .record(factLessons, e => {
    const lesson = e.output?.repeatMistake;
    return lesson ? { text: lesson, when: { roles: [reviewerRole] } } : undefined;
  });

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/content.db' }))
  .lanes(drafts)
  .journals(editorTaste, factLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakesBecomeExperience)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('content').wip(drafts, 3))
  .clients(
    claudeCode.supervisor('editor').client('editor-console', {
      grants: [
        H.ops.workRead,
        H.ops.resolve(editorReview),
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.memoryCurate,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
