import { z } from 'zod';
import { H, Model, PolicyCtx, Sample } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const DraftAttributes = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const InReview = H.state('InReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const WithEditor = H.state('WithEditor', 'active');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'failure');

const Draft = H.kind('Draft')
  .attributes(DraftAttributes)
  .states(InReview, Reviewing, WithEditor, Accepted, Returned)
  .key(draft => draft.entryId)
  .initial(InReview);

const sectionResource = (section: string) => `section:${section}`;

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for argument, accuracy, structure and house style. Name concrete passages.');

const editorialAccount = anthropic.account('editorialApiAccount', { apiKey: H.env('ANTHROPIC_API_KEY') });
const editorialPool = H.pool('editorialPool').accounts(editorialAccount);

const primaryA = anthropic.model('reviewerPrimaryA', { id: 'claude-opus-4-1' });
const primaryB = anthropic.model('reviewerPrimaryB', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('reviewerChallenger', { id: 'claude-opus-4-5' });

const swapAfterSamples = 50;
const actedOnWindow = { lastDays: 60 };

function slotModel(ctx: PolicyCtx, own: Model, rival: Model): Model {
  const mine = ctx.metrics.rate(editorActedOn, { group: own.name, window: actedOnWindow });
  const theirs = ctx.metrics.rate(editorActedOn, { group: rival.name, window: actedOnWindow });
  const enoughSamples = mine.samples >= swapAfterSamples && theirs.samples >= swapAfterSamples;
  return enoughSamples && mine.rate < theirs.rate ? challenger : own;
}

const Critique = z.object({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.agent('reviewerA')
  .role(reviewer)
  .model(H.policy.model('reviewerAModel', [primaryA, challenger], ctx => slotModel(ctx, primaryA, primaryB)))
  .output(Critique);

const reviewerB = H.agent('reviewerB')
  .role(reviewer)
  .model(H.policy.model('reviewerBModel', [primaryB, challenger], ctx => slotModel(ctx, primaryB, primaryA)))
  .output(Critique);

const editorialRunner = local.runner('editorialRunner');

const factCheck = H.command('factCheck')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(input => ['fact-check', '--entry', input.entryId, '--text', input.body])
  .output(z.object({ issues: z.array(z.string()), repeatMistake: z.string().optional() }))
  .runner(editorialRunner);

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ critiqueA: z.string(), critiqueB: z.string(), factIssues: z.array(z.string()) }))
  .argv(input => ['merge-critiques', '--a', input.critiqueA, '--b', input.critiqueB, '--facts', input.factIssues.join('\n')])
  .output(z.object({ merged: z.string() }))
  .runner(editorialRunner);

const EditorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['reviewA', 'reviewB'])),
  sectionOnly: z.boolean(),
});

const reviewFlow = H.flow('draftReview')
  .input(DraftAttributes)
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('reviewA', reviewerA, ctx => ({
    task: `Review "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [sectionResource(ctx.unit.attributes.section)],
  }))
  .step('reviewB', reviewerB, ctx => ({
    task: `Review "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    resources: [sectionResource(ctx.unit.attributes.section)],
  }))
  .step('merge', mergeCritiques, ctx => ({
    critiqueA: ctx.steps.reviewA.critique,
    critiqueB: ctx.steps.reviewB.critique,
    factIssues: ctx.steps.factCheck.issues,
  }))
  .halt('editorDecision', {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"?\n\n${ctx.steps.merge.merged}`,
    decision: EditorDecision,
  })
  .exit('accepted', ctx => ctx.steps.editorDecision.action === 'accept')
  .exit('returned');

const drafts = H.lane('drafts', Draft)
  .supply(
    contentful.drafts({ space: 'publication', token: H.env('CONTENTFUL_TOKEN'), everyMinutes: 10 }),
    (entry, to) => to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .store(contentful.store({ space: 'publication', token: H.env('CONTENTFUL_TOKEN') }))
  .handler(reviewFlow, {
    exits: { accepted: Accepted, returned: Returned },
    during: { factCheck: Reviewing, editorDecision: WithEditor },
  });

const editorActedOn = H.metric('editorActedOn')
  .from(H.when.step(drafts, 'editorDecision'))
  .samples(event => {
    const decision = event.output;
    if (decision === undefined) return [];
    const samples: Sample[] = [];
    const modelA = event.models.reviewA;
    const modelB = event.models.reviewB;
    if (typeof modelA === 'string') samples.push({ group: modelA, hit: decision.actedOn.includes('reviewA') });
    if (typeof modelB === 'string') samples.push({ group: modelB, hit: decision.actedOn.includes('reviewB') });
    return samples;
  });

const editorTaste = H.memory('editorTaste').trust('taste');
const factCheckLesson = H.memory('factCheckLesson').trust('experience');

const publicationTaste = H.journal('publicationTaste', editorTaste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall(H.recall('tasteBySpecificity', { by: 'specificity', limit: 25 }))
  .readBy(reviewer);

const factCheckLessons = H.journal('factCheckLessons', factCheckLesson)
  .store(jsonl.memoryStore({ path: 'memory/fact-check.jsonl' }))
  .recall(H.recall('lessonsBySpecificity', { by: 'specificity', limit: 10 }))
  .readBy(reviewer);

const returnedNotesBecomeTaste = H.trigger('returnedNotesBecomeTaste')
  .on(H.when.step(drafts, 'editorDecision', { if: event => event.output?.action === 'return' }))
  .record(publicationTaste, event =>
    event.output === undefined
      ? undefined
      : {
          body: { text: event.output.notes },
          status: 'candidate',
          when: event.output.sectionOnly
            ? { kinds: [Draft], resources: [sectionResource(event.unit.attributes.section)] }
            : { kinds: [Draft] },
        },
  );

const repeatMistakesBecomeExperience = H.trigger('repeatMistakesBecomeExperience')
  .on(H.when.step(drafts, 'factCheck', { if: event => typeof event.output?.repeatMistake === 'string' }))
  .record(factCheckLessons, event =>
    typeof event.output?.repeatMistake === 'string'
      ? { body: { text: event.output.repeatMistake }, when: { kinds: [Draft], roles: [reviewer] } }
      : undefined,
  );

export const contentReview = H.harness('contentReview')
  .ledger(sqlite.ledger({ path: 'state/ledger.db' }))
  .pools(editorialPool)
  .lanes(drafts)
  .journals(publicationTaste, factCheckLessons)
  .triggers(returnedNotesBecomeTaste, repeatMistakesBecomeExperience)
  .metrics(editorActedOn)
  .scheduler(H.scheduler('editorial').priority(drafts))
  .clients(
    claudeCode.supervisor('editorDesk', {
      grants: [
        H.ops.workRead,
        H.ops.blockersResolve,
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.memoryCurate,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
