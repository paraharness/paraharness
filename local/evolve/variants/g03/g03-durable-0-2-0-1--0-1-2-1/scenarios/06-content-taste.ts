import { z } from 'zod';
import { H, AgentTask, Resource } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
type Section = z.infer<typeof sectionSchema>;
const draftItem = z.object({ entryId: z.string(), title: z.string(), section: sectionSchema, body: z.string() });
type DraftItem = z.infer<typeof draftItem>;

const sections = H.resources('section', ['sports', 'opinion']);
const sectionScope = (section: Section): readonly Resource[] =>
  section === 'sports' || section === 'opinion' ? [sections.of(section)] : [];

const InReview = H.state('InReview', 'pending');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const ReviewFailed = H.terminal('ReviewFailed', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftItem)
  .states(InReview, Accepted, Returned, ReviewFailed)
  .key(a => a.entryId)
  .initial(InReview);

const editorDecision = H.halt('editor-decision').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.enum(['a', 'b', 'both', 'neither']),
  }),
);

const quota = sqlite.quota('claude-accounts', { path: './.harness/quota.sqlite' });
const subscription = claudeCode.subscription('claude-max', { token: H.env('CLAUDE_TOKEN'), quota });
const pool = H.pool('review').accounts(subscription);

const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = claudeCode.model('haiku', { id: 'claude-haiku-4-5' });

const reviewerModels = H.policy.model(
  'reviewer-models',
  [opus, sonnet, challenger],
  ctx => {
    const candidates = [opus, sonnet, challenger];
    const taken = ctx.peers.map(peer => peer.model);
    const mine = candidates.find(m => m === ctx.current);
    const free = candidates.filter(m => m !== mine && !taken.includes(m));
    if (mine === undefined) return free[0];
    const own = ctx.metrics.rate(actedOn, { seat: ctx.seat, model: mine });
    const all = ctx.metrics.rate(actedOn);
    return own.samples >= 50 && own.rate < all.rate && free.length > 0 ? free[0] : mine;
  },
  { distinct: true },
);

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft: structure, clarity, accuracy. Apply recalled taste and fact-checking lessons.');

const critique = z.object({ critique: z.string() });
const reviewerA = H.seat('reviewer-a').role(reviewerRole).model(reviewerModels).pool(pool).output(critique);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).model(reviewerModels).pool(pool).output(critique);

const actedOn = H.metric('critique-acted-on', H.when.decision(Draft, editorDecision)).samples(e => [
  { seat: reviewerA, model: e.modelOf(reviewerA), hit: e.decision.actedOn === 'a' || e.decision.actedOn === 'both' },
  { seat: reviewerB, model: e.modelOf(reviewerB), hit: e.decision.actedOn === 'b' || e.decision.actedOn === 'both' },
]);

const reviewTask = (draft: DraftItem): AgentTask => ({
  task: `Critique this ${draft.section} draft.\n\n${draft.title}\n\n${draft.body}`,
  resources: sectionScope(draft.section),
});

const localRunner = local.runner('local');
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(i => ['./scripts/merge-critiques.sh', i.a, i.b])
  .runner(localRunner)
  .output(z.object({ merged: z.string() }));
const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string() }))
  .argv(i => ['./scripts/fact-check.sh', '--entry', i.entryId])
  .runner(localRunner)
  .output(z.object({ report: z.string(), lesson: z.string().optional() }));

const review = H.flow('draft-review')
  .input(draftItem)
  .step('reviewA', reviewerA, ctx => reviewTask(ctx.unit.attributes))
  .step('reviewB', reviewerB, ctx => reviewTask(ctx.unit.attributes))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.reviewA.critique, b: ctx.steps.reviewB.critique }))
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId }), { afterCrash: 'rerun' })
  .halt('editor', editorDecision, {
    ask: ctx =>
      `${ctx.unit.attributes.title}\n\nCritiques:\n${ctx.steps.merge.merged}\n\nFact check:\n${ctx.steps.factCheck.report}\n\nAccept or return with notes; say which critique you acted on.`,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const draftLane = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'publication', token: H.env('CMS_TOKEN'), everyMinutes: 5 }), (entry, to) => {
    const section = sectionSchema.safeParse(entry.section);
    return section.success
      ? to.create({ entryId: entry.id, title: entry.title, section: section.data, body: entry.body })
      : to.skip();
  })
  .handler(review, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store({ space: 'publication', token: H.env('CMS_TOKEN') }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: ReviewFailed });

const tasteJournal = H.journal('editor-taste', H.memory('editor-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(reviewerRole);

const factJournal = H.journal('fact-checking', H.memory('fact-checking', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/fact-checking.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewerRole);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.decision(Draft, editorDecision))
  .record(tasteJournal, e =>
    e.decision.action === 'return' && e.decision.notes.length > 0
      ? {
          text: `When reviewing a ${e.unit.attributes.section} draft, flag this: ${e.decision.notes}, because the editor returned "${e.unit.attributes.title}" for it.`,
          status: 'candidate',
          when: { kinds: [Draft], roles: [reviewerRole], resources: sectionScope(e.unit.attributes.section) },
        }
      : undefined,
  );

const repeatMistakeBecomesExperience = H.trigger('repeat-mistake-becomes-experience')
  .on(H.when.step(draftLane, 'factCheck'))
  .record(factJournal, e => {
    const output = e.output;
    const lesson = output === undefined ? undefined : output.lesson;
    return lesson === undefined ? undefined : { text: lesson, when: { kinds: [Draft], roles: [reviewerRole] } };
  });

const editor = claudeCode.supervisor('editor', {
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(0),
});

export const contentHarness = H.harness('content-review')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(draftLane)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, repeatMistakeBecomesExperience)
  .metrics(actedOn)
  .scheduler(H.scheduler('content').standard(draftLane).wip(draftLane, 3))
  .clients(editor)
  .observers(markdown.board({ path: './BOARD.md' }));

void contentHarness.start();
