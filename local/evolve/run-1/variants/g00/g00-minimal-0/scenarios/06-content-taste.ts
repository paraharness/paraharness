import { z } from 'zod';
import { H, Metrics, Model, Supply, DataOf, StateOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Draft = H.kind('Draft').data(z.object({
  draftId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
  editorNotes: z.string().optional(),
})).states({
  submitted: 'pending',
  reviewing: 'active',
  'with-editor': 'active',
  accepted: 'succeeded',
  returned: 'idle',
  failed: 'failed',
  withdrawn: 'cancelled',
}, 'submitted');

type DraftSupply = Supply<DataOf<typeof Draft>, StateOf<typeof Draft>>;

const Taste = H.memory('editorial-taste', 'owner');
const Experience = H.memory('fact-checking', 'fallible');
const taste = H.library('editorial-taste', Taste, jsonl.memory('memory/taste.jsonl'));
const experience = H.library('fact-checking', Experience, jsonl.memory('memory/fact-checking.jsonl'));

const opus = anthropic.model('claude-opus');
const sonnet = anthropic.model('claude-sonnet');
const haiku = anthropic.model('claude-haiku');

const actedOnRate = (metrics: Metrics, seat: 'A' | 'B', model: Model) => {
  const among = { entry: 'halt' as const, halt: 'editor', status: 'resolved', tags: { [`model${seat}`]: model.name } };
  return metrics.rate({ among, count: { ...among, decision: { [`actedOn${seat}`]: true } } });
};

const reviewerModel = (seat: 'A' | 'B', incumbent: Model, rival: Model, challenger: Model) =>
  H.policy.model(`reviewer-${seat}-model`, choice => {
    const mine = actedOnRate(choice.metrics, seat, incumbent);
    const theirs = actedOnRate(choice.metrics, seat === 'A' ? 'B' : 'A', rival);
    const decided = mine.samples >= 50 && theirs.samples >= 50;
    return decided && (mine.value ?? 0) < (theirs.value ?? 0) ? challenger : incumbent;
  });

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}":\n\n${input.body}`);

const reviewerA = H.agent('reviewer-a', reviewerRole).model(reviewerModel('A', opus, sonnet, haiku)).recalls(taste, experience);
const reviewerB = H.agent('reviewer-b', reviewerRole).model(reviewerModel('B', sonnet, opus, haiku)).recalls(taste, experience);

const local = shell.local('local', { slots: 4 });
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(input => ['merge-critiques', '--a', input.a, '--b', input.b])
  .on(local);
const factCheck = H.command('fact-check')
  .input(z.object({ draftId: z.string(), body: z.string() }))
  .output(z.object({ repeatMistake: z.boolean(), lesson: z.string() }))
  .argv(input => ['fact-check', '--json', input.draftId])
  .on(local);

const reviewFlow = H.flow('editorial-review').for(Draft).does(async ctx => {
  const { draftId, title, section, body } = ctx.unit.data;
  await ctx.move('reviewing');
  const scope = { resources: [`section:${section}`] };
  const a = await ctx.run(reviewerA, { title, section, body }, { scope });
  const b = await ctx.run(reviewerB, { title, section, body }, { scope });
  if (!a.ok || !b.ok) return 'failed';
  ctx.tag({ modelA: a.model ?? 'unknown', modelB: b.model ?? 'unknown', section });
  const merged = await ctx.run(mergeCritiques, { a: a.value.critique, b: b.value.critique });
  if (!merged.ok) return 'failed';
  const facts = await ctx.run(factCheck, { draftId, body });
  if (facts.ok && facts.value.repeatMistake) {
    await ctx.remember(experience, { text: facts.value.lesson, when: { kinds: [Draft.name], roles: [reviewerRole.name] } });
  }
  await ctx.move('with-editor');
  const editor = await ctx.halt({
    name: 'editor',
    show: merged.value,
    decision: z.object({
      accept: z.boolean(),
      notes: z.string(),
      actedOnA: z.boolean(),
      actedOnB: z.boolean(),
    }),
  });
  if (editor.accept) return 'accepted';
  await ctx.update({ editorNotes: editor.notes });
  return 'returned';
});

const cmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
  status: z.enum(['submitted', 'resubmitted', 'withdrawn']),
});

const fromCms = (d: z.infer<typeof cmsDraft>): DraftSupply =>
  d.status === 'submitted'
    ? { create: { draftId: d.id, title: d.title, section: d.section, body: d.body }, key: d.id }
    : d.status === 'resubmitted'
      ? { update: d.id, patch: { body: d.body, title: d.title }, state: 'submitted' }
      : { update: d.id, state: 'withdrawn' };

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const draftLane = H.lane('drafts', Draft)
  .handler(reviewFlow)
  .suppliers(http.poll(Draft, {
    url: 'https://cms.example.com/api/drafts?changed=recent',
    every: { minutes: 5 },
    headers: cmsHeaders,
    body: z.object({ drafts: z.array(cmsDraft) }),
    read: body => body.drafts.map(fromCms),
  }))
  .store(http.store(Draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_state' }));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) =>
  event.unit.data.editorNotes
    ? act.remember(taste, {
        text: event.unit.data.editorNotes,
        status: 'candidate',
        when: { kinds: [Draft.name], resources: [`section:${event.unit.data.section}`] },
      })
    : []);

const pool = H.pool('anthropic', [
  { account: anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null));

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(draftLane)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
