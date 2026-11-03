import { H } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const Received = H.state('Received', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingEditor = H.state('AwaitingEditor', 'waiting');
const Accepted = H.terminal('Accepted', 'success');
const Returned = H.terminal('Returned', 'neutral');
const Abandoned = H.terminal('Abandoned', 'failure');

const draftAttrs = z.object({
  id: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});

const Draft = H.kind('Draft')
  .attributes(draftAttrs)
  .states(Received, Reviewing, AwaitingEditor, Accepted, Returned, Abandoned)
  .key(draft => draft.id)
  .initial(Received);

const reviewer = H.role('reviewer')
  .intents('read')
  .instructions('Critique the draft for clarity, accuracy and house style. Return concrete, actionable points.');

const apiAccount = anthropic.account('publication', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const challenger = anthropic.model('challenger', { id: 'claude-opus-4-5' });
const pool = H.pool('publication').accounts(apiAccount);

const critiqueActedOn = H.metric.rate('critiqueActedOn');

const reviewerModelA = H.policy.model('reviewerModelA', [opus, challenger], ctx => {
  const mine = ctx.metrics.rate(critiqueActedOn, { group: opus.name, window: { lastDays: 60 } });
  const rival = ctx.metrics.rate(critiqueActedOn, { group: sonnet.name, window: { lastDays: 60 } });
  return mine.samples >= 50 && rival.samples >= 50 && mine.rate < rival.rate ? challenger : opus;
});

const reviewerModelB = H.policy.model('reviewerModelB', [sonnet, challenger], ctx => {
  const mine = ctx.metrics.rate(critiqueActedOn, { group: sonnet.name, window: { lastDays: 60 } });
  const rival = ctx.metrics.rate(critiqueActedOn, { group: opus.name, window: { lastDays: 60 } });
  return mine.samples >= 50 && rival.samples >= 50 && mine.rate < rival.rate ? challenger : sonnet;
});

const tasteKind = H.memory('taste', 'taste');
const factCheckLessons = H.memory('factCheckLessons', 'experience');
const memoryStore = jsonl.memoryStore({ path: 'publication/memory.jsonl' });

const tasteJournal = H.journal('editorTaste', tasteKind)
  .store(memoryStore)
  .recall({ by: 'specificity', limit: 20 })
  .readBy(reviewer);

const factJournal = H.journal('factChecks', factCheckLessons)
  .store(memoryStore)
  .recall({ by: 'specificity', limit: 10 })
  .readBy(reviewer);

const critique = z.object({ points: z.array(z.string()) });

const reviewerA = H.agent('reviewerA').role(reviewer).model(reviewerModelA).pool(pool).output(critique);
const reviewerB = H.agent('reviewerB').role(reviewer).model(reviewerModelB).pool(pool).output(critique);

const runner = local.runner('local');

const factCheck = H.command('factCheck')
  .input(z.object({ id: z.string() }))
  .argv(input => ['factcheck', '--draft', input.id])
  .output(z.object({
    issues: z.array(z.string()),
    repeatMistake: z.object({ rule: z.string(), because: z.string() }).optional(),
  }))
  .runner(runner);

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ a: z.array(z.string()), b: z.array(z.string()), facts: z.array(z.string()) }))
  .argv(input => ['merge-critiques', JSON.stringify(input)])
  .output(z.object({ summary: z.string() }))
  .runner(runner);

const editorDecision = z.object({
  action: z.enum(['accept', 'return']),
  actedOn: z.enum(['A', 'B', 'both', 'neither']),
  note: z.object({ rule: z.string(), because: z.string(), sectionOnly: z.boolean() }).optional(),
});

const review = H.flow('review')
  .input(draftAttrs)
  .step('critiqueA', reviewerA, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    skills: [ctx.unit.attributes.section],
  }))
  .step('critiqueB', reviewerB, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}`,
    skills: [ctx.unit.attributes.section],
  }))
  .step('factCheck', factCheck, ctx => ({ id: ctx.unit.attributes.id }))
  .step('merge', mergeCritiques, ctx => ({
    a: ctx.steps.critiqueA.points,
    b: ctx.steps.critiqueB.points,
    facts: ctx.steps.factCheck.issues,
  }))
  .halt('editor', {
    ask: ctx => `Accept or return "${ctx.unit.attributes.title}"? Merged critique:\n${ctx.steps.merge.summary}`,
    decision: editorDecision,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 10 }), (entry, to) =>
    to.create({ id: entry.id, title: entry.title, section: entry.section, body: entry.body }))
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .handler(review, {
    exits: { accepted: Accepted, returned: Returned },
    during: {
      critiqueA: Reviewing,
      critiqueB: Reviewing,
      factCheck: Reviewing,
      merge: Reviewing,
      editor: AwaitingEditor,
    },
  })
  .retry({ maxAttempts: 3, initialDelayMs: 300000, exhausted: Abandoned });

const captureTaste = H.trigger('captureTaste')
  .on(H.when.step(drafts, 'editor', { if: event => event.output?.action === 'return' }))
  .record(tasteJournal, event => {
    const note = event.output?.note;
    return note
      ? {
          text: `${note.rule} because ${note.because}`,
          status: 'candidate',
          when: note.sectionOnly
            ? { kinds: [Draft], roles: [reviewer], skills: [event.unit.attributes.section] }
            : { kinds: [Draft], roles: [reviewer] },
        }
      : undefined;
  });

const captureFactLesson = H.trigger('captureFactLesson')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factJournal, event => {
    const mistake = event.output?.repeatMistake;
    return mistake
      ? { text: `${mistake.rule} because ${mistake.because}`, when: { kinds: [Draft], roles: [reviewer] } }
      : undefined;
  });

const editorActions = H.measure(critiqueActedOn, H.when.step(drafts, 'editor'), event => {
  const actedOn = event.output?.actedOn;
  const modelA = event.models.critiqueA;
  const modelB = event.models.critiqueB;
  if (actedOn === undefined || modelA === undefined || modelB === undefined) return [];
  return [
    { group: modelA, hit: actedOn === 'A' || actedOn === 'both' },
    { group: modelB, hit: actedOn === 'B' || actedOn === 'both' },
  ];
});

const editorDesk = claudeCode.supervisor('editorDesk', {
  grants: [
    H.ops.workRead,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const publication = H.harness('publication')
  .ledger(sqlite.ledger({ path: 'publication/ledger.db' }))
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(captureTaste, captureFactLesson)
  .measurements(editorActions)
  .scheduler(H.scheduler('publication').priority(drafts))
  .clients(editorDesk)
  .observers(
    markdown.board({ path: 'publication/BOARD.md' }),
    markdown.telemetry({ path: 'publication/TELEMETRY.md' }),
  );
