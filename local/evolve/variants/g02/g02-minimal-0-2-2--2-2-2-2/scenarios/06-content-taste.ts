import { H, type Model, type Metrics, type SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
const sectionFacet = H.facet('section', sectionSchema);

const draft = H.kind('draft')
  .data(z.object({ title: z.string(), section: sectionSchema, body: z.string(), editorNotes: z.string().optional() }))
  .states(submitted, returned, accepted);

const reviewRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: sectionSchema, body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt((i) => `Critique this ${i.section} draft, "${i.title}":\n\n${i.body}`);

const taste = H.journal('editor-taste', H.memory('editor-taste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-lessons', 'experience'), jsonl.memory('memory/fact-checks.jsonl'));

const editorReview = H.halt(
  'editor-review',
  z.object({ verdict: z.enum(['accept', 'return']), notes: z.string(), actedOn: z.array(z.string()) })
)
  .about(z.object({
    title: z.string(),
    merged: z.string(),
    critiques: z.array(z.object({ invocation: z.string(), critique: z.string() })),
  }))
  .credits((decision) => decision.actedOn);

const candidates = [
  claudeCode.model('claude-sonnet-4-5'),
  claudeCode.model('claude-opus-4-1'),
  claudeCode.model('claude-haiku-4-5'),
];
const trialSamples = 50;

const reviewerPair = (metrics: Metrics): [Model, Model] => {
  const uptake = metrics.rateBy({
    among: { entry: 'invocation', mode: 'model' },
    count: { entry: 'credit', halt: editorReview },
    by: 'model',
    days: 90,
  });
  const samplesOf = (m: Model) => uptake[m.name]?.samples ?? 0;
  const valueOf = (m: Model) => uptake[m.name]?.value ?? 0;
  const seasoned = candidates.filter((m) => samplesOf(m) >= trialSamples).sort((a, b) => valueOf(b) - valueOf(a));
  const untried = candidates.filter((m) => samplesOf(m) < trialSamples);
  const keep = seasoned[0] ?? untried[0] ?? candidates[0];
  const challenger = untried.find((m) => m !== keep) ?? seasoned.find((m) => m !== keep) ?? candidates[1];
  return [keep, challenger];
};

const reviewerA = H.seat('reviewer-a', reviewRole)
  .model(H.policy.model('reviewer-a-model', (choice) => reviewerPair(choice.metrics)[0]))
  .recalls(taste, factLessons);
const reviewerB = H.seat('reviewer-b', reviewRole)
  .model(H.policy.model('reviewer-b-model', (choice) => reviewerPair(choice.metrics)[1]))
  .recalls(taste, factLessons);

const local = shell.local('local', { slots: 4 });
const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ rule: z.string(), because: z.string() })) }))
  .argv((i) => ['fact-check', '--json', i.body])
  .on(local);
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ critiques: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .argv((i) => ['merge-critiques', '--json', ...i.critiques])
  .on(local);

const review = H.flow('review-draft')
  .for(draft)
  .does(async (ctx) => {
    const { title, section, body } = ctx.unit.data;
    ctx.tag(sectionFacet, section);
    const checked = await ctx.run(factCheck, { body });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(factLessons, { text: mistake.rule, because: mistake.because, when: { roles: [reviewRole] } });
    }
    const scoped = { scope: { facets: [sectionFacet.value(section)] } };
    const a = await ctx.run(reviewerA, { title, section, body }, scoped);
    if (!a.ok) return ctx.fail(a.error);
    const b = await ctx.run(reviewerB, { title, section, body }, scoped);
    if (!b.ok) return ctx.fail(b.error);
    const merged = await ctx.run(mergeCritiques, { critiques: [a.value.critique, b.value.critique] });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorReview, `Review "${title}" (${section})`, {
      title,
      merged: merged.value.merged,
      critiques: [
        { invocation: a.invocation, critique: a.value.critique },
        { invocation: b.invocation, critique: b.value.critique },
      ],
    });
    if (decision.verdict === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready-for-review',
  every: { minutes: 5 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({ id: z.string(), title: z.string(), section: sectionSchema, body: z.string(), revision: z.number() })),
  }),
  read: (body) =>
    body.drafts.map((d): SupplyOf<typeof draft> =>
      d.revision > 1
        ? { update: d.id, patch: { title: d.title, body: d.body }, state: 'submitted' }
        : { create: { title: d.title, section: d.section, body: d.body }, key: d.id }
    ),
});

const drafts = H.lane('drafts', draft)
  .handler(review)
  .suppliers(cmsPoll)
  .store(http.store(draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_state' }))
  .retry(H.retry({ times: 2 }), 'returned');

const notesBecomeTaste = H.trigger('returned-notes-become-taste-candidates', H.on.enters(draft, 'returned'), (event, act) => {
  const { title, section, editorNotes } = event.unit.data;
  if (editorNotes === undefined || editorNotes === '') return [];
  return act.remember(taste, {
    text: `When reviewing ${section} drafts, apply the editor's note: ${editorNotes}`,
    because: `the editor returned "${title}" with this note`,
    when: { roles: [reviewRole], facets: [sectionFacet.value(section)] },
    status: 'candidate',
  });
});

const uptake = H.report('critique-uptake', (metrics) => ({
  ...Object.fromEntries(
    Object.entries(
      metrics.rateBy({ among: { entry: 'invocation', mode: 'model' }, count: { entry: 'credit', halt: editorReview }, by: 'seat', days: 90 })
    ).map(([seat, rate]) => [`uptake, seat ${seat}`, rate])
  ),
  ...Object.fromEntries(
    Object.entries(
      metrics.rateBy({ among: { entry: 'invocation', mode: 'model' }, count: { entry: 'credit', halt: editorReview }, by: 'model', days: 90 })
    ).map(([model, rate]) => [`uptake, model ${model}`, rate])
  ),
  'drafts accepted (30d)': metrics.count({ of: { entry: 'transition', kind: draft, state: accepted }, days: 30 }),
  'drafts returned (30d)': metrics.count({ of: { entry: 'transition', kind: draft, state: returned }, days: 30 }),
}));

const editorAccount = claudeCode.subscription('max-1', { token: H.env('CLAUDE_TOKEN') });

export default H.harness('content-review')
  .ledger(sqlite.ledger('harness/ledger.db'))
  .lanes(drafts)
  .pools(H.pool('claude', [{ account: editorAccount, share: 1 }]))
  .triggers(notesBecomeTaste)
  .reports(uptake)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(editorReview),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
