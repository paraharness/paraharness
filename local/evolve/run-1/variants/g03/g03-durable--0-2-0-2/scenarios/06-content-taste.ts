import { z } from 'zod';
import { H, MetricRef, Model } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Received = H.state('Received', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingEditor = H.state('AwaitingEditor', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const draftSchema = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Draft = H.kind('Draft')
  .attributes(draftSchema)
  .states(Received, Reviewing, AwaitingEditor, Accepted, Returned, Failed, Withdrawn)
  .key((draft) => draft.entryId)
  .initial(Received)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const section = H.resource('section');

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for argument, accuracy and house style. Be concrete.');

const editor = H.role('editor');

const editorialTaste = H.memory('editorial-taste', 'taste');
const factCheckLessons = H.memory('fact-check-lessons', 'experience');

const taste = H.corpus('editorial-taste', editorialTaste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(reviewer)
  .recordedBy(editor);

const factLessons = H.corpus('fact-check-lessons', factCheckLessons)
  .store(jsonl.memoryStore({ path: 'memory/fact-check.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewer);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('editorial-pool').accounts(apiAccount);

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

function reviewerSlot(name: string, incumbent: Model, rival: Model) {
  return H.policy.model(name, [incumbent, challenger], (ctx) => {
    const mine = ctx.metrics.rate(critiqueActedOn, { group: incumbent.name, window: { lastDays: 60 } });
    const theirs = ctx.metrics.rate(critiqueActedOn, { group: rival.name, window: { lastDays: 60 } });
    const bothSampled = mine.samples >= 50 && theirs.samples >= 50;
    return bothSampled && mine.rate < theirs.rate ? challenger : incumbent;
  });
}

const reviewerA = H.agent('reviewer-a').role(reviewer).model(reviewerSlot('reviewer-a-model', opus, sonnet)).pool(pool);
const reviewerB = H.agent('reviewer-b').role(reviewer).model(reviewerSlot('reviewer-b-model', sonnet, opus)).pool(pool);

const localRunner = local.runner('local');

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv((input) => ['fact-check', '--text', input.body])
  .output(z.object({ lesson: z.string().optional() }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ critiqueA: z.string(), critiqueB: z.string() }))
  .argv((input) => ['merge-critiques', '--a', input.critiqueA, '--b', input.critiqueB])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const editorDecision = z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  sectionOnly: z.boolean(),
  actedOn: z.array(z.enum(['A', 'B'])),
});

const reviewFlow = H.flow('draft-review')
  .input(draftSchema)
  .step('reviewA', reviewerA, (ctx) => ({
    task: `Critique this draft titled "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}`,
    resources: [section.of(ctx.unit.attributes.section)],
  }))
  .step('reviewB', reviewerB, (ctx) => ({
    task: `Critique this draft titled "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.body}`,
    resources: [section.of(ctx.unit.attributes.section)],
  }))
  .step('factCheck', factCheck, (ctx) => ({ body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, (ctx) => ({ critiqueA: ctx.steps.reviewA, critiqueB: ctx.steps.reviewB }))
  .halt('editor', {
    ask: (ctx) => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}`,
    decision: editorDecision,
  })
  .exit('accepted', (ctx) => ctx.steps.editor.verdict === 'accept')
  .exit('returned');

const drafts = H.lane('drafts', Draft)
  .supply(
    contentful.drafts({ space: 'newsroom', token: H.env('CONTENTFUL_TOKEN'), everyMinutes: 10 }),
    (entry, to) => to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: H.env('CONTENTFUL_TOKEN') }), {
    Received: 'draft',
    Reviewing: 'draft',
    AwaitingEditor: 'changed',
    Accepted: 'published',
    Returned: 'draft',
    Failed: 'draft',
    Withdrawn: 'archived',
  })
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: {
      reviewA: Reviewing,
      reviewB: Reviewing,
      factCheck: Reviewing,
      merge: Reviewing,
      editor: AwaitingEditor,
    },
  });

const critiqueActedOn: MetricRef<'rate'> = H.metric('critique-acted-on', H.when.step(drafts, 'editor')).samples((event) => {
  const decision = event.output;
  if (decision === undefined) return [];
  return [
    { group: event.models.reviewA ?? 'unknown', hit: decision.actedOn.includes('A') },
    { group: event.models.reviewB ?? 'unknown', hit: decision.actedOn.includes('B') },
  ];
});

const notesToTaste = H.trigger('editor-notes-to-taste')
  .on(H.when.step(drafts, 'editor', { if: (event) => event.output?.verdict === 'return' }))
  .record(taste, (event) => {
    const decision = event.output;
    if (decision === undefined || decision.notes.trim() === '') return undefined;
    return {
      text: decision.notes,
      status: 'candidate',
      when: decision.sectionOnly
        ? { kinds: [Draft], resources: [section.of(event.unit.attributes.section)] }
        : { kinds: [Draft] },
    };
  });

const factCheckToExperience = H.trigger('fact-check-lesson-to-experience')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factLessons, (event) => {
    const lesson = event.output?.lesson;
    if (lesson === undefined) return undefined;
    return { text: lesson, status: 'active', when: { kinds: [Draft], roles: [reviewer] } };
  });

const editorSupervisor = claudeCode.supervisor('editor-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .lanes(drafts)
  .corpora(taste, factLessons)
  .triggers(notesToTaste, factCheckToExperience)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('editorial').priority(drafts))
  .clients(editorSupervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
