import { z } from 'zod';
import { H, Metrics, Model, Sample } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const draftAttrs = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Submitted = H.state('Submitted', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Merging = H.state('Merging', 'active');
const WithEditor = H.state('WithEditor', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const ReviewBroken = H.terminal('ReviewBroken', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftAttrs)
  .states(Submitted, Reviewing, Merging, WithEditor, Accepted, Returned, ReviewBroken)
  .key(draft => draft.entryId)
  .initial(Submitted);

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for structure, clarity, accuracy and house style. Return concrete points.');

const editorRole = H.role('editor').intents('read', 'record');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewPool = H.pool('review-pool').accounts(apiAccount);

const opus = anthropic.model('opus', { id: 'claude-opus-4' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4' });

const actedOn = (metrics: Metrics, model: Model) =>
  metrics.rate(critiquesActedOn, { group: model.name, window: { lastDays: 60 } });

const slotModel = (metrics: Metrics, incumbent: Model, rival: Model, challenger: Model): Model => {
  const mine = actedOn(metrics, incumbent);
  const theirs = actedOn(metrics, rival);
  const weaker = mine.samples >= 50 && theirs.samples >= 50 && mine.rate < theirs.rate;
  return weaker ? challenger : incumbent;
};

const critique = z.object({
  points: z.array(z.string()),
  verdict: z.enum(['publish', 'revise']),
});

const reviewerA = H.agent('reviewer-a')
  .role(reviewer)
  .model(H.policy.model('reviewer-a-model', [opus, haiku], ctx => slotModel(ctx.metrics, opus, sonnet, haiku)))
  .pool(reviewPool)
  .output(critique);

const reviewerB = H.agent('reviewer-b')
  .role(reviewer)
  .model(H.policy.model('reviewer-b-model', [sonnet, haiku], ctx => slotModel(ctx.metrics, sonnet, opus, haiku)))
  .pool(reviewPool)
  .output(critique);

const localRunner = local.runner('newsroom-box');

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string() }))
  .argv(input => ['fact-check', '--entry', input.entryId, '--json'])
  .output(z.object({
    issues: z.array(z.string()),
    repeatMistake: z.object({ lesson: z.string(), topic: z.string() }).optional(),
  }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique, issues: z.array(z.string()) }))
  .argv(input => ['merge-critiques', JSON.stringify(input)])
  .output(z.object({ summary: z.string() }))
  .runner(localRunner);

const editorDecision = z.object({
  action: z.enum(['accept', 'return']),
  actedOn: z.array(z.enum(['a', 'b'])),
  notes: z.string(),
  tasteScope: z.enum(['all', 'section']),
});

const reviewFlow = H.flow('review-draft')
  .input(draftAttrs)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    skills: [ctx.unit.attributes.section],
  }))
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    skills: [ctx.unit.attributes.section],
  }))
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId }))
  .step('merge', mergeCritiques, ctx => ({
    a: ctx.steps.critiqueA,
    b: ctx.steps.critiqueB,
    issues: ctx.steps.factCheck.issues,
  }))
  .halt('editor', {
    ask: ctx => ctx.steps.merge.summary,
    decision: editorDecision,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(
    contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 10 }),
    (entry, to) => to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: { critiqueA: Reviewing, merge: Merging, editor: WithEditor },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: ReviewBroken });

const critiquesActedOn = H.metric('critiques-acted-on', H.when.step(drafts, 'editor')).samples(event => {
  const decision = event.output;
  if (decision === undefined) return [];
  const samples: Sample[] = [];
  const modelA = event.models.critiqueA;
  const modelB = event.models.critiqueB;
  if (modelA !== undefined) samples.push({ group: modelA, hit: decision.actedOn.includes('a') });
  if (modelB !== undefined) samples.push({ group: modelB, hit: decision.actedOn.includes('b') });
  return samples;
});

const editorialTaste = H.journal('editorial-taste', H.memory('editor-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/editorial-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(reviewer)
  .recordedBy(editorRole);

const factLessons = H.journal('fact-lessons', H.memory('fact-checking', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/fact-lessons.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewer);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.step(drafts, 'editor', { if: event => event.output !== undefined && event.output.action === 'return' }))
  .record(editorialTaste, event => {
    const decision = event.output;
    if (decision === undefined || decision.notes === '') return undefined;
    return {
      text: decision.notes,
      status: 'candidate',
      when: decision.tasteScope === 'section'
        ? { kinds: [Draft], skills: [event.unit.attributes.section] }
        : { kinds: [Draft] },
    };
  });

const repeatMistakeBecomesExperience = H.trigger('repeat-mistake-becomes-experience')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factLessons, event => {
    const mistake = event.output?.repeatMistake;
    if (mistake === undefined) return undefined;
    return { text: mistake.lesson, status: 'active', when: { roles: [reviewer], skills: [mistake.topic] } };
  });

const editorSupervisor = claudeCode.supervisor('editor-desk', {
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
  .ledger(sqlite.ledger({ path: 'state/content-review.sqlite' }))
  .lanes(drafts)
  .journals(editorialTaste, factLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakeBecomesExperience)
  .metrics(critiquesActedOn)
  .scheduler(H.scheduler('editorial').priority(drafts))
  .clients(editorSupervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
