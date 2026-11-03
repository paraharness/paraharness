import { z } from 'zod';
import { H, type Model, type EntryFilter, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const draft = H.kind('draft')
  .data(
    z.object({
      cmsId: z.string(),
      title: z.string(),
      body: z.string(),
      section: sections,
      editorNotes: z.string().optional(),
    })
  )
  .states(submitted, returned, accepted, failed);

const editorialTaste = H.memory('editorial-taste', 'taste');
const factChecking = H.memory('fact-checking', 'experience');
const tasteLibrary = H.library('editorial-taste', editorialTaste, jsonl.memory('.harness/taste.jsonl'));
const factLibrary = H.library('fact-checking', factChecking, jsonl.memory('.harness/fact-checking.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const challenger = anthropic.model('claude-opus-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const editorial = H.halt(
  'editorial-decision',
  z.object({
    verdict: z.enum(['accept', 'return']),
    usedA: z.boolean(),
    usedB: z.boolean(),
    notes: z.string(),
  })
).about(z.object({ title: z.string(), merged: z.string() }));

const editorDecisions: EntryFilter = { ...editorial.resolved(), resolver: 'human' };

const reviewerModel = (name: string, own: 'usedA' | 'usedB', other: 'usedA' | 'usedB', incumbent: Model) =>
  H.policy.model(name, [incumbent, challenger], choice => {
    const actedOn = choice.metrics.rateBy({
      among: editorDecisions,
      count: { ...editorDecisions, decision: { [own]: true } },
      days: 90,
      by: { seat: choice.seat, models: [incumbent, challenger] },
    });
    const otherSeat = choice.metrics.rate({
      among: editorDecisions,
      count: { ...editorDecisions, decision: { [other]: true } },
      days: 90,
    });
    const mine = actedOn.get(incumbent);
    if (mine.samples < 50 || otherSeat.samples < 50) return incumbent;
    return (mine.value ?? 0) < (otherSeat.value ?? 0) ? challenger : incumbent;
  });

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sections }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}":\n\n${input.body}`);

const reviewerA = H.seat('reviewer-a', reviewerRole)
  .model(reviewerModel('reviewer-a-model', 'usedA', 'usedB', sonnet))
  .recalls(tasteLibrary, factLibrary);

const reviewerB = H.seat('reviewer-b', reviewerRole)
  .model(reviewerModel('reviewer-b-model', 'usedB', 'usedA', opus))
  .recalls(tasteLibrary, factLibrary);

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(input => ['./bin/fact-check', input.body])
  .on(local)
  .recovery('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(input => ['./bin/merge-critiques', input.a, input.b])
  .on(local)
  .recovery('rerun');

const reviewDraft = H.flow('review-draft')
  .for(draft)
  .does(async ctx => {
    const input = { title: ctx.unit.data.title, body: ctx.unit.data.body, section: ctx.unit.data.section };
    const first = await ctx.run(reviewerA, input);
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, input);
    if (!second.ok) return ctx.fail(second.error);
    const checked = await ctx.run(factCheck, { body: ctx.unit.data.body });
    if (checked.ok) {
      for (const mistake of checked.value.repeatMistakes) {
        await ctx.remember(factLibrary, { text: mistake.lesson, because: mistake.because, when: { kinds: [draft] } });
      }
    }
    const merged = await ctx.run(mergeCritiques, { a: first.value.critique, b: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorial, merged.value.merged, { title: ctx.unit.data.title, merged: merged.value.merged });
    if (decision.verdict === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=in-review',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        section: sections,
        status: z.enum(['submitted', 'revised']),
      })
    ),
  }),
  read: body =>
    body.drafts.map((item): SupplyOf<typeof draft> =>
      item.status === 'submitted'
        ? { create: { cmsId: item.id, title: item.title, body: item.body, section: item.section }, key: item.id }
        : { update: item.id, patch: { title: item.title, body: item.body }, state: 'submitted' }
    ),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const drafts = H.lane('drafts', draft)
  .handler(reviewDraft)
  .retries(1, { backoff: { first: { minutes: 5 } }, exhausted: 'failed' })
  .suppliers(cmsPoll)
  .store(cmsStore)
  .facet(section, data => data.section);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(draft, 'returned'),
  (event, act) => {
    const notes = event.unit.data.editorNotes;
    if (notes === undefined) return [];
    return act.remember(tasteLibrary, {
      text: notes,
      status: 'candidate',
      when: { kinds: [draft], facets: [section.of(event.unit.data.section)] },
    });
  }
);

const editor = claude.supervisor('editor', {
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorial),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(drafts)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
