import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const published = H.state('published', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('draft')
  .data(
    z.object({
      id: z.string(),
      title: z.string(),
      section: z.string(),
      body: z.string(),
      editorNotes: z.string().optional(),
    }),
  )
  .states(submitted, returned, published, withdrawn)
  .failsTo('returned');

const section = H.tag('section');
const firstCriticModel = H.tag('first-critic-model');
const secondCriticModel = H.tag('second-critic-model');

const taste = H.memory('taste', 'taste');
const factChecking = H.memory('fact-checking', 'experience');
const tasteArchive = H.archive('editor-taste', taste, jsonl.memory('memory/taste.jsonl'));
const factArchive = H.archive('fact-check-lessons', factChecking, jsonl.memory('memory/fact-checking.jsonl'));
const criticBriefing = H.briefing('critic-briefing', [tasteArchive, factArchive]);

const critic = H.role('critic')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ critique: z.string(), issues: z.array(z.string()) }))
  .prompt((draft) => `Critique this ${draft.section} draft titled "${draft.title}" against the house taste.\n\n${draft.body}`)
  .intents(['read']);

const editorReview = H.halt(
  'editor-review',
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    usedFirst: z.boolean(),
    usedSecond: z.boolean(),
  }),
);

const firstIncumbent = anthropic.model('claude-opus-4-1');
const secondIncumbent = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');

function actedOn(metrics: Metrics, model: Model): Rate {
  const asFirst = metrics
    .rateBy({ among: editorReview.resolved(), count: editorReview.resolved({ usedFirst: true }), by: firstCriticModel })
    .of(model);
  const asSecond = metrics
    .rateBy({ among: editorReview.resolved(), count: editorReview.resolved({ usedSecond: true }), by: secondCriticModel })
    .of(model);
  const hits = asFirst.hits + asSecond.hits;
  const samples = asFirst.samples + asSecond.samples;
  return { value: samples === 0 ? null : hits / samples, hits, samples };
}

function weakerIncumbent(metrics: Metrics): Model | undefined {
  const first = actedOn(metrics, firstIncumbent);
  const second = actedOn(metrics, secondIncumbent);
  if (first.samples < 50 || second.samples < 50 || first.value === null || second.value === null) return undefined;
  if (first.value === second.value) return undefined;
  return first.value < second.value ? firstIncumbent : secondIncumbent;
}

const firstCriticChoice = H.policy.model('first-critic-choice', ({ metrics }) =>
  weakerIncumbent(metrics) === firstIncumbent ? challenger : firstIncumbent,
);
const secondCriticChoice = H.policy.model('second-critic-choice', ({ metrics }) =>
  weakerIncumbent(metrics) === secondIncumbent ? challenger : secondIncumbent,
);

const firstCritic = H.agent('first-critic', critic).model(firstCriticChoice).recalls(criticBriefing);
const secondCritic = H.agent('second-critic', critic).model(secondCriticChoice).recalls(criticBriefing);

const local = shell.local('local', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv((critiques) => ['merge-critiques', '--first', critiques.first, '--second', critiques.second])
  .on(local)
  .recovers('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ draft: z.string() }))
  .output(
    z.object({
      findings: z.array(z.string()),
      repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })),
    }),
  )
  .argv((target) => ['fact-check', '--draft', target.draft])
  .on(local)
  .recovers('rerun');

const reviewFlow = H.flow('review-draft')
  .for(Draft)
  .does(async (ctx) => {
    const draft = ctx.unit.data;
    ctx.tag(section, draft.section);
    const brief = { title: draft.title, section: draft.section, body: draft.body };
    const first = await ctx.run(firstCritic, brief);
    if (!first.ok) return ctx.fail(first.error);
    ctx.tag(firstCriticModel, first.model);
    const second = await ctx.run(secondCritic, brief);
    if (!second.ok) return ctx.fail(second.error);
    ctx.tag(secondCriticModel, second.model);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const checked = await ctx.run(factCheck, { draft: draft.id });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(factArchive, { text: mistake.lesson, because: mistake.because, when: { roles: [critic] } });
    }
    const decision = await ctx.halt(editorReview, [merged.value.merged, ...checked.value.findings].join('\n\n'));
    if (decision.verdict === 'return') {
      await ctx.update({ editorNotes: decision.notes });
      return ctx.fail('returned by the editor', 'returned');
    }
    return 'published';
  });

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
  status: z.enum(['submitted', 'revised', 'withdrawn']),
});

const fromCms = (draft: z.infer<typeof cmsDraft>): SupplyOf<typeof Draft> =>
  draft.status === 'submitted'
    ? { create: { id: draft.id, title: draft.title, section: draft.section, body: draft.body }, key: draft.id }
    : draft.status === 'revised'
      ? { update: draft.id, patch: { body: draft.body, editorNotes: undefined }, state: 'submitted' }
      : { update: draft.id, state: 'withdrawn' };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?review=pending',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(cmsDraft) }),
  read: (body) => body.drafts.map(fromCms),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const drafts = H.lane('drafts', Draft).handler(reviewFlow).suppliers(cmsPoll).store(cmsStore).wip(3);

const editorNotesBecomeTaste = H.trigger(
  'editor-notes-become-taste-candidates',
  H.on.enters(Draft, 'returned'),
  (event, act) =>
    act.remember(tasteArchive, {
      text: `When reviewing ${event.unit.data.section} drafts: ${event.unit.data.editorNotes ?? ''}`,
      because: `the editor returned "${event.unit.data.title}" with these notes`,
      when: { kinds: [Draft], tags: [section.is(event.unit.data.section)] },
      status: 'candidate',
    }),
);

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const accounts = H.pool('content-accounts', [{ account: api, share: 1 }]);

const editor = cc.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.db'))
  .lanes(drafts)
  .pools(accounts)
  .triggers(editorNotesBecomeTaste)
  .clients(editor)
  .observers(markdown.board('BOARD.md'));
