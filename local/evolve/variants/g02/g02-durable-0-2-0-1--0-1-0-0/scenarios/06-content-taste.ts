import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('editorial-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const editorialPool = H.pool('editorial').accounts(apiAccount);

const reviewerRole = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft as the editor would. Every point names the passage it concerns.');

const sections = [H.resource('sports'), H.resource('opinion')];
const sectionScope = (section: string) => sections.filter(resource => resource.name === section);

const strongerReviewer = H.policy.model('strongerReviewer', ctx => {
  const window = { lastDays: 90 };
  const mine = ctx.current ?? ctx.candidates[0];
  const own = ctx.metrics.rate(critiquesActedOn, { by: { seat: ctx.seat, model: mine }, window });
  if (own.samples < 50) return mine;
  const beaten = ctx.peers.some(peer => {
    if (!peer.current) return false;
    const theirs = ctx.metrics.rate(critiquesActedOn, { by: { seat: peer.seat, model: peer.current }, window });
    return theirs.samples >= 50 && theirs.rate > own.rate;
  });
  if (!beaten) return mine;
  const held = ctx.peers.map(peer => peer.current);
  return ctx.candidates.find(model => model !== mine && !held.includes(model)) ?? mine;
});

const critique = z.object({ points: z.array(z.string()) });

const firstReviewer = H.seat('firstReviewer')
  .role(reviewerRole)
  .model(strongerReviewer, [opus, haiku])
  .pool(editorialPool)
  .output(critique);

const secondReviewer = H.seat('secondReviewer')
  .role(reviewerRole)
  .model(strongerReviewer, [sonnet, haiku])
  .pool(editorialPool)
  .output(critique);

const worker = local.runner('editorial-worker').slots(4);

const factCheck = H.command('factCheck')
  .input(z.object({ body: z.string() }))
  .argv(input => ['./tools/fact-check.sh', input.body])
  .output(z.object({ claimsChecked: z.number(), repeatMistake: z.string().optional() }))
  .runner(worker);

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ first: z.array(z.string()), second: z.array(z.string()) }))
  .argv(input => ['./tools/merge-critiques.sh', JSON.stringify(input)])
  .output(z.object({ merged: z.string() }))
  .runner(worker);

const editorReview = H.halt('editorReview').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    noteScope: z.enum(['allDrafts', 'section']),
    actedOn: z.array(z.enum(['first', 'second'])),
  }),
);

const draftAttrs = z.object({ entryId: z.string(), title: z.string(), section: z.string(), body: z.string() });

const review = H.flow('review')
  .input(draftAttrs)
  .step('first', firstReviewer, ctx => ({
    task: `Critique this ${ctx.unit.attributes.section} draft: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
    resources: sectionScope(ctx.unit.attributes.section),
  }))
  .step('second', secondReviewer, ctx => ({
    task: `Critique this ${ctx.unit.attributes.section} draft: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
    resources: sectionScope(ctx.unit.attributes.section),
  }))
  .step('factCheck', factCheck, ctx => ({ body: ctx.unit.attributes.body }), { afterCrash: 'rerun' })
  .step('merge', mergeCritiques, ctx => ({ first: ctx.steps.first.points, second: ctx.steps.second.points }), {
    afterCrash: 'rerun',
  })
  .halt('editor', editorReview, { ask: ctx => ctx.steps.merge.merged })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const Pending = H.state('Pending', 'pending');
const Returned = H.state('Returned', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const ReviewFailed = H.terminal('ReviewFailed', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftAttrs)
  .states(Pending, Returned, Accepted, ReviewFailed)
  .key(draft => draft.entryId)
  .initial(Pending);

const revised = H.signal('revised').payload(z.object({ title: z.string(), body: z.string() }));

const cms = { space: 'publication', token: H.env('CMS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ ...cms, everyMinutes: 15 }), (entry, to) => [
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
    to.signal(revised, entry.id, { title: entry.title, body: entry.body }),
  ])
  .store(contentful.store(cms))
  .handler(review, {
    ends: { accepted: Accepted },
    rests: { returned: Returned },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: ReviewFailed },
  })
  .on(revised, { update: (attrs, payload) => ({ ...attrs, ...payload }), enter: Pending });

const critiquesActedOn = H.metric('critiquesActedOn', H.when.decision(drafts, editorReview)).samples(event => [
  { hit: event.decision.actedOn.includes('first'), by: { seat: firstReviewer, model: event.invocations.first?.model } },
  { hit: event.decision.actedOn.includes('second'), by: { seat: secondReviewer, model: event.invocations.second?.model } },
]);

const taste = H.journal('editorTaste', H.memory('editorTaste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 25 })
  .readBy(reviewerRole);

const factLessons = H.journal('factLessons', H.memory('factLessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/fact-lessons.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewerRole);

const tasteCandidates = H.trigger('tasteCandidates')
  .on(H.when.decision(drafts, editorReview))
  .record(taste, event =>
    event.decision.action === 'return' && event.decision.notes.length > 0
      ? {
          text: event.decision.notes,
          when: {
            roles: [reviewerRole],
            resources: event.decision.noteScope === 'section' ? sectionScope(event.unit.attributes.section) : [],
          },
          status: 'candidate',
        }
      : undefined,
  );

const repeatMistakes = H.trigger('repeatMistakes')
  .on(H.when.step(drafts, 'factCheck', { if: event => event.ok }))
  .record(factLessons, event =>
    event.output?.repeatMistake
      ? { text: event.output.repeatMistake, when: { roles: [reviewerRole], kinds: [Draft] } }
      : undefined,
  );

const editor = claudeCode.supervisor('editor').client('editorial', {
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
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(drafts)
  .journals(taste, factLessons)
  .triggers(tasteCandidates, repeatMistakes)
  .metrics(critiquesActedOn)
  .scheduler(H.scheduler('editorial').wip(drafts, 3))
  .clients(editor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
