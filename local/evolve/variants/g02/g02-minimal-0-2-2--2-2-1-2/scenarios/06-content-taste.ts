import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const draft = H.kind('draft')
  .data(z.object({ title: z.string(), section: sections, body: z.string(), editorNotes: z.string().optional() }))
  .states(submitted, accepted, returned, failed);

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready-for-review',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(z.object({ id: z.string(), title: z.string(), section: sections, body: z.string() })) }),
  read: body =>
    body.drafts.map(item => ({
      create: { title: item.title, section: item.section, body: item.body },
      key: item.id,
    })),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const local = shell.local('local', { slots: 2 });

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-opus-4-5');
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const anthropicPool = H.pool('anthropic', [{ account: api, share: 1 }]);

const houseTaste = H.library('house-taste', H.memory('editor-taste', 'taste'), jsonl.memory('.harness/taste.jsonl'));
const factLessons = H.library(
  'fact-check-lessons',
  H.memory('fact-check-experience', 'experience'),
  jsonl.memory('.harness/fact-check.jsonl')
);

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: sections, body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}", for the editor.\n\n${input.body}`);

const editorDecision = z.object({
  verdict: z.enum(['accept', 'return']),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
  notes: z.string(),
});
type EditorDecision = z.infer<typeof editorDecision>;

const editorial = H.halt('editorial-decision', editorDecision).about(z.object({ title: z.string(), merged: z.string() }));

const reviewerModel = (
  name: string,
  incumbent: Model,
  replacement: Model,
  mine: Partial<EditorDecision>,
  theirs: Partial<EditorDecision>
) =>
  H.policy.model(name, [incumbent, replacement], choice => {
    const actedOn = (match: Partial<EditorDecision>) => ({
      among: editorial.resolved(),
      count: editorial.resolved(match),
      days: 60,
    });
    const own = choice.metrics.rateBy({ ...actedOn(mine), by: { modelOf: choice.seat } }).of(incumbent);
    const other = choice.metrics.rate(actedOn(theirs));
    return own.samples >= 50 && other.samples >= 50 && (own.value ?? 0) < (other.value ?? 0) ? replacement : incumbent;
  });

const reviewerA = H.seat('reviewer-a', reviewerRole)
  .model(reviewerModel('reviewer-a-model', opus, challenger, { actedOnA: true }, { actedOnB: true }))
  .recalls(houseTaste, factLessons);
const reviewerB = H.seat('reviewer-b', reviewerRole)
  .model(reviewerModel('reviewer-b-model', sonnet, challenger, { actedOnB: true }, { actedOnA: true }))
  .recalls(houseTaste, factLessons);

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(input => ['fact-check', '--text', input.body])
  .on(local);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['critique-merge', '--first', input.first, '--second', input.second])
  .on(local);

const review = H.flow('review').for(draft).does(async ctx => {
  const { title, section: placement, body } = ctx.unit.data;
  const facts = await ctx.run(factCheck, { body });
  if (!facts.ok) return ctx.fail(facts.error);
  for (const mistake of facts.value.repeatMistakes) {
    await ctx.remember(factLessons, { text: mistake.lesson, because: mistake.because, when: { roles: [reviewerRole] } });
  }
  const first = await ctx.run(reviewerA, { title, section: placement, body });
  if (!first.ok) return ctx.fail(first.error);
  const second = await ctx.run(reviewerB, { title, section: placement, body });
  if (!second.ok) return ctx.fail(second.error);
  const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);
  const decision = await ctx.halt(editorial, merged.value, { title, merged: merged.value });
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ editorNotes: decision.notes });
  return 'returned';
});

const drafts = H.lane('drafts', draft)
  .handler(review, { retries: 1, exhausted: 'failed' })
  .suppliers(cmsPoll)
  .store(cmsStore)
  .facet(section, data => data.section);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste',
  H.on.enters(draft, 'returned'),
  (event, act) =>
    event.unit.data.editorNotes === undefined
      ? []
      : act.remember(houseTaste, {
          text: event.unit.data.editorNotes,
          status: 'candidate',
          when: { kinds: [draft], facets: [section.of(event.unit.data.section)] },
        })
);

const editor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorial, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(drafts)
  .pools(anthropicPool)
  .triggers(returnedNotesBecomeTaste)
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
