import { z } from 'zod';
import { H, type Model, type Metrics, type AnyMetric, type Sample } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { contentful } from 'harness-dsl/contentful';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const apiAccount = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('opus', { id: 'claude-opus-4' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4' });
const reviewerModels: readonly Model[] = [opus, sonnet, haiku];

const pool = H.pool('publication-pool').accounts(apiAccount);
const localRunner = local.runner('local');

const Submitted = H.state('submitted', 'pending');
const Reviewing = H.state('reviewing', 'active');
const AwaitingEditor = H.state('awaitingEditor', 'active');
const Returned = H.state('returned', 'waiting');
const Published = H.state('published', 'terminal', 'success');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const Stuck = H.state('stuck', 'terminal', 'failure');

const draftAttrs = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Draft = H.kind('Draft')
  .attributes(draftAttrs)
  .states(Submitted, Reviewing, AwaitingEditor, Returned, Published, Withdrawn, Stuck)
  .key((draft) => draft.entryId);

const revised = H.signal('revised').payload(z.object({ body: z.string() }));

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft against the publication taste you are given. List concrete points.');

const taste = H.memory('taste').trust('taste');
const factLesson = H.memory('fact-check-lesson')
  .body(z.object({ text: z.string(), claim: z.string() }))
  .trust('experience');

const tasteJournal = H.journal('editor-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall(H.recall('taste-by-specificity', { by: 'specificity', limit: 15 }))
  .readBy(reviewer);

const factJournal = H.journal('fact-check-lessons', factLesson)
  .store(jsonl.memoryStore({ path: 'memory/fact-check.jsonl' }))
  .recall(H.recall('lessons-by-specificity', { by: 'specificity', limit: 8 }))
  .readBy(reviewer);

function standings(metrics: Metrics) {
  return reviewerModels.map((model) => ({
    model,
    uptake: metrics.rate(critiqueUptake, { windowDays: 90, group: model.name }),
  }));
}

function firstReviewerModel(metrics: Metrics): Model {
  const proven = standings(metrics)
    .filter((standing) => standing.uptake.samples >= 50)
    .sort((a, b) => b.uptake.rate - a.uptake.rate);
  return proven[0]?.model ?? opus;
}

function secondReviewerModel(metrics: Metrics): Model {
  const first = firstReviewerModel(metrics);
  const others = standings(metrics).filter((standing) => standing.model.name !== first.name);
  const untested = others.find((standing) => standing.uptake.samples < 50);
  if (untested) {
    return untested.model;
  }
  const ranked = [...others].sort((a, b) => b.uptake.rate - a.uptake.rate);
  return ranked[0]?.model ?? sonnet;
}

const firstModelPolicy = H.policy.model('first-reviewer-model', reviewerModels, (ctx) => firstReviewerModel(ctx.metrics));
const secondModelPolicy = H.policy.model('second-reviewer-model', reviewerModels, (ctx) => secondReviewerModel(ctx.metrics));

const critique = z.object({
  points: z.array(z.string()),
  recommendation: z.enum(['accept', 'return']),
});

const firstReviewer = H.agent('reviewer-first').role(reviewer).model(firstModelPolicy).output(critique).budgetTokens(40000);
const secondReviewer = H.agent('reviewer-second').role(reviewer).model(secondModelPolicy).output(critique).budgetTokens(40000);

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv((input) => ['fact-check', '--entry', input.entryId, '--body', input.body])
  .output(z.object({
    passed: z.boolean(),
    repeatMistake: z.object({ claim: z.string(), lesson: z.string() }).optional(),
  }))
  .runner(localRunner);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: critique, second: critique }))
  .argv((input) => ['merge-critiques', '--first', JSON.stringify(input.first), '--second', JSON.stringify(input.second)])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const editorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.enum(['first', 'second', 'both', 'neither']),
  sectionOnly: z.boolean(),
});

const reviewFlow = H.flow('draft-review')
  .input(draftAttrs)
  .step('critiqueA', firstReviewer, (ctx) => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section/${ctx.unit.attributes.section}`],
  }))
  .step('critiqueB', secondReviewer, (ctx) => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section/${ctx.unit.attributes.section}`],
  }))
  .step('factCheck', factCheck, (ctx) => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, (ctx) => ({ first: ctx.steps.critiqueA, second: ctx.steps.critiqueB }))
  .halt('editor', {
    ask: (ctx) => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}\n\nFact check passed: ${ctx.steps.factCheck.passed}`,
    decision: editorDecision,
  })
  .exit('accepted', (ctx) => ctx.steps.editor.action === 'accept')
  .exit('returned');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'publication', token: H.env('CONTENTFUL_TOKEN'), everyMinutes: 10 }), (entry, to) => [
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
    to.signal(revised, (unit) => unit.key === entry.id && unit.state === 'returned', { body: entry.body }),
  ])
  .store(contentful.store({ space: 'publication', token: H.env('CONTENTFUL_TOKEN') }))
  .handler(reviewFlow, {
    exits: { accepted: Published, returned: Returned },
    during: { critiqueA: Reviewing, critiqueB: Reviewing, factCheck: Reviewing, merge: Reviewing, editor: AwaitingEditor },
    failure: Stuck,
  })
  .on(revised, { update: (attrs, payload) => ({ ...attrs, body: payload.body }), enter: Submitted })
  .on(H.cancel, { enter: Withdrawn });

const critiqueUptake: AnyMetric = H.metric('critique-uptake')
  .from(H.when.step(drafts, 'editor'))
  .samples((event) => {
    const decision = event.output;
    if (decision === undefined) {
      return [];
    }
    const samples: Sample[] = [];
    const firstModel = event.models.critiqueA;
    const secondModel = event.models.critiqueB;
    if (firstModel !== undefined) {
      samples.push({ group: firstModel, success: decision.actedOn === 'first' || decision.actedOn === 'both' });
    }
    if (secondModel !== undefined) {
      samples.push({ group: secondModel, success: decision.actedOn === 'second' || decision.actedOn === 'both' });
    }
    return samples;
  });

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.step(drafts, 'editor', { if: (event) => event.output?.action === 'return' }))
  .record(tasteJournal, (event) => {
    const decision = event.output;
    if (decision === undefined) {
      return undefined;
    }
    return {
      body: { text: decision.notes },
      status: 'candidate',
      when: decision.sectionOnly
        ? { kinds: [Draft], resources: [`section/${event.unit.attributes.section}`] }
        : { kinds: [Draft] },
    };
  });

const repeatMistakeBecomesLesson = H.trigger('repeat-mistake-becomes-lesson')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factJournal, (event) => {
    const mistake = event.output?.repeatMistake;
    return mistake === undefined
      ? undefined
      : { body: { text: mistake.lesson, claim: mistake.claim }, when: { kinds: [Draft], roles: [reviewer] } };
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

export const publication = H.harness('publication')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pool(pool)
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .metrics(critiqueUptake)
  .triggers(returnedNotesBecomeTaste, repeatMistakeBecomesLesson)
  .scheduler(H.scheduler('publication-scheduler').priority(drafts))
  .clients(editorDesk)
  .observers(markdown.board({ path: 'board.md' }), markdown.telemetry({ path: 'telemetry.md' }));
