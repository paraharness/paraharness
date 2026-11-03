import { H, type Json, type Metrics, type Model } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { rest } from 'harness-dsl/rest';
import { local } from 'harness-dsl/runners';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/projections';

const Submitted = H.state('Submitted').pending();
const Reviewing = H.state('Reviewing').active();
const AwaitingEditor = H.state('AwaitingEditor').active();
const Accepted = H.state('Accepted').succeeded();
const Returned = H.state('Returned').ended();
const Failed = H.state('Failed').failed();

const actedOn = z.enum(['a', 'b', 'both', 'none']);

const draftSchema = z.object({
  cmsId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
  editorNotes: z.string().nullable(),
  actedOn: actedOn.nullable(),
});
type DraftData = z.infer<typeof draftSchema>;

const Draft = H.work('draft')
  .schema(draftSchema)
  .states(Submitted, Reviewing, AwaitingEditor, Accepted, Returned, Failed)
  .key(d => d.cmsId)
  .resources(d => [`section:${d.section}`]);

const cmsRecord = z.object({ id: z.string(), title: z.string(), section: z.string(), body: z.string(), status: z.literal('ready-for-review') });

const fromCms = (record: Json): DraftData | null => {
  const parsed = cmsRecord.safeParse(record);
  if (!parsed.success) return null;
  return { cmsId: parsed.data.id, title: parsed.data.title, section: parsed.data.section, body: parsed.data.body, editorNotes: null, actedOn: null };
};

const Taste = H.memory('editorial-taste').content(z.object({ preference: z.string() })).taste();
const FactLesson = H.memory('fact-check-lesson').content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }));

const tasteJournal = H.journal('editorial-taste').of(Taste).store(jsonl.memory('memory/taste.jsonl')).recall(byApplicability({ budgetTokens: 1500 }));
const factJournal = H.journal('fact-check-lessons').of(FactLesson).store(jsonl.memory('memory/fact-checks.jsonl')).recall(byApplicability({ budgetTokens: 800 }));

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('opus', api, 'claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('sonnet', api, 'claude-sonnet-4-5').pricing(anthropic.pricing());
const challenger = H.model('haiku', api, 'claude-haiku-4-5').pricing(anthropic.pricing());

const critiqueSteps = { a: 'critique-a', b: 'critique-b' } as const;

const actedOnStats = (metrics: Metrics, model: Model): { readonly samples: number; readonly rate: number | null } => {
  let samples = 0;
  let acted = 0;
  for (const t of metrics.transitions(Draft, { windowDays: 120, to: [Accepted, Returned] })) {
    const invocation = t.attempt?.invocations.find(
      i => i.model === model.name && (i.step === critiqueSteps.a || i.step === critiqueSteps.b),
    );
    if (invocation === undefined) continue;
    samples += 1;
    const slot = invocation.step === critiqueSteps.a ? 'a' : 'b';
    if (t.unit.data.actedOn === slot || t.unit.data.actedOn === 'both') acted += 1;
  }
  return { samples, rate: samples === 0 ? null : acted / samples };
};

const swapWhenWeaker = (name: string, incumbent: Model, rival: Model, reserve: Model) =>
  H.policy.pick<Model>(name, ctx => {
    const mine = actedOnStats(ctx.metrics, incumbent);
    const theirs = actedOnStats(ctx.metrics, rival);
    const weaker = mine.samples >= 50 && theirs.samples >= 50 && (mine.rate ?? 0) < (theirs.rate ?? 0);
    return weaker ? [reserve, incumbent] : [incumbent, reserve];
  });

const reviewerAModels = H.pool('reviewer-a-models', [opus, challenger]).policy(swapWhenWeaker('reviewer-a-swap', opus, sonnet, challenger));
const reviewerBModels = H.pool('reviewer-b-models', [sonnet, challenger]).policy(swapWhenWeaker('reviewer-b-swap', sonnet, opus, challenger));

const reviewerRole = H.role('reviewer')
  .prompt('You critique a draft for the editor: argument, accuracy, clarity, house style.')
  .tools()
  .recall(Taste, FactLesson);

const critique = H.skill('critique')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ points: z.array(z.string()) }))
  .prompt(i => `Section: ${i.section}\nTitle: ${i.title}\n\n${i.body}`);

const reviewerA = H.agent('reviewer-a').role(reviewerRole).model(reviewerAModels);
const reviewerB = H.agent('reviewer-b').role(reviewerRole).model(reviewerBModels);

const deskRunner = local('desk').slots(4);

const factIssue = z.object({ claim: z.string(), problem: z.string(), repeat: z.boolean() });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ issues: z.array(z.object({ claim: z.string(), problem: z.string() })) }))
  .runner(deskRunner)
  .run(async ctx => {
    const result = await ctx.exec('fact-check', ['--json'], { stdin: ctx.input.body });
    const issues = z.array(factIssue).parse(JSON.parse(result.stdout));
    for (const issue of issues.filter(i => i.repeat)) {
      await ctx.record(factJournal, {
        content: { action: `verify claims like "${issue.claim}" against a primary source`, condition: 'when a draft makes this kind of claim', reason: issue.problem },
        when: { kinds: [Draft], roles: [reviewerRole] },
      });
    }
    return { issues: issues.map(i => ({ claim: i.claim, problem: i.problem })) };
  });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.array(z.string()), b: z.array(z.string()), facts: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .runner(deskRunner)
  .run(async ctx => {
    const unique = (points: readonly string[]) => [...new Set(points.map(p => p.trim()))];
    const merged = [
      '## Reviewer A',
      ...unique(ctx.input.a).map(p => `- ${p}`),
      '## Reviewer B',
      ...unique(ctx.input.b).map(p => `- ${p}`),
      '## Fact check',
      ...unique(ctx.input.facts).map(p => `- ${p}`),
    ].join('\n');
    return { merged };
  });

const reviewFlow = H.flow('review')
  .of(Draft)
  .transition(Reviewing)
  .parallel('critiques', {
    a: b => b.step(critiqueSteps.a, reviewerA.perform(critique), s => ({ title: s.unit.data.title, section: s.unit.data.section, body: s.unit.data.body })),
    b: b => b.step(critiqueSteps.b, reviewerB.perform(critique), s => ({ title: s.unit.data.title, section: s.unit.data.section, body: s.unit.data.body })),
  })
  .step('facts', factCheck, s => ({ body: s.unit.data.body }))
  .step('merge', mergeCritiques, s => ({
    a: s.steps.a[critiqueSteps.a].points,
    b: s.steps.b[critiqueSteps.b].points,
    facts: s.steps.facts.issues.map(i => `${i.claim}: ${i.problem}`),
  }))
  .transition(AwaitingEditor)
  .halt('editor', {
    ask: s => `Review "${s.unit.data.title}" (${s.unit.data.section}).\n\n${s.steps.merge.merged}`,
    decision: z.object({ accept: z.boolean(), notes: z.string(), actedOn }),
  })
  .update(s => ({ editorNotes: s.steps.editor.notes, actedOn: s.steps.editor.actedOn }))
  .transition(s => (s.steps.editor.accept ? Accepted : Returned));

const cmsToken = H.env('CMS_TOKEN');

const drafts = H.lane('drafts')
  .of(Draft)
  .from(rest.poll({ url: H.env('CMS_REVIEW_QUEUE_URL'), token: cmsToken, everyMinutes: 15, map: fromCms }))
  .store(rest.store({ baseUrl: H.env('CMS_URL'), token: cmsToken, path: (_kind, key) => `/drafts/${key}` }))
  .handle(reviewFlow);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(drafts.enters(Returned))
  .where(e => e.unit.data.editorNotes !== null && e.unit.data.editorNotes.trim() !== '')
  .record(
    tasteJournal,
    e =>
      e.unit.data.editorNotes === null
        ? null
        : { content: { preference: e.unit.data.editorNotes }, when: { kinds: [Draft], resources: [`section:${e.unit.data.section}`] } },
    { candidate: true },
  );

const oldestFirst = H.policy.schedule('oldest-first', ctx => ({
  start: [...ctx.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const supervisor = H.supervisor('editor')
  .endpoint(claudeCode.endpoint({ server: 'content-review' }))
  .grant(H.ops.work.read, H.ops.blockers.resolve, H.ops.memory.read, H.ops.memory.write, H.ops.memory.curate, H.ops.telemetry.read);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste)
  .scheduler(H.scheduler('review').concurrency(3).policy(oldestFirst))
  .supervisor(supervisor)
  .projections(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const run = contentReview.start();
