import { z } from 'zod';
import { H } from 'harness-dsl';
import { contentful } from 'harness-dsl/contentful';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const cmsToken = H.env('CONTENTFUL_TOKEN');
const sections = H.resources('section', ['news', 'sports', 'opinion', 'culture']);

const quota = sqlite.quota('claude-subscriptions', { path: '.harness/quota.sqlite' });
const subscription = claudeCode.subscription('desk-subscription', { token: H.env('CLAUDE_TOKEN'), quota });
const pool = H.pool('desk').accounts(subscription);
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = claudeCode.model('challenger', { id: 'claude-opus-4' });

const localRunner = local.runner('local').slots(2);

const draftSchema = z.object({
  entryId: z.string(),
  title: z.string(),
  section: sections.schema,
  body: z.string(),
  editorNotes: z.array(z.string()),
});

const inReview = H.state('in-review', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.terminal('accepted', 'success');
const reviewFailed = H.terminal('review-failed', 'failure');

const draft = H.kind('Draft')
  .attributes(draftSchema)
  .states(inReview, returned, accepted, reviewFailed)
  .initial(inReview)
  .key(attrs => attrs.entryId);

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft: structure, clarity, facts, voice.');

const editorial = H.halt('editorial-decision').decision(z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.enum(['a', 'b', 'both', 'neither']),
}));

const reviewerLineup = H.policy.lineup('reviewer-lineup', [opus, sonnet, challenger], ctx => {
  const scored = ctx.seats.map(seat => ({
    seat,
    model: ctx.current(seat),
    record: ctx.metrics.rate(critiqueActedOn, { seat, model: ctx.current(seat), window: { lastDays: 60 } }),
  }));
  const ready = scored.every(entry => entry.record.samples >= 50);
  const weakest = scored.reduce((low, entry) => entry.record.rate < low.record.rate ? entry : low);
  const replacement = ctx.candidates.find(model => scored.every(entry => entry.model.name === model.name ? false : true));
  return scored.map(entry => ({
    seat: entry.seat,
    model: ready && entry === weakest && replacement !== undefined ? replacement : entry.model,
  }));
});

const critiqueSchema = z.object({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.seat('reviewer-a').role(reviewerRole).model(reviewerLineup).pool(pool).output(critiqueSchema);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).model(reviewerLineup).pool(pool).output(critiqueSchema);

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(input => ['./bin/fact-check', '--entry', input.entryId])
  .output(z.object({ issues: z.array(z.string()), repeatLesson: z.string().optional() }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string(), facts: z.array(z.string()) }))
  .argv(input => ['./bin/merge-critiques', '--first', input.first, '--second', input.second, '--facts', input.facts.join('|')])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const review = H.flow('review')
  .input(draftSchema)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}\nEarlier editor notes: ${ctx.unit.attributes.editorNotes.join('; ')}`,
    resources: [sections.get(ctx.unit.attributes.section)],
  }), { afterCrash: 'askDriver' })
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}\nEarlier editor notes: ${ctx.unit.attributes.editorNotes.join('; ')}`,
    resources: [sections.get(ctx.unit.attributes.section)],
  }), { afterCrash: 'askDriver' })
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }), { afterCrash: 'rerun' })
  .step('merge', mergeCritiques, ctx => ({
    first: ctx.steps.critiqueA.critique,
    second: ctx.steps.critiqueB.critique,
    facts: ctx.steps.factCheck.issues,
  }), { afterCrash: 'rerun' })
  .halt('editorial', editorial, { ask: ctx => ctx.steps.merge.merged })
  .exit('accepted', ctx => ctx.steps.editorial.verdict === 'accept')
  .exit('returned', {
    update: ctx => ({ editorNotes: [...ctx.unit.attributes.editorNotes, ctx.steps.editorial.notes] }),
  });

const revised = H.signal('draft-revised').payload(z.object({ body: z.string() }));

const draftLane = H.lane('drafts', draft)
  .supply(contentful.drafts({ space: 'publication', token: cmsToken, everyMinutes: 5 }), (entry, to) => {
    const parsed = sections.schema.safeParse(entry.section);
    const section = parsed.success ? parsed.data : 'news';
    return [
      to.create({ entryId: entry.id, title: entry.title, section, body: entry.body, editorNotes: [] }),
      to.signal(revised, entry.id, { body: entry.body }),
    ];
  })
  .handler(review, { exits: { accepted, returned } })
  .store(contentful.store({ space: 'publication', token: cmsToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120000, exhausted: reviewFailed })
  .on(revised, { update: (attrs, payload) => ({ ...attrs, body: payload.body }), enter: inReview });

const critiqueActedOn = H.metric('critique-acted-on', H.when.decision(draft, editorial)).samples(event => [
  {
    hit: event.decision.actedOn === 'a' || event.decision.actedOn === 'both',
    seat: reviewerA,
    model: event.modelOf(reviewerA),
  },
  {
    hit: event.decision.actedOn === 'b' || event.decision.actedOn === 'both',
    seat: reviewerB,
    model: event.modelOf(reviewerB),
  },
]);

const editorTaste = H.memory('editor-taste', 'taste');
const factLessons = H.memory('fact-check-lessons', 'experience');

const tasteJournal = H.journal('editor-taste', editorTaste)
  .store(jsonl.memoryStore({ path: 'memory/editor-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 25 })
  .readBy(reviewerRole);

const factJournal = H.journal('fact-check-lessons', factLessons)
  .store(jsonl.memoryStore({ path: 'memory/fact-check.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewerRole);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.decision(draft, editorial))
  .record(tasteJournal, event => event.decision.verdict === 'accept' ? undefined : {
    text: `When reviewing ${event.unit.attributes.section} drafts, flag what the editor flagged: ${event.decision.notes}, because the editor returned a draft for it`,
    when: {
      kinds: [draft],
      roles: [reviewerRole],
      resources: event.unit.attributes.section === 'sports' || event.unit.attributes.section === 'opinion'
        ? [sections.get(event.unit.attributes.section)]
        : [],
    },
    status: 'candidate',
  });

const repeatMistakesBecomeLessons = H.trigger('repeat-mistakes-become-lessons')
  .on(H.when.step(draftLane, 'factCheck', { if: event => event.ok }))
  .record(factJournal, event => event.output?.repeatLesson === undefined ? undefined : {
    text: event.output.repeatLesson,
    when: { kinds: [draft], roles: [reviewerRole] },
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

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(draftLane)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, repeatMistakesBecomeLessons)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('desk').standard(draftLane).wip(draftLane, 3))
  .clients(editorDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
