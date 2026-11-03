import { H } from 'harness-dsl';
import type { EntryFilter, Model } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const received = H.state('received', 'pending');
const reviewing = H.state('reviewing', 'active');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'waiting');

const Draft = H.kind('draft')
  .data(z.object({
    id: z.string(),
    title: z.string(),
    section: z.string(),
    body: z.string(),
    notes: z.string().optional(),
    notesSection: z.string().optional(),
  }))
  .states(received, reviewing, accepted, returned);

const section = H.tag('section');

const tasteMemory = H.memory('editorial-taste', 'taste');
const factMemory = H.memory('fact-checking', 'experience');
const tasteArchive = H.archive('editorial-taste', tasteMemory, jsonl.memory('./.harness/taste.jsonl'));
const factArchive = H.archive('fact-checking', factMemory, jsonl.memory('./.harness/fact-checking.jsonl'));
const reviewerBriefing = H.briefing('reviewer-briefing', [tasteArchive, factArchive]);

const editorDecision = H.halt('editor-decision', z.object({
  verdict: z.enum(['accept', 'return']),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
  notes: z.string(),
  notesSection: z.string().optional(),
}));

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(d => `Critique this ${d.section} draft titled "${d.title}" for the editor:\n\n${d.body}`)
  .intents(['read']);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');

const resolved = editorDecision.resolved();

function reviewerModel(name: string, incumbent: Model, mine: EntryFilter, theirs: EntryFilter) {
  return H.policy.model(name, choice => {
    const own = choice.metrics.rate({ among: resolved, count: mine, days: 60 });
    const other = choice.metrics.rate({ among: resolved, count: theirs, days: 60 });
    const weaker = own.samples >= 50 && own.value !== null && other.value !== null && own.value < other.value;
    return weaker ? challenger : incumbent;
  });
}

const actedOnA = editorDecision.resolved({ actedOnA: true });
const actedOnB = editorDecision.resolved({ actedOnB: true });

const reviewerA = H.agent('reviewer-a', reviewerRole)
  .model(reviewerModel('reviewer-a-model', opus, actedOnA, actedOnB))
  .recalls(reviewerBriefing);
const reviewerB = H.agent('reviewer-b', reviewerRole)
  .model(reviewerModel('reviewer-b-model', sonnet, actedOnB, actedOnA))
  .recalls(reviewerBriefing);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ id: z.string(), body: z.string() }))
  .output(z.object({ repeats: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(d => ['fact-check', '--draft', d.id, '--json'])
  .on(local);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(c => ['merge-critiques', JSON.stringify(c)])
  .on(local);

const reviewFlow = H.flow('review-draft').for(Draft).does(async ctx => {
  await ctx.move('reviewing');
  const draft = ctx.unit.data;
  const scope = { tags: [section.is(draft.section)] };

  const checked = await ctx.run(factCheck, { id: draft.id, body: draft.body });
  if (!checked.ok) return ctx.fail(checked.error);
  for (const repeat of checked.value.repeats) {
    await ctx.remember(factArchive, {
      text: repeat.lesson,
      because: repeat.because,
      when: { kinds: [Draft], roles: [reviewerRole] },
      status: 'accepted',
    });
  }

  const input = { title: draft.title, section: draft.section, body: draft.body };
  const a = await ctx.run(reviewerA, input, { scope });
  if (!a.ok) return ctx.fail(a.error);
  const b = await ctx.run(reviewerB, input, { scope });
  if (!b.ok) return ctx.fail(b.error);

  const merged = await ctx.run(mergeCritiques, { a: a.value.critique, b: b.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);

  const decision = await ctx.halt(editorDecision, merged.value.merged);
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ notes: decision.notes, notesSection: decision.notesSection });
  return 'returned';
});

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=submitted',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({ id: z.string(), title: z.string(), section: z.string(), body: z.string() })),
  }),
  read: b => b.drafts.map(d => ({
    create: { id: d.id, title: d.title, section: d.section, body: d.body },
    key: d.id,
    state: 'received' as const,
  })),
});

const drafts = H.lane('drafts', Draft)
  .handler(reviewFlow)
  .suppliers(cmsPoll)
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_status' }));

const notesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) =>
  act.remember(tasteArchive, {
    text: event.unit.data.notes ?? 'returned without notes',
    because: `the editor returned "${event.unit.data.title}"`,
    when: event.unit.data.notesSection
      ? { kinds: [Draft], roles: [reviewerRole], tags: [section.is(event.unit.data.notesSection)] }
      : { kinds: [Draft], roles: [reviewerRole] },
    status: 'candidate',
  })
);

const pool = H.pool('anthropic', [{ account: anthropic.account('publication', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

const editor = cc.supervisor({
  grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .lanes(drafts)
  .pools(pool)
  .triggers(notesBecomeTaste)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs) })))
  .clients(editor)
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
