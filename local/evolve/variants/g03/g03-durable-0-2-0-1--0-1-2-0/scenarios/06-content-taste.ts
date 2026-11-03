import { H, Model, ModelPolicy, Resource } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sectionSchema = z.enum(['sports', 'opinion', 'general']);
type Section = z.infer<typeof sectionSchema>;
const draftSchema = z.object({ entryId: z.string(), title: z.string(), section: sectionSchema, body: z.string() });

const sectionResources = { sports: H.resource('sports'), opinion: H.resource('opinion') };
function sectionScope(section: Section): readonly Resource[] {
  return section === 'general' ? [] : [sectionResources[section]];
}

const InReview = H.state('InReview', 'pending');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const ReviewFailed = H.terminal('ReviewFailed', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftSchema)
  .states(InReview, Accepted, Returned, ReviewFailed)
  .key(a => a.entryId)
  .initial(InReview);

const quota = sqlite.quota('content-quota', { path: './.harness/quota.sqlite' });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const pool = H.pool('content').accounts(api);

const opusNew = anthropic.model('opus-4-1', { id: 'claude-opus-4-1' });
const opusOld = anthropic.model('opus-4', { id: 'claude-opus-4' });
const sonnetNew = anthropic.model('sonnet-4-5', { id: 'claude-sonnet-4-5' });
const sonnetOld = anthropic.model('sonnet-4', { id: 'claude-sonnet-4' });

function swapWeaker(name: string, candidates: readonly [Model, Model]): ModelPolicy {
  const [first, second] = candidates;
  return H.policy.model(name, candidates, ctx => {
    const current = ctx.current ?? first;
    const peer = ctx.peers[0];
    if (!peer) return current;
    const mine = ctx.metrics.rate(critiqueActedOn, { seat: ctx.seat, model: current, window: { lastDays: 60 } });
    const theirs = ctx.metrics.rate(critiqueActedOn, { seat: peer, window: { lastDays: 60 } });
    if (mine.samples < 50 || theirs.samples < 50) return current;
    return mine.rate < theirs.rate ? (current === first ? second : first) : current;
  });
}

const reviewer = H.role('reviewer').intents('read').instructions('Critique the draft for argument, accuracy and house style.');
const reviewerA = H.seat('reviewer-a').role(reviewer).model(swapWeaker('reviewer-a-model', [opusNew, opusOld])).pool(pool);
const reviewerB = H.seat('reviewer-b').role(reviewer).model(swapWeaker('reviewer-b-model', [sonnetNew, sonnetOld])).pool(pool);

const critique = z.object({ critique: z.string() });
const reviewCallA = H.call('critique-a', reviewerA).output(critique);
const reviewCallB = H.call('critique-b', reviewerB).output(critique);

const localRunner = local.runner('local');
const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(i => ['fact-check', '--entry', i.entryId, '--body', i.body])
  .output(z.object({ lesson: z.string().optional() }))
  .runner(localRunner);
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(i => ['merge-critiques', '--a', i.a, '--b', i.b])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const editorVerdict = H.halt('editor-verdict').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.enum(['a', 'b', 'both', 'neither']),
  }),
);

const reviewFlow = H.flow('draft-review')
  .input(draftSchema)
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('critiqueA', reviewCallA, ctx => ({
    text: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: sectionScope(ctx.unit.attributes.section),
  }))
  .step('critiqueB', reviewCallB, ctx => ({
    text: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: sectionScope(ctx.unit.attributes.section),
  }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.critiqueA.critique, b: ctx.steps.critiqueB.critique }))
  .halt('editor', editorVerdict, {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const contentToken = H.env('CONTENTFUL_TOKEN');
const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: contentToken, everyMinutes: 10 }), (entry, to) =>
    to.create({
      entryId: entry.id,
      title: entry.title,
      section: sectionSchema.catch('general').parse(entry.section),
      body: entry.body,
    }),
  )
  .handler(reviewFlow, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store({ space: 'newsroom', token: contentToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: ReviewFailed });

const critiqueActedOn = H.metric('critique-acted-on', H.when.decision(Draft, editorVerdict)).samples(e => [
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

const tasteKind = H.memory('editorial-taste', 'taste');
const factKind = H.memory('fact-checking', 'experience');

const taste = H.journal('editorial-taste', tasteKind)
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewer);

const factLessons = H.journal('fact-checking', factKind)
  .store(jsonl.memoryStore({ path: './memory/fact-checking.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewer);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.decision(Draft, editorVerdict))
  .record(taste, e =>
    e.decision.action === 'return'
      ? {
          text: e.decision.notes,
          status: 'candidate',
          when: { kinds: [Draft], resources: sectionScope(e.unit.attributes.section) },
        }
      : undefined,
  );

const repeatMistakeRecorded = H.trigger('fact-check-records-repeat-mistake')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factLessons, e =>
    e.output && e.output.lesson !== undefined
      ? { text: e.output.lesson, status: 'active', when: { kinds: [Draft], roles: [reviewer] } }
      : undefined,
  );

const editorConsole = claudeCode.supervisor('editor-console', {
  grants: [H.ops.workRead, H.ops.resolve(editorVerdict), H.ops.memoryRead, H.ops.memoryCurate, H.ops.telemetryRead],
});

const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(drafts)
  .journals(taste, factLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakeRecorded)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('content').standard(drafts))
  .clients(editorConsole)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void contentReview.start();
