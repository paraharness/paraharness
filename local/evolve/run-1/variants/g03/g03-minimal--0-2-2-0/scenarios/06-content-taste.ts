import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, ModelChoice } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const section = z.enum(['news', 'sports', 'opinion', 'culture']);

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('draft')
  .data(z.object({ title: z.string(), body: z.string(), section, editorNotes: z.string().optional() }))
  .states(submitted, reviewing, returned, accepted, withdrawn);

const editorialTaste = H.memory('editorial-taste', 'taste');
const factCheckLessons = H.memory('fact-check-lessons', 'experience');
const houseTaste = H.library('house-taste', editorialTaste, jsonl.memory('memory/taste.jsonl'));
const factLessons = H.library('fact-lessons', factCheckLessons, jsonl.memory('memory/fact-lessons.jsonl'));

const reviewer = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section, findings: z.array(z.string()) }))
  .output(z.object({ critique: z.string(), points: z.array(z.string()) }))
  .prompt(input => `Critique the ${input.section} draft "${input.title}".\n\nFact-check findings:\n${input.findings.join('\n')}\n\n${input.body}`)
  .intents(['read']);

const incumbentA = anthropic.model('claude-opus-4-1');
const incumbentB = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');

const editorDecision = H.halt('editor-decision', z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
}));

const decisions = editorDecision.resolved();
const actedOnA = editorDecision.resolved({ actedOnA: true });
const actedOnB = editorDecision.resolved({ actedOnB: true });

function weakerReviewer(metrics: Metrics): 'a' | 'b' | null {
  const a = metrics.rateBy({ among: decisions, count: actedOnA, by: { model: reviewerA }, days: 60 }).get(incumbentA);
  const b = metrics.rateBy({ among: decisions, count: actedOnB, by: { model: reviewerB }, days: 60 }).get(incumbentB);
  if (a.samples < 50 || b.samples < 50 || a.value === null || b.value === null || a.value === b.value) return null;
  return a.value < b.value ? 'a' : 'b';
}

function pickReviewerA({ metrics }: ModelChoice): Model {
  return weakerReviewer(metrics) === 'a' ? challenger : incumbentA;
}

function pickReviewerB({ metrics }: ModelChoice): Model {
  return weakerReviewer(metrics) === 'b' ? challenger : incumbentB;
}

const reviewerA = H.agent('reviewer-a', reviewer)
  .model(H.policy.model('reviewer-a-model', pickReviewerA))
  .recalls(houseTaste, factLessons);

const reviewerB = H.agent('reviewer-b', reviewer)
  .model(H.policy.model('reviewer-b-model', pickReviewerB))
  .recalls(houseTaste, factLessons);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ draft: z.string(), body: z.string() }))
  .output(z.object({
    findings: z.array(z.string()),
    repeatMistakes: z.array(z.object({ rule: z.string(), because: z.string() })),
  }))
  .argv(input => ['fact-check', '--draft', input.draft, '--text', input.body])
  .on(local);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .output(z.object({ summary: z.string() }))
  .argv(input => ['merge-critiques', '--a', input.a, '--b', input.b])
  .on(local);

const reviewFlow = H.flow('draft-review').for(Draft).does(async ctx => {
  await ctx.move('reviewing');
  const { title, body } = ctx.unit.data;
  const draftSection = ctx.unit.data.section;
  const scope = { resources: [`section:${draftSection}`] };

  const facts = await ctx.run(factCheck, { draft: ctx.unit.key, body });
  if (!facts.ok) return ctx.fail(facts.error);
  for (const lesson of facts.value.repeatMistakes) {
    await ctx.remember(factLessons, { text: lesson.rule, because: lesson.because, when: { kinds: [Draft] } });
  }

  const input = { title, body, section: draftSection, findings: facts.value.findings };
  const a = await ctx.run(reviewerA, input, { scope });
  if (!a.ok) return ctx.fail(a.error);
  const b = await ctx.run(reviewerB, input, { scope });
  if (!b.ok) return ctx.fail(b.error);

  const merged = await ctx.run(mergeCritiques, { a: a.value.critique, b: b.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);

  const decision = await ctx.halt(editorDecision, merged.value.summary);
  if (decision.action === 'accept') return 'accepted';
  await ctx.update({ editorNotes: decision.notes });
  return 'returned';
});

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cms = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?review=pending',
  every: { minutes: 5 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      section,
      status: z.enum(['new', 'revised', 'withdrawn']),
    })),
  }),
  read: body => body.drafts.map(draft =>
    draft.status === 'new'
      ? Draft.create({ title: draft.title, body: draft.body, section: draft.section }, draft.id)
      : draft.status === 'revised'
        ? Draft.update(draft.id, { patch: { body: draft.body }, state: 'submitted' })
        : Draft.update(draft.id, { state: 'withdrawn' })),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_status',
});

const drafts = H.lane('drafts', Draft).handler(reviewFlow).suppliers(cms).store(cmsStore).wip(3);

const notesBecomeTaste = H.trigger('notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  return notes
    ? act.remember(houseTaste, {
        text: notes,
        because: `the editor returned "${event.unit.data.title}" with this note`,
        when: { kinds: [Draft], resources: [`section:${event.unit.data.section}`] },
        status: 'candidate',
      })
    : [];
});

const pool = H.pool('api', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.sqlite'))
  .lanes(drafts)
  .pools(pool)
  .triggers(notesBecomeTaste)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
