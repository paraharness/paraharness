import { z } from 'zod';
import { H, PolicyCtx, Model } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const draft = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Submitted = H.state('Submitted', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Merging = H.state('Merging', 'active');
const FactChecking = H.state('FactChecking', 'active');
const WithEditor = H.state('WithEditor', 'active');
const Accepted = H.state('Accepted', 'succeeded');
const Returned = H.state('Returned', 'ended');
const Failed = H.state('Failed', 'failed');
const Cancelled = H.state('Cancelled', 'cancelled');

const Draft = H.kind('Draft')
  .attributes(draft)
  .states(Submitted, Reviewing, Merging, FactChecking, WithEditor, Accepted, Returned, Failed, Cancelled)
  .key(a => a.entryId);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool').accounts(apiAccount);
const incumbentA = anthropic.model('sonnet', { id: 'claude-sonnet-4-5', pool });
const incumbentB = anthropic.model('opus', { id: 'claude-opus-4-1', pool });
const challenger = anthropic.model('haiku', { id: 'claude-haiku-4-5', pool });

function chooseSlotA(ctx: PolicyCtx): Model {
  const a = ctx.metrics.rate(editorActedOn, { group: incumbentA.name, windowDays: 60 });
  const b = ctx.metrics.rate(editorActedOn, { group: incumbentB.name, windowDays: 60 });
  return a.samples >= 50 && b.samples >= 50 && a.rate < b.rate ? challenger : incumbentA;
}

function chooseSlotB(ctx: PolicyCtx): Model {
  const a = ctx.metrics.rate(editorActedOn, { group: incumbentA.name, windowDays: 60 });
  const b = ctx.metrics.rate(editorActedOn, { group: incumbentB.name, windowDays: 60 });
  return a.samples >= 50 && b.samples >= 50 && b.rate < a.rate ? challenger : incumbentB;
}

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft for argument, accuracy and house style.');
const editorRole = H.role('editor').instructions('Accept the draft or return it with notes.');

const critique = z.object({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.agent('reviewer-a')
  .role(reviewerRole)
  .model(H.policy.model('reviewer-a-model', [incumbentA, challenger], chooseSlotA))
  .budgetTokens(30000)
  .output(critique);

const reviewerB = H.agent('reviewer-b')
  .role(reviewerRole)
  .model(H.policy.model('reviewer-b-model', [incumbentB, challenger], chooseSlotB))
  .budgetTokens(30000)
  .output(critique);

const localRunner = local.runner('local').slots(4);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(i => ['./bin/merge-critiques', '--a', i.a, '--b', i.b])
  .output(z.object({ merged: z.string() }))
  .runner(localRunner);

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string() }))
  .argv(i => ['./bin/fact-check', i.entryId])
  .output(z.object({ repeatMistakes: z.array(z.string()) }))
  .runner(localRunner);

const reviewFlow = H.flow('draft-review')
  .input(draft)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section:${ctx.unit.attributes.section}`],
  }))
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [`section:${ctx.unit.attributes.section}`],
  }))
  .step('merge', mergeCritiques, ctx => ({ a: ctx.steps.critiqueA.critique, b: ctx.steps.critiqueB.critique }))
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId }))
  .halt('editor', {
    ask: ctx => `Review "${ctx.unit.attributes.title}".\n\nCritique:\n${ctx.steps.merge.merged}`,
    decision: z.object({
      action: z.enum(['accept', 'return']),
      notes: z.string(),
      actedOn: z.enum(['a', 'b', 'both', 'neither']),
    }),
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const draftLane = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'publication', token: H.env('CMS_TOKEN'), everyMinutes: 15 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'publication', token: H.env('CMS_TOKEN') }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: { critiqueA: Reviewing, critiqueB: Reviewing, merge: Merging, factCheck: FactChecking, editor: WithEditor },
    failure: Failed,
  });

const editorActedOn = H.metric('editor-acted-on')
  .from(H.when.step(draftLane, 'editor'))
  .samples(e =>
    e.output === undefined
      ? []
      : [
          { group: e.models['critiqueA'], success: e.output.actedOn === 'a' || e.output.actedOn === 'both' },
          { group: e.models['critiqueB'], success: e.output.actedOn === 'b' || e.output.actedOn === 'both' },
        ],
  );

const taste = H.memory('editorial-taste').trust('taste');
const factLessons = H.memory('fact-check-lessons').trust('experience');
const mostSpecific = H.recall('most-specific', { by: 'specificity', limit: 10 });

const tasteJournal = H.journal('editor-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(mostSpecific)
  .readBy(reviewerRole)
  .writtenBy(editorRole);

const factJournal = H.journal('fact-check-experience', factLessons)
  .store(jsonl.memoryStore({ path: '.harness/fact-check.jsonl' }))
  .recall(mostSpecific)
  .readBy(reviewerRole);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.step(draftLane, 'editor', { if: e => e.output !== undefined && e.output.action === 'return' }))
  .record(tasteJournal, e =>
    e.output === undefined
      ? undefined
      : { body: { text: e.output.notes }, when: { kinds: [Draft], roles: [reviewerRole] }, status: 'candidate' },
  );

const repeatMistakesBecomeExperience = H.trigger('repeat-mistakes-become-experience')
  .on(H.when.step(draftLane, 'factCheck', { if: e => e.output !== undefined && e.output.repeatMistakes.length > 0 }))
  .record(factJournal, e =>
    e.output === undefined
      ? undefined
      : {
          body: {
            text: `When a draft repeats these claims, check them against the corrections log, because they were wrong before: ${e.output.repeatMistakes.join('; ')}`,
          },
          when: { kinds: [Draft], roles: [reviewerRole], resources: [`section:${e.unit.attributes.section}`] },
        },
  );

const supervisor = claudeCode.supervisor('editor-desk', {
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
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(draftLane)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, repeatMistakesBecomeExperience)
  .metrics(editorActedOn)
  .scheduler(H.scheduler('drafts').priority(draftLane))
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = contentReview.start();
