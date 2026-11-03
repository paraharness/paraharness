import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { markdown } from 'harness-dsl/markdown';

const sections = H.resources('sections', ['news', 'sports', 'opinion', 'culture']);

const draftAttrs = z.object({
  entryId: z.string(),
  title: z.string(),
  section: sections.schema,
  body: z.string(),
  notes: z.string(),
});

const InReview = H.state('in-review', 'pending');
const Accepted = H.terminal('accepted', 'success');
const Returned = H.terminal('returned', 'neutral');
const Unreviewed = H.terminal('unreviewed', 'failure');
const draftKind = H.kind('Draft')
  .attributes(draftAttrs)
  .states(InReview, Accepted, Returned, Unreviewed)
  .key(a => a.entryId)
  .initial(InReview);

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft against the house taste.');
const editorRole = H.role('editor').instructions('Accept or return drafts; curate taste.');

const taste = H.journal('editor-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/fact-lessons.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const quota = sqlite.quota('content-quota', { path: '.harness/quota.db' });
const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const reviewPool = H.pool('review').accounts(subscriptionA, subscriptionB);
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = claudeCode.model('haiku', { id: 'claude-haiku-4-5' });

const critique = z.object({ points: z.array(z.string()), recommendation: z.enum(['accept', 'revise']) });

const reviewers = H.panel('reviewers', reviewerRole)
  .seats('reviewer-a', 'reviewer-b')
  .candidates(opus, sonnet, haiku)
  .pool(reviewPool)
  .output(critique)
  .choose(ctx => {
    const standings = ctx.seats.map(name => ({
      name,
      score: ctx.metrics.rate(actedOn, { seat: ctx.seat(name), model: ctx.current[name] }),
    }));
    if (standings.some(s => s.score.samples < 50)) return ctx.keep();
    const weakest = standings.reduce((low, s) => (s.score.rate < low.score.rate ? s : low));
    const spare = ctx.candidates.find(model => ctx.seats.every(name => ctx.current[name] !== model));
    return spare === undefined ? ctx.keep() : ctx.swap(weakest.name, spare);
  });

const reviewerA = reviewers.seat('reviewer-a');
const reviewerB = reviewers.seat('reviewer-b');

const editorDecision = H.halt('editor-decision').decision(z.object({
  verdict: z.enum(['accept', 'return']),
  actedOn: z.array(z.enum(['reviewer-a', 'reviewer-b'])),
  notes: z.string(),
}));

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique }))
  .argv(i => ['./bin/merge-critiques', JSON.stringify(i)])
  .output(z.object({ merged: z.string() }));

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv(i => ['./bin/fact-check', i.body])
  .output(z.object({ lesson: z.string().optional() }));

const review = H.flow('review')
  .input(draftAttrs)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique this ${ctx.unit.attributes.section} draft:\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
    resources: [sections.get(ctx.unit.attributes.section)],
  }))
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique this ${ctx.unit.attributes.section} draft:\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
    resources: [sections.get(ctx.unit.attributes.section)],
  }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.critiqueA, b: ctx.steps.critiqueB }))
  .step('factCheck', factCheck, ctx => ({ body: ctx.unit.attributes.body }))
  .halt('editor', editorDecision, {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}`,
  })
  .exit('accepted', ctx => ctx.steps.editor.verdict === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const draftLane = H.lane('drafts', draftKind)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 5 }), (entry, to) => {
    const section = sections.schema.safeParse(entry.section);
    return section.success
      ? to.create({ entryId: entry.id, title: entry.title, section: section.data, body: entry.body, notes: '' })
      : to.skip();
  })
  .handler(review, {
    exits: {
      accepted: Accepted,
      returned: { to: Returned, update: (a, steps) => ({ ...a, notes: steps.editor?.notes ?? a.notes }) },
    },
  })
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Unreviewed });

const actedOn = H.metric('critique-acted-on', H.when.decision(draftKind, editorDecision))
  .samples(e => [reviewerA, reviewerB].map(seat => ({
    seat,
    model: e.modelOf(seat),
    hit: e.decision.actedOn.some(name => name === seat.name),
  })));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.transition(draftLane, { to: Returned }))
  .record(taste, e => (e.unit.attributes.notes === ''
    ? undefined
    : {
      text: `When reviewing drafts, check for what the editor asked for: ${e.unit.attributes.notes}`,
      status: 'candidate',
      when: { kinds: [draftKind], resources: [sections.get(e.unit.attributes.section)] },
    }));

const factCheckLessons = H.trigger('fact-check-lessons')
  .on(H.when.step(draftLane, 'factCheck', { if: e => e.output?.lesson !== undefined }))
  .record(factLessons, e => {
    const lesson = e.output?.lesson;
    return lesson === undefined ? undefined : { text: lesson, when: { kinds: [draftKind], roles: [reviewerRole] } };
  });

const scheduler = H.scheduler('content').standard(draftLane).wip(draftLane, 4);

const editorConsole = claudeCode.supervisor('editor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export default H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(draftLane)
  .journals(taste, factLessons)
  .triggers(returnedNotesBecomeTaste, factCheckLessons)
  .metrics(actedOn)
  .scheduler(scheduler)
  .clients(editorConsole)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
