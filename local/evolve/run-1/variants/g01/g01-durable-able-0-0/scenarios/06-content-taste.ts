import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PolicyCtx, Model } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const draftAttributes = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Submitted = H.state('Submitted', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const WithEditor = H.state('WithEditor', 'waiting');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'terminal', 'failure');

const Draft = H.kind('Draft')
  .attributes(draftAttributes)
  .states(Submitted, Reviewing, WithEditor, Accepted, Returned)
  .key(draft => draft.entryId);

const apiAccount = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('opus', { id: 'claude-opus-4' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4' });
const apiPool = H.pool('publication-api').accounts(apiAccount);

const swapAfterSamples = 50;

function reviewerPair(ctx: PolicyCtx): { readonly a: Model; readonly b: Model } {
  const opusRecord = ctx.metrics.rate(critiqueActedOn, { windowDays: 60, group: opus.name });
  const sonnetRecord = ctx.metrics.rate(critiqueActedOn, { windowDays: 60, group: sonnet.name });
  if (opusRecord.samples < swapAfterSamples || sonnetRecord.samples < swapAfterSamples) {
    return { a: opus, b: sonnet };
  }
  return opusRecord.rate >= sonnetRecord.rate ? { a: opus, b: haiku } : { a: haiku, b: sonnet };
}

const reviewerModelA = H.policy.model('reviewer-model-a', [opus, haiku], ctx => reviewerPair(ctx).a);
const reviewerModelB = H.policy.model('reviewer-model-b', [sonnet, haiku], ctx => reviewerPair(ctx).b);

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for clarity, structure, accuracy and house style. Cite the passage for every point.');

const critique = z.object({
  summary: z.string(),
  points: z.array(z.string()),
});

const reviewerA = H.agent('reviewer-a').role(reviewer).model(reviewerModelA).output(critique);
const reviewerB = H.agent('reviewer-b').role(reviewer).model(reviewerModelB).output(critique);

const newsroom = local.runner('newsroom').slots(2);

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(['fact-check', '--json'])
  .output(z.object({
    issues: z.array(z.string()),
    repeatMistake: z.object({ lesson: z.string(), because: z.string() }).optional(),
  }))
  .runner(newsroom);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique, issues: z.array(z.string()) }))
  .argv(['merge-critiques', '--json'])
  .output(critique)
  .runner(newsroom);

const editorDecision = z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['a', 'b'])),
  sectionOnly: z.boolean(),
});

const reviewFlow = H.flow('draft-review')
  .input(draftAttributes)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section:${ctx.unit.attributes.section}`],
  }))
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section:${ctx.unit.attributes.section}`],
  }))
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({
    a: ctx.steps.critiqueA,
    b: ctx.steps.critiqueB,
    issues: ctx.steps.factCheck.issues,
  }))
  .halt('edit', {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}". Mark which critiques you acted on.\n\n${ctx.steps.merge.summary}\n- ${ctx.steps.merge.points.join('\n- ')}`,
    decision: editorDecision,
  })
  .exit('accepted', ctx => ctx.steps.edit.verdict === 'accept')
  .exit('returned');

const draftLane = H.lane('drafts', Draft)
  .supply(
    contentful.drafts({ space: 'publication', token: H.env('CMS_TOKEN'), everyMinutes: 10 }),
    (entry, to) => to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'publication', token: H.env('CMS_TOKEN') }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: {
      critiqueA: Reviewing,
      critiqueB: Reviewing,
      factCheck: Reviewing,
      merge: Reviewing,
      edit: WithEditor,
    },
  });

const critiqueActedOn = H.metric('critique-acted-on')
  .from(H.when.step(draftLane, 'edit'))
  .samples(event => {
    const decision = event.output;
    if (decision === undefined) return [];
    return [
      { group: event.models.critiqueA ?? 'unknown', hit: decision.actedOn.includes('a') },
      { group: event.models.critiqueB ?? 'unknown', hit: decision.actedOn.includes('b') },
    ];
  });

const editorialTaste = H.memory('editorial-taste').trust('taste');
const factLesson = H.memory('fact-lesson').trust('experience');

const editorialTastePlaybook = H.playbook('editorial-taste', editorialTaste)
  .store(jsonl.memoryStore({ path: '.harness/editorial-taste.jsonl' }))
  .recall(H.recall('taste-by-section', { by: 'specificity', limit: 15 }))
  .readBy(reviewer);

const factLessons = H.playbook('fact-lessons', factLesson)
  .store(jsonl.memoryStore({ path: '.harness/fact-lessons.jsonl' }))
  .recall(H.recall('fact-lessons-recall', { by: 'specificity', limit: 8 }))
  .readBy(reviewer);

const returnedNotesToTaste = H.trigger('returned-notes-to-taste')
  .on(H.when.step(draftLane, 'edit', { if: event => event.output?.verdict === 'return' }))
  .record(editorialTastePlaybook, event => {
    const decision = event.output;
    if (decision === undefined || decision.verdict !== 'return') return undefined;
    return {
      body: { text: decision.notes },
      status: 'candidate',
      when: decision.sectionOnly
        ? { kinds: [Draft], resources: [`section:${event.unit.attributes.section}`] }
        : { kinds: [Draft] },
    };
  });

const repeatMistakeToLesson = H.trigger('repeat-mistake-to-lesson')
  .on(H.when.step(draftLane, 'factCheck', { if: event => event.output?.repeatMistake !== undefined }))
  .record(factLessons, event => {
    const mistake = event.output?.repeatMistake;
    if (mistake === undefined) return undefined;
    return {
      body: { text: `${mistake.lesson}, because ${mistake.because}` },
      when: { kinds: [Draft], roles: [reviewer] },
    };
  });

const editorDesk = claudeCode.supervisor('editor-desk', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/content-review.sqlite' }))
  .pools(apiPool)
  .lanes(draftLane)
  .playbooks(editorialTastePlaybook, factLessons)
  .triggers(returnedNotesToTaste, repeatMistakeToLesson)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('publication').priority(draftLane))
  .clients(editorDesk)
  .observers(
    markdown.board({ path: 'BOARD.md' }),
    markdown.telemetry({ path: 'TELEMETRY.md' }),
  );

export const running = harness.start();
