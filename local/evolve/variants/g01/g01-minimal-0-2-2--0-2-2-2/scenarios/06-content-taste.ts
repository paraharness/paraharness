import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Model, ModelPolicy, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('Draft')
  .data(z.object({ title: z.string(), body: z.string(), section: z.string(), editorNotes: z.string().optional() }))
  .states(submitted, returned, accepted, withdrawn);

const section = H.facet('section', z.string());

const taste = H.memory('editorial-taste', 'taste');
const factLessons = H.memory('fact-check-lessons', 'experience');
const tasteJournal = H.journal('editorial-taste', taste, jsonl.memory('.harness/taste.jsonl'));
const factJournal = H.journal('fact-check-lessons', factLessons, jsonl.memory('.harness/fact-checks.jsonl'));

const editorReview = H.halt('editor-review', z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string().optional(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
})).about(z.object({ title: z.string(), merged: z.string() }));

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');

const editorResolved: EntryFilter = { entry: 'halt', halt: editorReview, status: 'resolved', resolver: 'human' };

function uptakeChoice(name: string, own: 'actedOnA' | 'actedOnB', rival: 'actedOnA' | 'actedOnB', incumbent: Model, challenger: Model): ModelPolicy {
  return H.policy.model(name, choice => {
    const ownByModel = choice.metrics.rateBy({
      among: editorResolved,
      count: { ...editorResolved, decision: { [own]: true } },
      by: { modelOf: choice.seat },
      days: 60,
    });
    const rivalRate = choice.metrics.rate({ among: editorResolved, count: { ...editorResolved, decision: { [rival]: true } }, days: 60 });
    const incumbentRate = ownByModel[incumbent.name];
    if (!incumbentRate || incumbentRate.samples < 50 || rivalRate.samples < 50) return incumbent;
    if (incumbentRate.value === null || rivalRate.value === null) return incumbent;
    return incumbentRate.value < rivalRate.value ? challenger : incumbent;
  });
}

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this draft for the editor.\n\n# ${input.title}\n\n${input.body}`)
  .intents(['read']);

const reviewerA = H.seat('reviewer-a', reviewerRole)
  .model(uptakeChoice('reviewer-a-model', 'actedOnA', 'actedOnB', sonnet, haiku))
  .recalls(tasteJournal, factJournal);
const reviewerB = H.seat('reviewer-b', reviewerRole)
  .model(uptakeChoice('reviewer-b-model', 'actedOnB', 'actedOnA', opus, haiku))
  .recalls(tasteJournal, factJournal);

const local = shell.local('local', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.first, '--second', input.second])
  .on(local)
  .recovery('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(input => ['fact-check', '--text', input.body])
  .on(local)
  .recovery('rerun');

const review = H.flow('review')
  .for(Draft)
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    ctx.tag(section, ctx.unit.data.section);
    const first = await ctx.run(reviewerA, { title, body });
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, { title, body });
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const checked = await ctx.run(factCheck, { body });
    if (checked.ok) {
      for (const repeat of checked.value.repeats) {
        await ctx.remember(factJournal, { text: repeat.lesson, because: repeat.because, when: { kinds: [Draft] } });
      }
    }
    const decision = await ctx.halt(editorReview, merged.value, { title, merged: merged.value });
    if (decision.verdict === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes ?? '' });
    return 'returned';
  });

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=in-review',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      section: z.string(),
      revised: z.boolean(),
    })),
  }),
  read: body =>
    body.drafts.map((draft): SupplyOf<typeof Draft> =>
      draft.revised
        ? { update: draft.id, patch: { title: draft.title, body: draft.body }, state: 'submitted' }
        : { create: { title: draft.title, body: draft.body, section: draft.section }, key: draft.id }
    ),
});

const drafts = H.lane('drafts', Draft)
  .handler(review)
  .suppliers(cmsPoll)
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_status' }));

const returnedRecordsTaste = H.trigger(
  'returned-records-taste-candidate',
  H.on.enters(Draft, 'returned'),
  (event, act) => {
    const notes = event.unit.data.editorNotes;
    return notes
      ? act.remember(tasteJournal, {
          text: notes,
          status: 'candidate',
          when: { kinds: [Draft], facets: [section.value(event.unit.data.section)] },
        })
      : [];
  }
);

const editor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorReview),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(drafts)
  .pools(H.pool('anthropic', [{ account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(returnedRecordsTaste)
  .clients(editor)
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

export const running = harness.start();
