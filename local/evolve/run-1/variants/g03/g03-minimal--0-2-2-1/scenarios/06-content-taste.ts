import { z } from 'zod';
import { H, type Agent, type Model, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const submission = z.object({
  title: z.string(),
  body: z.string(),
  section: z.string(),
  editorNotes: z.string(),
});
type Submission = z.infer<typeof submission>;

const critique = z.object({
  critique: z.string(),
  points: z.array(z.string()),
});
type Critique = z.infer<typeof critique>;

const draftNew = H.state('draft-new', 'pending');
const draftReviewing = H.state('draft-reviewing', 'active');
const draftAwaitingEditor = H.state('draft-awaiting-editor', 'active');
const draftWithAuthor = H.state('draft-with-author', 'waiting');
const draftAccepted = H.state('draft-accepted', 'terminal', 'success');
const draftWithdrawn = H.state('draft-withdrawn', 'terminal', 'neutral');
const draftUnreviewable = H.state('draft-unreviewable', 'terminal', 'failure');

const draft = H.kind('draft')
  .data(submission)
  .states(draftNew, draftReviewing, draftAwaitingEditor, draftWithAuthor, draftAccepted, draftWithdrawn, draftUnreviewable)
  .failsTo('draft-unreviewable');

const reviewer = H.role('reviewer')
  .input(submission)
  .output(critique)
  .prompt((d) => `Critique this ${d.section} draft for the editor. Name concrete changes.\n\n# ${d.title}\n\n${d.body}`)
  .intents(['read']);

const editorialTaste = H.memory('editorial-taste', 'taste');
const factCheckLessons = H.memory('fact-check-lessons', 'experience');
const tasteLibrary = H.library('editor-taste', editorialTaste, jsonl.memory('memory/editor-taste.jsonl'));
const factLibrary = H.library('fact-check', factCheckLessons, jsonl.memory('memory/fact-check.jsonl'));

const editorVerdict = H.halt('editor-verdict', z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
}));

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');

const reviewerModels = H.policy.model('reviewer-ab-swap', ({ agent, metrics }) => {
  const actedOn = (critic: Agent<Submission, Critique>, model: Model) =>
    metrics.rateBy({
      among: editorVerdict.resolved(),
      count: editorVerdict.resolved(critic.name === criticA.name ? { actedOnA: true } : { actedOnB: true }),
      by: { modelOf: critic },
      days: 60,
    }).get(model);
  const mineIsA = agent.name === criticA.name;
  const incumbent = mineIsA ? opus : sonnet;
  const mine = mineIsA ? actedOn(criticA, opus) : actedOn(criticB, sonnet);
  const theirs = mineIsA ? actedOn(criticB, sonnet) : actedOn(criticA, opus);
  if (mine.value === null || theirs.value === null) return incumbent;
  if (mine.samples < 50 || theirs.samples < 50) return incumbent;
  return mine.value < theirs.value ? challenger : incumbent;
});

const criticA: Agent<Submission, Critique> = H.agent('critic-a', reviewer)
  .model(reviewerModels)
  .recalls(tasteLibrary, factLibrary);

const criticB: Agent<Submission, Critique> = H.agent('critic-b', reviewer)
  .model(reviewerModels)
  .recalls(tasteLibrary, factLibrary);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(submission)
  .output(z.object({
    issues: z.array(z.string()),
    repeats: z.array(z.object({ text: z.string(), because: z.string() })),
  }))
  .argv((d) => ['factcheck', '--title', d.title, '--section', d.section, '--json'])
  .on(local);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique, facts: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .argv((m) => ['merge-critiques', '--a', m.a.critique, '--b', m.b.critique, ...m.facts.flatMap((fact) => ['--fact', fact])])
  .on(local);

const review = H.flow('draft-review').for(draft).does(async (ctx) => {
  await ctx.move('draft-reviewing');
  const scope = { resources: [ctx.unit.data.section] };
  const a = await ctx.run(criticA, ctx.unit.data, { scope });
  if (!a.ok) return ctx.fail(a.error);
  const b = await ctx.run(criticB, ctx.unit.data, { scope });
  if (!b.ok) return ctx.fail(b.error);
  const facts = await ctx.run(factCheck, ctx.unit.data);
  if (!facts.ok) return ctx.fail(facts.error);
  for (const repeat of facts.value.repeats) {
    await ctx.remember(factLibrary, { text: repeat.text, because: repeat.because, when: { roles: [reviewer] } });
  }
  const merged = await ctx.run(mergeCritiques, { a: a.value, b: b.value, facts: facts.value.issues });
  if (!merged.ok) return ctx.fail(merged.error);
  await ctx.move('draft-awaiting-editor');
  const verdict = await ctx.halt(editorVerdict, merged.value.merged);
  if (verdict.action === 'accept') return 'draft-accepted';
  await ctx.update({ editorNotes: verdict.notes });
  return 'draft-with-author';
});

const notesToTaste = H.trigger(
  'returned-notes-to-taste',
  H.on.enters(draft, 'draft-with-author'),
  (event, act) =>
    act.remember(tasteLibrary, {
      text: event.unit.data.editorNotes,
      because: `the editor returned "${event.unit.data.title}" with these notes`,
      when: { kinds: [draft], resources: [event.unit.data.section] },
      status: 'candidate',
    })
);

const cmsQueue = z.object({
  drafts: z.array(z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    section: z.string(),
    status: z.enum(['submitted', 'resubmitted', 'withdrawn']),
  })),
});
type CmsDraft = z.infer<typeof cmsQueue>['drafts'][number];

const fromCms = (d: CmsDraft): SupplyOf<typeof draft> => {
  if (d.status === 'withdrawn') return { update: d.id, state: 'draft-withdrawn' };
  if (d.status === 'resubmitted') return { update: d.id, patch: { title: d.title, body: d.body }, state: 'draft-new' };
  return { create: { title: d.title, body: d.body, section: d.section, editorNotes: '' }, key: d.id };
};

const cms = http.poll(draft, {
  url: 'https://cms.example.com/api/review-queue',
  every: { minutes: 5 },
  headers: { authorization: H.env('CMS_TOKEN') },
  body: cmsQueue,
  read: (body) => body.drafts.map(fromCms),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: { authorization: H.env('CMS_TOKEN') },
  stateField: 'reviewState',
});

const drafts = H.lane('drafts', draft)
  .handler(review)
  .suppliers(cms)
  .store(cmsStore)
  .wip(4);

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewerPool = H.pool('reviewers', [{ account: api, share: 1 }]);

const editorDesk = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('content-review.db'))
  .lanes(drafts)
  .pools(reviewerPool)
  .triggers(notesToTaste)
  .clients(editorDesk)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
