import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metrics, Model, Rate, EntryFilter } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { supervisor } from 'harness-dsl/claude-code';

const section = z.enum(['news', 'sports', 'opinion', 'culture']);

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const editing = H.state('editing', 'active');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'failure');

const Draft = H.kind('Draft')
  .data(z.object({
    cmsId: z.string(),
    title: z.string(),
    body: z.string(),
    section,
    editorNotes: z.string().optional(),
  }))
  .states(submitted, reviewing, editing, accepted, returned);

const editorialTaste = H.memory('editorial-taste', 'taste');
const factChecking = H.memory('fact-checking', 'experience');
const taste = H.library('taste', editorialTaste, jsonl.memory('memory/taste.jsonl'));
const lessons = H.library('fact-check-lessons', factChecking, jsonl.memory('memory/fact-checking.jsonl'));

const critic = H.role('critic')
  .input(z.object({ title: z.string(), body: z.string(), section }))
  .output(z.object({ critique: z.string(), issues: z.array(z.string()) }))
  .prompt((d) => `Critique the ${d.section} draft "${d.title}" against the house taste.\n\n${d.body}`)
  .intents(['read']);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const api = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const models = H.pool('models', [{ account: api, share: 1 }]);

const editorDecision = H.halt('editor-decision', z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnFirst: z.boolean(),
  actedOnSecond: z.boolean(),
}));

type Slot = 'first' | 'second';

function actedOn(slot: Slot): EntryFilter {
  return slot === 'first'
    ? editorDecision.resolved({ actedOnFirst: true })
    : editorDecision.resolved({ actedOnSecond: true });
}

function slotRate(metrics: Metrics, slot: Slot): Rate {
  return metrics.rate({ among: editorDecision.resolved(), count: actedOn(slot), days: 30 });
}

function modelRate(metrics: Metrics, slot: Slot, model: Model): Rate {
  const agent = slot === 'first' ? reviewerFirst : reviewerSecond;
  return metrics
    .rateBy({ among: editorDecision.resolved(), count: actedOn(slot), by: { modelOf: agent }, days: 30 })
    .of(model);
}

function pick(metrics: Metrics, slot: Slot, taken?: Model): Model {
  const preference = slot === 'first' ? [opus, sonnet, haiku] : [sonnet, haiku, opus];
  const rival = slotRate(metrics, slot === 'first' ? 'second' : 'first');
  for (const model of preference) {
    if (model === taken) continue;
    const own = modelRate(metrics, slot, model);
    const weaker = own.samples >= 50 && own.value !== null && rival.value !== null && own.value < rival.value;
    if (!weaker) return model;
  }
  return slot === 'first' ? opus : haiku;
}

const firstModel = H.policy.model('first-reviewer-model', (choice) => pick(choice.metrics, 'first'));
const secondModel = H.policy.model('second-reviewer-model', (choice) =>
  pick(choice.metrics, 'second', pick(choice.metrics, 'first')));

const reviewerFirst = H.agent('reviewer-first', critic).model(firstModel).recalls(taste, lessons);
const reviewerSecond = H.agent('reviewer-second', critic).model(secondModel).recalls(taste, lessons);

const desk = shell.local('desk', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .output(z.string())
  .argv((c) => ['merge-critiques', '--first', c.first, '--second', c.second])
  .on(desk);

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ claim: z.string(), lesson: z.string() })) }))
  .argv((d) => ['fact-check', '--text', d.body])
  .on(desk);

const review = H.flow('review-draft')
  .for(Draft)
  .phases('reviewing', 'editing')
  .exits('accepted', 'returned')
  .does(async (ctx) => {
    const draft = ctx.unit.data;
    const scope = { resources: [`section:${draft.section}`] };
    const input = { title: draft.title, body: draft.body, section: draft.section };
    await ctx.move('reviewing');
    const first = await ctx.run(reviewerFirst, input, { scope });
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerSecond, input, { scope });
    if (!second.ok) return ctx.fail(second.error);
    const checked = await ctx.run(factCheck, { body: draft.body });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(lessons, {
        text: mistake.lesson,
        because: `the same mistake recurred: ${mistake.claim}`,
        when: { roles: [critic] },
        status: 'accepted',
      });
    }
    const merged = await ctx.run(mergeCritiques, {
      first: JSON.stringify(first.value),
      second: JSON.stringify(second.value),
    });
    if (!merged.ok) return ctx.fail(merged.error);
    await ctx.move('editing');
    const decision = await ctx.halt(editorDecision, merged.value);
    if (decision.verdict === 'return') {
      await ctx.update({ editorNotes: decision.notes });
      return 'returned';
    }
    return 'accepted';
  });

const cmsAuth = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=submitted',
  every: { minutes: 10 },
  headers: cmsAuth,
  body: z.object({
    drafts: z.array(z.object({ id: z.string(), title: z.string(), body: z.string(), section })),
  }),
  read: (b) => b.drafts.map((d) => ({
    create: { cmsId: d.id, title: d.title, body: d.body, section: d.section },
    key: d.id,
  })),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsAuth,
  stateField: 'reviewStatus',
});

const drafts = H.lane('drafts', Draft)
  .handler(review, { reviewing, editing, accepted, returned })
  .suppliers(cmsPoll)
  .store(cmsStore)
  .wip(3);

const captureTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  if (notes === undefined) return [];
  return act.remember(taste, {
    text: `When reviewing ${event.unit.data.section} drafts, apply the editor's note: ${notes}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { roles: [critic], resources: [`section:${event.unit.data.section}`] },
    status: 'candidate',
  });
});

const oldestFirst = H.policy.scheduler('oldest-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.db'))
  .lanes(drafts)
  .pools(models)
  .triggers(captureTaste)
  .scheduler(oldestFirst)
  .clients(supervisor({
    grants: [
      H.ops.readWork,
      H.ops.resolveHalts,
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.curateMemory,
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
