import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, Rate, PendingView, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const withEditor = H.state('with-editor', 'active');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('Draft')
  .data(z.object({
    title: z.string(),
    body: z.string(),
    section: z.string(),
    revision: z.number(),
    editorNotes: z.string().optional(),
  }))
  .states(submitted, reviewing, withEditor, returned, accepted, withdrawn);

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const factLessons = H.library('fact-check-lessons', experience, jsonl.memory('.harness/fact-lessons.jsonl'));
const editorTaste = H.library('editor-taste', taste, jsonl.memory('.harness/editor-taste.jsonl'));

const editorDecision = H.halt('editor-decision', z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  usedA: z.boolean(),
  usedB: z.boolean(),
}));

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challengers: readonly Model[] = [anthropic.model('claude-haiku-4-5'), anthropic.model('claude-opus-4')];

interface Tally {
  readonly hits: number;
  readonly samples: number;
}

function tally(rates: Readonly<Record<string, Rate>>, model: Model): Tally {
  const rate: Rate | undefined = rates[model.name];
  return rate === undefined ? { hits: 0, samples: 0 } : { hits: rate.hits, samples: rate.samples };
}

function actedOn(metrics: Metrics, model: Model): Tally {
  const asA = tally(metrics.rateBy({
    among: editorDecision.resolved(),
    count: editorDecision.resolved({ usedA: true }),
    byTag: 'modelA',
  }), model);
  const asB = tally(metrics.rateBy({
    among: editorDecision.resolved(),
    count: editorDecision.resolved({ usedB: true }),
    byTag: 'modelB',
  }), model);
  return { hits: asA.hits + asB.hits, samples: asA.samples + asB.samples };
}

function lineup(metrics: Metrics): readonly [Model, Model] {
  let pair: readonly [Model, Model] = [opus, sonnet];
  for (const challenger of challengers) {
    const first = actedOn(metrics, pair[0]);
    const second = actedOn(metrics, pair[1]);
    if (first.samples < 50 || second.samples < 50) return pair;
    pair = first.hits / first.samples < second.hits / second.samples
      ? [challenger, pair[1]]
      : [pair[0], challenger];
  }
  return pair;
}

const criticAModel = H.policy.model('critic-a-model', ({ metrics }) => lineup(metrics)[0]);
const criticBModel = H.policy.model('critic-b-model', ({ metrics }) => lineup(metrics)[1]);

const critic = H.role('critic')
  .input(z.object({ title: z.string(), body: z.string(), section: z.string(), factCheck: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt((draft) => `Critique this ${draft.section} draft "${draft.title}".\nFact-check notes:\n${draft.factCheck}\n\n${draft.body}`)
  .intents(['read']);

const criticA = H.agent('critic-a', critic).model(criticAModel).recalls(editorTaste, factLessons);
const criticB = H.agent('critic-b', critic).model(criticBModel).recalls(editorTaste, factLessons);

const tools = shell.local('review-tools', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({
    notes: z.string(),
    repeats: z.array(z.object({ claim: z.string(), lesson: z.string() })),
  }))
  .argv((draft) => ['fact-check', '--stdin-text', draft.body])
  .on(tools);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv((critiques) => ['merge-critiques', '--a', critiques.a, '--b', critiques.b])
  .on(tools);

const reviewDraft = H.flow('review-draft').for(Draft).does(async (ctx) => {
  const draft = ctx.unit.data;
  await ctx.move('reviewing');
  const checked = await ctx.run(factCheck, { body: draft.body });
  if (checked.ok === false) return ctx.fail(checked.error);
  for (const repeat of checked.value.repeats) {
    await ctx.remember(factLessons, {
      text: `When a draft claims "${repeat.claim}", ${repeat.lesson}`,
      because: 'the fact-check found this mistake in an earlier draft',
      when: { roles: [critic.name] },
      status: 'candidate',
    });
  }
  const input = { title: draft.title, body: draft.body, section: draft.section, factCheck: checked.value.notes };
  const scope = { resources: [draft.section] };
  const first = await ctx.run(criticA, input, { scope });
  if (first.ok === false) return ctx.fail(first.error);
  const second = await ctx.run(criticB, input, { scope });
  if (second.ok === false) return ctx.fail(second.error);
  ctx.tag({ modelA: first.model ?? 'unknown', modelB: second.model ?? 'unknown' });
  const merged = await ctx.run(mergeCritiques, { a: first.value.critique, b: second.value.critique });
  if (merged.ok === false) return ctx.fail(merged.error);
  await ctx.move('with-editor');
  const decision = await ctx.halt(editorDecision, merged.value.merged);
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ editorNotes: decision.notes });
  return 'returned';
});

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=new,resubmitted,withdrawn',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      section: z.string(),
      revision: z.number(),
      status: z.enum(['new', 'resubmitted', 'withdrawn']),
    })),
  }),
  read: (body) => body.drafts.flatMap((draft): SupplyOf<typeof Draft>[] => {
    if (draft.status === 'new') {
      return [{
        create: { title: draft.title, body: draft.body, section: draft.section, revision: draft.revision },
        key: draft.id,
      }];
    }
    if (draft.status === 'resubmitted') {
      return [{
        update: draft.id,
        patch: { title: draft.title, body: draft.body, revision: draft.revision },
        state: 'submitted',
      }];
    }
    return [{ update: draft.id, state: 'withdrawn' }];
  }),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const drafts = H.lane('drafts', Draft).handler(reviewDraft).suppliers(cmsPoll).store(cmsStore);

const notesBecomeTaste = H.trigger('editor-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const { editorNotes, section, title } = event.unit.data;
  if (editorNotes === undefined || editorNotes === '') return [];
  return act.remember(editorTaste, {
    text: `When reviewing a ${section} draft, check for what the editor asked for: ${editorNotes}`,
    because: `the editor returned "${title}" with this note`,
    when: { kinds: [Draft.name], resources: [section] },
    status: 'candidate',
  });
});

const api = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const accounts = H.pool('publication-accounts', [{ account: api, share: 1 }]);

const oldestFirst = H.policy.scheduler('oldest-first', ({ pending }) => ({
  start: [...pending].sort((a: PendingView, b: PendingView) => b.waitedMs - a.waitedMs),
}));

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(drafts)
  .pools(accounts)
  .triggers(notesBecomeTaste)
  .scheduler(oldestFirst)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.curateMemory, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
