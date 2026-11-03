import { z } from 'zod';
import { H, AgentTask } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { contentful } from 'harness-dsl/contentful';

const sectionEnum = z.enum(['news', 'sports', 'opinion', 'culture']);
const sections = H.resources('section', sectionEnum.options);

const draftAttrs = z.object({ entryId: z.string(), title: z.string(), section: z.string(), body: z.string() });
type DraftAttrs = z.infer<typeof draftAttrs>;

const Submitted = H.state('Submitted', 'pending');
const Stalled = H.state('Stalled', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftAttrs)
  .states(Submitted, Stalled, Accepted, Returned)
  .key(a => a.entryId)
  .initial(Submitted);

const editorial = H.halt('editorial-decision').decision(
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOnFirst: z.boolean(),
    actedOnSecond: z.boolean(),
    tasteScope: z.enum(['all', 'section']),
  }),
);

const subscriptionQuota = sqlite.quota('claude-subscriptions', { path: 'quota.sqlite' });
const editorialPlan = claudeCode.subscription('editorial-plan', { token: H.env('CLAUDE_EDITORIAL_TOKEN'), quota: subscriptionQuota });
const editorialPool = H.pool('editorial').accounts(editorialPlan);

const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = claudeCode.model('haiku', { id: 'claude-haiku-4-5' });
const reviewerCandidates = [opus, sonnet, haiku];

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft against house taste. Return concrete, actionable points.')
  .output(z.object({ points: z.array(z.string()) }));

const swapAfterSamples = 50;

const reviewerModels = H.policy.model('reviewer-models', reviewerCandidates, ctx => {
  const held = ctx.rivals.map(r => r.model);
  const free = reviewerCandidates.filter(m => held.includes(m) === false);
  const current = ctx.current ?? free[0] ?? opus;
  const rival = ctx.rivals[0];
  if (rival === undefined) return current;
  const window = { lastDays: 90 };
  const mine = ctx.metrics.rate(critiqueActedOn, { seat: ctx.seat, model: current, window });
  const theirs = ctx.metrics.rate(critiqueActedOn, { seat: rival.seat, model: rival.model, window });
  if (mine.samples < swapAfterSamples || theirs.samples < swapAfterSamples || mine.rate >= theirs.rate) return current;
  return free.find(m => m !== current) ?? current;
});

const firstReviewer = H.seat('first-reviewer').role(reviewerRole).model(reviewerModels).pool(editorialPool);
const secondReviewer = H.seat('second-reviewer').role(reviewerRole).model(reviewerModels).pool(editorialPool);

const localRunner = local.runner('local');
const factCheck = H.command('fact-check')
  .input(z.object({ title: z.string(), body: z.string() }))
  .argv(i => ['./editorial/fact-check', '--title', i.title, '--body', i.body])
  .output(z.object({ issues: z.array(z.string()), repeatLesson: z.string().optional() }))
  .runner(localRunner);
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.array(z.string()), second: z.array(z.string()) }))
  .argv(i => ['./editorial/merge-critiques', JSON.stringify(i)])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const sectionOf = (section: string) => {
  const member = sections.parse(section);
  return member === undefined ? [] : [member];
};

const reviewTask = (draft: DraftAttrs, issues: readonly string[]): AgentTask => ({
  task: [`Critique the draft "${draft.title}".`, draft.body, ...issues.map(i => `Fact-check issue: ${i}`)].join('\n\n'),
  resources: sectionOf(draft.section),
});

const review = H.flow('review-draft')
  .input(draftAttrs)
  .step('factCheck', factCheck, ctx => ({ title: ctx.unit.attributes.title, body: ctx.unit.attributes.body }), { afterCrash: 'rerun' })
  .step('firstCritique', firstReviewer, ctx => reviewTask(ctx.unit.attributes, ctx.steps.factCheck.issues))
  .step('secondCritique', secondReviewer, ctx => reviewTask(ctx.unit.attributes, ctx.steps.factCheck.issues))
  .step('merge', mergeCritiques, ctx => ({ first: ctx.steps.firstCritique.points, second: ctx.steps.secondCritique.points }))
  .halt('editorial', editorial, {
    ask: ctx => ctx.steps.merge.merged,
    resources: ctx => sectionOf(ctx.unit.attributes.section),
  })
  .exit('accepted', ctx => ctx.steps.editorial.verdict === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'publication', token: cmsToken, everyMinutes: 15 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .handler(review, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store({ space: 'publication', token: cmsToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: Stalled });

const critiqueActedOn = H.metric('critique-acted-on', H.when.decision(Draft, editorial)).samples(e =>
  e.seats
    .filter(a => a.seat === firstReviewer || a.seat === secondReviewer)
    .map(a => ({
      hit: a.seat === firstReviewer ? e.decision.actedOnFirst : e.decision.actedOnSecond,
      seat: a.seat,
      model: a.model,
      resources: e.resources,
    })),
);

const taste = H.journal('editor-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewerRole);

const factCheckingExperience = H.journal('fact-checking-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/fact-checking.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const returnedNotesBecomeTasteCandidates = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.decision(Draft, editorial))
  .record(taste, e =>
    e.decision.verdict === 'return'
      ? {
          text: e.decision.notes,
          status: 'candidate',
          when: e.decision.tasteScope === 'section' ? { roles: [reviewerRole], resources: e.resources } : { roles: [reviewerRole] },
        }
      : undefined,
  );

const repeatMistakesBecomeExperience = H.trigger('repeat-mistakes-become-experience')
  .on(H.when.step(drafts, 'factCheck', { if: e => e.output?.repeatLesson !== undefined }))
  .record(factCheckingExperience, e => {
    const lesson = e.output?.repeatLesson;
    return lesson === undefined ? undefined : { text: lesson, when: { roles: [reviewerRole] } };
  });

const editor = claudeCode.supervisor('editor', {
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
  .ledger(sqlite.ledger({ path: 'harness.sqlite' }))
  .lanes(drafts)
  .journals(taste, factCheckingExperience)
  .triggers(returnedNotesBecomeTasteCandidates, repeatMistakesBecomeExperience)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('editorial').standard(drafts).wip(drafts, 3))
  .clients(editor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
