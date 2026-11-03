import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AgentTask, Model } from 'harness-dsl';
import { contentful } from 'harness-dsl/contentful';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { claudeCode } from 'harness-dsl/claude-code';
import { markdown } from 'harness-dsl/markdown';

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
type Section = z.infer<typeof sectionSchema>;
const sectionOf = (raw: string): Section => {
  const parsed = sectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'news';
};
const sections = {
  news: H.resource('section-news'),
  sports: H.resource('section-sports'),
  opinion: H.resource('section-opinion'),
  culture: H.resource('section-culture'),
};

const draft = z.object({ entryId: z.string(), title: z.string(), section: sectionSchema, body: z.string() });
type DraftAttrs = z.infer<typeof draft>;

const InReview = H.state('InReview', 'pending');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');
const Draft = H.kind('Draft').attributes(draft).states(InReview, Accepted, Returned, Abandoned).key(a => a.entryId);

const quota = sqlite.quota('content-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('content-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('content-api').accounts(apiAccount);
const opus = anthropic.model('opus', { id: 'claude-opus-4-5' });
const opusChallenger = anthropic.model('opus-challenger', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const sonnetChallenger = anthropic.model('sonnet-challenger', { id: 'claude-haiku-4-5' });

const reviewerModel = (name: string, incumbent: Model, challenger: Model) =>
  H.policy.model(name, [incumbent, challenger], ({ seat, metrics }) => {
    const window = { lastDays: 90 };
    const overall = metrics.rate(actedOn, { window });
    const current = metrics.rate(actedOn, { seat, model: incumbent, window });
    if (current.samples < 50 || current.rate >= overall.rate) return incumbent;
    const trial = metrics.rate(actedOn, { seat, model: challenger, window });
    return trial.samples < 50 || trial.rate >= current.rate ? challenger : incumbent;
  });

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft: argument, structure, fact risks, and house style.');

const critique = z.object({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.seat('reviewer-a')
  .role(reviewer)
  .model(reviewerModel('reviewer-a-model', opus, opusChallenger))
  .pool(api)
  .output(critique);
const reviewerB = H.seat('reviewer-b')
  .role(reviewer)
  .model(reviewerModel('reviewer-b-model', sonnet, sonnetChallenger))
  .pool(api)
  .output(critique);

const reviewTask = (attrs: DraftAttrs): AgentTask => ({
  task: `Critique this ${attrs.section} draft.\n\n${attrs.title}\n\n${attrs.body}`,
  resources: [sections[attrs.section]],
});

const runner = local.runner('local');
const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .argv(i => ['./bin/fact-check', '--text', i.body])
  .output(z.object({
    issues: z.array(z.string()),
    repeatMistake: z.object({ lesson: z.string(), because: z.string() }).optional(),
  }))
  .runner(runner);
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string(), facts: z.array(z.string()) }))
  .argv(i => ['./bin/merge-critiques', JSON.stringify(i)])
  .output(z.object({ merged: z.string() }))
  .runner(runner);

const editorDecision = H.halt('editor-decision').decision(z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.enum(['a', 'b', 'both', 'neither']),
}));

const review = H.flow('review-draft')
  .input(draft)
  .step('critiqueA', reviewerA, ctx => reviewTask(ctx.unit.attributes))
  .step('critiqueB', reviewerB, ctx => reviewTask(ctx.unit.attributes))
  .step('factCheck', factCheck, ctx => ({ body: ctx.unit.attributes.body }))
  .step('merge', mergeCritiques, ctx => ({
    a: ctx.steps.critiqueA.critique,
    b: ctx.steps.critiqueB.critique,
    facts: ctx.steps.factCheck.issues,
  }))
  .halt('editor', editorDecision, { ask: ctx => `${ctx.unit.attributes.title}\n\n${ctx.steps.merge.merged}` })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 5 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: sectionOf(entry.section), body: entry.body }))
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .handler(review, { exits: { accepted: Accepted, returned: Returned } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned });

const actedOn = H.metric('critique-acted-on', H.when.decision(Draft, editorDecision)).samples(event => [
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

const tasteJournal = H.journal('editor-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewer);

const factJournal = H.journal('fact-checking-lessons', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/facts.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewer);

const returnedNotesToTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.when.decision(Draft, editorDecision))
  .record(tasteJournal, event =>
    event.decision.action === 'return' && event.decision.notes.length > 0
      ? {
          text: event.decision.notes,
          status: 'candidate',
          when: { kinds: [Draft], resources: [sections[event.unit.attributes.section]] },
        }
      : undefined);

const repeatMistakeToExperience = H.trigger('repeat-mistake-becomes-experience')
  .on(H.when.step(drafts, 'factCheck', { if: event => event.ok }))
  .record(factJournal, event =>
    event.output?.repeatMistake
      ? {
          text: `${event.output.repeatMistake.lesson}, because ${event.output.repeatMistake.because}`,
          when: { roles: [reviewer] },
        }
      : undefined);

const scheduler = H.scheduler('content').standard(drafts).wip(drafts, 4);

const editor = claudeCode.supervisor('editor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.resolve(editorDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesToTaste, repeatMistakeToExperience)
  .metrics(actedOn)
  .scheduler(scheduler)
  .clients(editor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
