import { z } from 'zod';
import { H, type Metrics, type Model } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const draft = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
});
const critique = z.object({
  points: z.array(z.string()),
  recommendation: z.enum(['publish', 'revise']),
});
const factReport = z.object({
  claimsChecked: z.number(),
  repeats: z.array(z.object({ claim: z.string(), lesson: z.string() })),
});
const mergedCritique = z.object({ summary: z.string() });
const editorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['a', 'b'])),
  sectionOnly: z.boolean(),
});

const Inbox = H.state('inbox', 'pending');
const Returned = H.state('returned', 'waiting');
const Accepted = H.terminal('accepted', 'success');
const Withdrawn = H.terminal('withdrawn', 'neutral');

const Draft = H.kind('Draft')
  .attributes(draft)
  .states(Inbox, Returned, Accepted, Withdrawn)
  .key(d => d.entryId)
  .initial(Inbox)
  .onCancelled(Withdrawn);

const Revised = H.signal('revised').payload(z.object({ title: z.string(), body: z.string() }));

const reviewer = H.role('reviewer')
  .intents('read', 'search')
  .instructions('Critique the draft against the house taste you are given. Be specific and cite passages.');

const taste = H.memory('editor-taste').trust('taste');
const factLesson = H.memory('fact-lesson').trust('experience');

const editorTaste = H.journal('editor-taste', taste)
  .store(jsonl.memoryStore({ path: 'content/memory/taste.jsonl' }))
  .recall(H.recall('taste-by-scope', { by: 'specificity', limit: 20 }))
  .readBy(reviewer);

const factLessons = H.journal('fact-lessons', factLesson)
  .store(jsonl.memoryStore({ path: 'content/memory/fact-lessons.jsonl' }))
  .recall(H.recall('lessons-by-scope', { by: 'specificity', limit: 10 }))
  .readBy(reviewer);

const actedOn = H.metric('critique-acted-on', 'rate');

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const contenders = [opus, sonnet, haiku];

const publisher = anthropic.account('publisher', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewPool = H.pool('review').accounts(publisher).serves(opus, sonnet, haiku);

function lineup(metrics: Metrics): readonly Model[] {
  const standings = contenders.map(model => ({ model, standing: metrics.rate(actedOn, { group: model.name }) }));
  const tested = standings
    .filter(entry => entry.standing.samples >= 50)
    .sort((left, right) => right.standing.rate - left.standing.rate)
    .map(entry => entry.model);
  const untested = standings.filter(entry => entry.standing.samples < 50).map(entry => entry.model);
  return [...tested.slice(0, 1), ...untested, ...tested.slice(1)];
}

const slotA = H.policy.model('reviewer-slot-a', contenders, ctx => lineup(ctx.metrics)[0] ?? opus);
const slotB = H.policy.model('reviewer-slot-b', contenders, ctx => lineup(ctx.metrics)[1] ?? sonnet);

const reviewerA = H.agent('reviewer-a').role(reviewer).model(slotA).output(critique);
const reviewerB = H.agent('reviewer-b').role(reviewer).model(slotB).output(critique);

const desk = local.runner('desk').slots(4);

const factCheck = H.command('fact-check')
  .input(draft)
  .argv(d => ['fact-check', '--entry', d.entryId])
  .output(factReport)
  .runner(desk);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique, facts: factReport }))
  .argv(critiques => ['merge-critiques', JSON.stringify(critiques)])
  .output(mergedCritique)
  .runner(desk);

function brief(d: z.infer<typeof draft>): string {
  return `Critique the ${d.section} draft "${d.title}".\n\n${d.body}`;
}

const reviewFlow = H.flow('draft-review')
  .input(draft)
  .step('critiqueA', reviewerA, ctx => ({ task: brief(ctx.unit.attributes), skills: [ctx.unit.attributes.section] }))
  .step('critiqueB', reviewerB, ctx => ({ task: brief(ctx.unit.attributes), skills: [ctx.unit.attributes.section] }))
  .step('factCheck', factCheck, ctx => ctx.unit.attributes)
  .step('merge', mergeCritiques, ctx => ({
    a: ctx.steps.critiqueA,
    b: ctx.steps.critiqueB,
    facts: ctx.steps.factCheck,
  }))
  .halt('editor', editorDecision, {
    ask: ctx =>
      `Accept or return "${ctx.unit.attributes.title}"? Say which critiques (a, b) you acted on.\n\n${ctx.steps.merge.summary}`,
  })
  .exit('accepted', ctx => ctx.steps.editor.action === 'accept')
  .exit('returned');

const drafts = H.lane('drafts', Draft)
  .supply(
    contentful.drafts({ space: 'newsroom', token: H.env('CONTENTFUL_TOKEN'), everyMinutes: 10 }),
    (entry, to) => [
      to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
      to.signal(Revised, unit => unit.key === entry.id && unit.state === 'returned', {
        title: entry.title,
        body: entry.body,
      }),
    ],
  )
  .store(contentful.store({ space: 'newsroom', token: H.env('CONTENTFUL_TOKEN') }))
  .handler(reviewFlow, { exits: { accepted: Accepted, returned: Returned } })
  .on(Revised, {
    update: (d, revision) => ({ ...d, title: revision.title, body: revision.body }),
    restart: 'critiqueA',
  });

const actedOnDefinition = actedOn.from(H.when.step(drafts, 'editor'), event => {
  const decision = event.output;
  if (decision === undefined) return [];
  return [
    event.models.critiqueA === undefined
      ? undefined
      : { group: event.models.critiqueA, hit: decision.actedOn.includes('a') },
    event.models.critiqueB === undefined
      ? undefined
      : { group: event.models.critiqueB, hit: decision.actedOn.includes('b') },
  ];
});

const notesToTaste = H.trigger(
  'returned-notes-to-taste',
  H.when.step(drafts, 'editor', { if: event => event.output?.action === 'return' }),
).record(editorTaste, event =>
  event.output === undefined || event.output.notes.trim() === ''
    ? undefined
    : {
        body: { text: event.output.notes },
        when: event.output.sectionOnly
          ? { kinds: [Draft], roles: [reviewer], skills: [event.unit.attributes.section] }
          : { kinds: [Draft], roles: [reviewer] },
        status: 'candidate',
      },
);

const repeatMistakesToLessons = H.trigger('repeat-mistakes-to-lessons', H.when.step(drafts, 'factCheck')).record(
  factLessons,
  event => {
    const repeat = event.output?.repeats[0];
    return repeat === undefined
      ? undefined
      : { body: { text: repeat.lesson }, when: { kinds: [Draft], roles: [reviewer] }, status: 'active' };
  },
);

const deskScheduler = H.scheduler('desk')
  .priority(drafts)
  .rank(drafts, d => d.createdAt.getTime());

export default H.harness('content-review')
  .ledger(sqlite.ledger({ path: 'content/ledger.sqlite' }))
  .pools(reviewPool)
  .lanes(drafts)
  .journals(editorTaste, factLessons)
  .triggers(notesToTaste, repeatMistakesToLessons)
  .metrics(actedOnDefinition)
  .scheduler(deskScheduler)
  .clients(
    claudeCode.supervisor('editor-desk', {
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
  .observers(
    markdown.board({ path: 'content/BOARD.md' }),
    markdown.telemetry({ path: 'content/TELEMETRY.md' }),
  );
