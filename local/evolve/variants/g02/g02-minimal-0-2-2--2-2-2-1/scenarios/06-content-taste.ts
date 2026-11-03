import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sectionSchema);

const submitted = H.state('submitted', 'pending');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'neutral');
const stalled = H.state('stalled', 'terminal', 'failure');

export const draft = H.kind('draft')
  .data(z.object({ title: z.string(), body: z.string(), section: sectionSchema, editorNotes: z.string().optional() }))
  .states(submitted, accepted, returned, stalled);

type DraftSupply = SupplyOf<typeof draft>;

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready-for-review',
  every: { minutes: 5 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(
      z.object({ id: z.string(), title: z.string(), body: z.string(), section: sectionSchema, harnessState: z.string().nullable() })
    ),
  }),
  read: body =>
    body.drafts.flatMap((found): DraftSupply[] =>
      found.harnessState === null
        ? [{ create: { title: found.title, body: found.body, section: found.section }, key: found.id }]
        : found.harnessState === 'returned'
          ? [{ update: found.id, patch: { title: found.title, body: found.body }, state: 'submitted' }]
          : []
    ),
});

const cmsStore = http.store(draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'harnessState' });

const editorTaste = H.journal('editor-taste', H.memory('editor-taste', 'taste'), jsonl.memory('memory/editor-taste.jsonl'));
const factLessons = H.journal('fact-lessons', H.memory('fact-checking', 'experience'), jsonl.memory('memory/fact-lessons.jsonl'));

const review = H.role('review')
  .input(z.object({ title: z.string(), body: z.string(), section: sectionSchema }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}":\n\n${input.body}`);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-opus-4');
const reviewPool = H.pool('review-api', [{ account: anthropic.account('review-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const swapWeakerAfterFifty = (name: string, mine: Model, rival: Model) =>
  H.policy.model(name, choice => {
    const uptake = choice.metrics.rateBy({
      among: { entry: 'credit', role: review },
      count: { entry: 'credit', role: review, credited: true },
      by: 'model',
      days: 90,
    });
    const rateOf = (model: Model): Rate => uptake[model.name] ?? { value: null, hits: 0, samples: 0 };
    const own = rateOf(mine);
    const other = rateOf(rival);
    return own.samples >= 50 && other.samples >= 50 && (own.value ?? 0) < (other.value ?? 0) ? challenger : mine;
  });

const reviewerA = H.seat('reviewer-a', review)
  .model(swapWeakerAfterFifty('reviewer-a-model', opus, sonnet))
  .recalls(editorTaste, factLessons);
const reviewerB = H.seat('reviewer-b', review)
  .model(swapWeakerAfterFifty('reviewer-b-model', sonnet, opus))
  .recalls(editorTaste, factLessons);

const local = shell.local('local', { slots: 2 });

const factCheck = H.command('fact-check')
  .input(z.object({ draftId: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.string()) }))
  .argv(input => ['fact-check', '--draft', input.draftId])
  .on(local);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.first, '--second', input.second])
  .on(local);

const editorReview = H.halt('editor-review', z.object({ action: z.enum(['accept', 'return']), notes: z.string() })).about(
  z.object({ merged: z.string() })
);

const draftReview = H.flow('draft-review')
  .for(draft)
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    const inSection = ctx.unit.data.section;
    ctx.tag(section, inSection);
    const scoped = { scope: { facets: [section.value(inSection)] } };
    const facts = await ctx.call(factCheck, { draftId: ctx.unit.key });
    if (!facts.ok) return ctx.fail(facts.error);
    for (const mistake of facts.value.repeatMistakes) {
      await ctx.remember(factLessons, {
        text: `When reviewing a draft, verify ${mistake}`,
        because: 'the fact check found this mistake more than once',
        when: { roles: [review] },
      });
    }
    const first = await ctx.call(reviewerA, { title, body, section: inSection }, scoped);
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.call(reviewerB, { title, body, section: inSection }, scoped);
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.call(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorReview, `Review "${title}"`, { merged: merged.value }, { credit: [first, second] });
    if (decision.action === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

export const drafts = H.lane('drafts', draft)
  .handler(draftReview)
  .suppliers(cmsPoll)
  .store(cmsStore)
  .wip(3)
  .retry(H.retry('draft-retries', { retries: 2, backoff: { initialMs: 60_000, factor: 2 } }), 'stalled');

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(draft, 'returned'), (event, act) =>
  act.remember(editorTaste, {
    text: `When reviewing ${event.unit.data.section} drafts, ${event.unit.data.editorNotes ?? 'apply the editor notes'}`,
    because: `the editor returned "${event.unit.data.title}" for it`,
    status: 'candidate',
    when: { kinds: [draft], facets: [section.value(event.unit.data.section)] },
  })
);

export const reviewerUptake = H.report('reviewer-uptake', metrics => ({
  bySeat: metrics.rateBy({
    among: { entry: 'credit', role: review },
    count: { entry: 'credit', role: review, credited: true },
    by: 'seat',
    days: 90,
  }),
  byModel: metrics.rateBy({
    among: { entry: 'credit', role: review },
    count: { entry: 'credit', role: review, credited: true },
    by: 'model',
    days: 90,
  }),
}));

const editor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorReview, H.parked),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('content-review.db'))
  .lanes(drafts)
  .pools(reviewPool)
  .triggers(returnedNotesBecomeTaste)
  .reports(reviewerUptake)
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
