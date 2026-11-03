import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Model } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');

const draft = H.kind('Draft')
  .data(z.object({ title: z.string(), section: sections, body: z.string(), notes: z.string().optional() }))
  .states(
    submitted,
    H.state('returned', 'waiting'),
    H.state('accepted', 'terminal', 'success'),
    H.state('unreviewed', 'terminal', 'failure')
  );

const editorDecision = H.halt(
  'editor-decision',
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string().optional(),
    actedOnA: z.boolean(),
    actedOnB: z.boolean(),
  })
);

const reviewer = H.role('reviewer')
  .input(z.object({ title: z.string(), section: sections, body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(i => `Critique this ${i.section} draft, "${i.title}":\n\n${i.body}`);

const opus = anthropic.model('claude-opus');
const sonnet = anthropic.model('claude-sonnet');
const challenger = anthropic.model('claude-sonnet-next');

const reviewerModel = (name: string, actedOn: EntryFilter, other: EntryFilter, incumbent: Model, replacement: Model) =>
  H.policy.model(name, [incumbent, replacement], choice => {
    const mine = choice.metrics
      .rateBy({ days: 90, among: editorDecision.resolved(), count: actedOn, by: { modelOf: choice.seat } })
      .of(incumbent);
    const theirs = choice.metrics.rate({ days: 90, among: editorDecision.resolved(), count: other });
    const weaker = mine.samples >= 50 && theirs.samples >= 50 && (mine.value ?? 0) < (theirs.value ?? 0);
    return weaker ? replacement : incumbent;
  });

const actedOnA = editorDecision.resolved({ actedOnA: true });
const actedOnB = editorDecision.resolved({ actedOnB: true });

const specificFirst = H.policy.recall('specific-first', view => view.ranked.slice(0, 10));
const taste = H.journal('editorial-taste', H.memory('taste', 'taste'), jsonl.memory('memory/taste.jsonl'), specificFirst);
const factLessons = H.journal('fact-check-lessons', H.memory('fact-check', 'experience'), jsonl.memory('memory/fact-checks.jsonl'), specificFirst);

const reviewerA = H.seat('reviewer-a', reviewer)
  .model(reviewerModel('reviewer-a-model', actedOnA, actedOnB, opus, challenger))
  .recalls(taste, factLessons);
const reviewerB = H.seat('reviewer-b', reviewer)
  .model(reviewerModel('reviewer-b-model', actedOnB, actedOnA, sonnet, challenger))
  .recalls(taste, factLessons);

const local = shell.local('local', { slots: 2 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(i => ['./bin/merge-critiques', i.first, i.second])
  .on(local)
  .recovery('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(i => ['./bin/fact-check', i.body])
  .on(local)
  .recovery('rerun');

const review = H.flow('review').for(draft).does(async ctx => {
  const { title, body } = ctx.unit.data;
  const input = { title, section: ctx.unit.data.section, body };
  const first = await ctx.run(reviewerA, input);
  if (!first.ok) return ctx.fail(first);
  const second = await ctx.run(reviewerB, input);
  if (!second.ok) return ctx.fail(second);
  const facts = await ctx.run(factCheck, { body });
  if (!facts.ok) return ctx.fail(facts);
  for (const repeat of facts.value.repeats) {
    await ctx.remember(factLessons, { text: repeat.lesson, because: repeat.because, when: { roles: [reviewer] } });
  }
  const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
  if (!merged.ok) return ctx.fail(merged);
  const decision = await ctx.halt(editorDecision, merged.value);
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ notes: decision.notes ?? '' });
  return 'returned';
});

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?ready=true',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({ id: z.string(), title: z.string(), section: sections, body: z.string(), revision: z.number() })),
  }),
  read: body =>
    body.drafts.map(d =>
      d.revision === 0
        ? { create: { title: d.title, section: d.section, body: d.body }, key: d.id }
        : { update: d.id, patch: { body: d.body }, state: submitted.name }
    ),
});

const drafts = H.lane('drafts', draft)
  .handler(review)
  .retries(2, 'unreviewed', { first: { minutes: 10 } })
  .suppliers(cmsPoll)
  .store(http.store(draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_state' }))
  .facet(section, data => data.section);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(draft, 'returned'), (event, act) => {
  const notes = event.unit.data.notes;
  if (notes === undefined || notes === '') return [];
  return act.remember(taste, {
    text: `When reviewing ${event.unit.data.section} drafts, ${notes}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { kinds: [draft], facets: [section.of(event.unit.data.section)] },
    status: 'candidate',
  });
});

const editor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorDecision),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(drafts)
  .pools(H.pool('anthropic', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]))
  .triggers(returnedNotesBecomeTaste)
  .scheduler(H.policy.scheduler('arrival', view => ({ start: view.pending })))
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
