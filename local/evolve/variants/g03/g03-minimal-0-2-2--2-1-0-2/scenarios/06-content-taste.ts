import { z } from 'zod';
import { H, type Metrics, type Model, type Rate, type Seat, type SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const sectionFacet = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');
const stalled = H.state('stalled', 'terminal', 'failure');

const draft = H.kind('draft')
  .data(
    z.object({
      title: z.string(),
      section: sections,
      body: z.string(),
      notes: z.array(z.string()).optional(),
    })
  )
  .states(submitted, returned, accepted, withdrawn, stalled);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const sonnetFour = anthropic.model('claude-sonnet-4');
const haiku = anthropic.model('claude-haiku-4-5');
const api = anthropic.account('editorial-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  serves: [opus, sonnet, sonnetFour, haiku],
});
const models = H.pool('models', [{ account: api, share: 1 }]);

const editorial = H.halt(
  'editorial-decision',
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.array(z.string()),
    actedOn: z.array(z.enum(['first', 'second'])),
  })
).about(z.object({ title: z.string(), merged: z.string() }));

const reviewInput = z.object({ title: z.string(), section: sections, body: z.string() });
const critique = z.object({ points: z.array(z.string()) });
type Review = z.infer<typeof reviewInput>;
type Critique = z.infer<typeof critique>;

const editorialTaste = H.memory('editorial-taste', 'taste');
const factChecking = H.memory('fact-checking', 'experience');
const tasteJournal = H.journal('editor-taste', editorialTaste, jsonl.memory('memory/editor-taste.jsonl'));
const factCheckJournal = H.journal('fact-check-lessons', factChecking, jsonl.memory('memory/fact-check.jsonl'));

const reviewing = H.role('reviewer')
  .input(reviewInput)
  .output(critique)
  .prompt(input => `Critique this ${input.section} draft, "${input.title}".\n\n${input.body}`);

const swapAfterSamples = 50;

const creditedRate = (metrics: Metrics, seat: Seat<Review, Critique>, model: Model): Rate =>
  metrics
    .rateBy({
      days: 90,
      among: editorial.resolved(),
      count: { ...editorial.resolved(), credited: seat },
      by: { modelOf: seat },
    })
    .of(model);

const reviewerAModel = H.policy.model('reviewer-a-model', [opus, sonnet], choice => {
  const mine = creditedRate(choice.metrics, reviewerA, opus);
  const theirs = creditedRate(choice.metrics, reviewerB, sonnetFour);
  if (mine.samples < swapAfterSamples || theirs.samples < swapAfterSamples) return opus;
  return (mine.value ?? 0) < (theirs.value ?? 0) ? sonnet : opus;
});

const reviewerBModel = H.policy.model('reviewer-b-model', [sonnetFour, haiku], choice => {
  const mine = creditedRate(choice.metrics, reviewerB, sonnetFour);
  const theirs = creditedRate(choice.metrics, reviewerA, opus);
  if (mine.samples < swapAfterSamples || theirs.samples < swapAfterSamples) return sonnetFour;
  return (mine.value ?? 0) < (theirs.value ?? 0) ? haiku : sonnetFour;
});

const reviewerA: Seat<Review, Critique> = H.seat('reviewer-a', reviewing)
  .model(reviewerAModel)
  .recalls(tasteJournal, factCheckJournal)
  .creditedBy(editorial, decision => decision.actedOn.includes('first'));
const reviewerB: Seat<Review, Critique> = H.seat('reviewer-b', reviewing)
  .model(reviewerBModel)
  .recalls(tasteJournal, factCheckJournal)
  .creditedBy(editorial, decision => decision.actedOn.includes('second'));

const local = shell.local('local', { slots: 2 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.array(z.string()), second: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .argv(input => ['merge-critiques', '--first', JSON.stringify(input.first), '--second', JSON.stringify(input.second)])
  .on(local);

const factCheck = H.command('fact-check')
  .input(z.object({ draft: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.string()) }))
  .argv(input => ['fact-check', '--draft', input.draft])
  .on(local);

const review = H.flow('review-draft')
  .for(draft)
  .does(async ctx => {
    const input = { title: ctx.unit.data.title, section: ctx.unit.data.section, body: ctx.unit.data.body };
    const first = await ctx.run(reviewerA, input);
    if (first.ok === false) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, input);
    if (second.ok === false) return ctx.fail(second.error);
    const checked = await ctx.run(factCheck, { draft: ctx.unit.key });
    if (checked.ok) {
      for (const mistake of checked.value.repeatMistakes) {
        await ctx.remember(factCheckJournal, {
          text: `When a draft claims "${mistake}", verify it against a primary source before approving`,
          because: 'the fact-check found the same mistake in an earlier draft',
          when: { kinds: [draft] },
        });
      }
    }
    const merged = await ctx.run(mergeCritiques, { first: first.value.points, second: second.value.points });
    if (merged.ok === false) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorial, merged.value.merged, {
      title: ctx.unit.data.title,
      merged: merged.value.merged,
    });
    if (decision.action === 'accept') return 'accepted';
    await ctx.update({ notes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(
      z.object({
        id: z.string(),
        status: z.enum(['new', 'resubmitted', 'withdrawn']),
        title: z.string(),
        section: sections,
        body: z.string(),
      })
    ),
  }),
  read: body =>
    body.drafts.map((item): SupplyOf<typeof draft> => {
      if (item.status === 'new') {
        return { create: { title: item.title, section: item.section, body: item.body }, key: item.id };
      }
      if (item.status === 'withdrawn') return { update: item.id, state: 'withdrawn', cancels: ['active', 'waiting'] };
      return { update: item.id, patch: { body: item.body, notes: [] }, state: 'submitted' };
    }),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const drafts = H.lane('drafts', draft)
  .handler(review)
  .retries(1, { backoff: { first: { minutes: 10 } }, exhausted: 'stalled' })
  .suppliers(cmsPoll)
  .store(cmsStore)
  .facet(sectionFacet, data => data.section);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(draft, 'returned'),
  (event, act) =>
    (event.unit.data.notes ?? []).map(note =>
      act.remember(tasteJournal, {
        text: `When reviewing ${event.unit.data.section} drafts, ${note}`,
        because: `the editor returned "${event.unit.data.title}" with this note`,
        when: { facets: [sectionFacet.of(event.unit.data.section)] },
        status: 'candidate',
      })
    )
);

const editor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorial),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.db'))
  .lanes(drafts)
  .pools(models)
  .triggers(returnedNotesBecomeTaste)
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
