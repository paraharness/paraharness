import { z } from 'zod';
import { H, type Metrics, type Model, type SupplyOf } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion']);
const sectionFacet = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const draft = H.kind('draft')
  .data(z.object({ title: z.string(), section: sections, body: z.string(), editorNotes: z.string().optional() }))
  .states(submitted, returned, accepted, withdrawn);

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: sections, body: z.string(), factIssues: z.array(z.string()) }))
  .output(z.object({ critique: z.string() }))
  .prompt(i => `Critique this ${i.section} draft "${i.title}".\nKnown fact issues:\n${i.factIssues.join('\n')}\n\n${i.body}`);

const taste = H.journal('editor-taste', H.memory('editor-taste', 'taste'), jsonl.memory('memory/taste.jsonl'));
const factLessons = H.journal('fact-check-lessons', H.memory('fact-check-lessons', 'experience'), jsonl.memory('memory/facts.jsonl'));

const api = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('publication', [{ account: api, share: 1 }]);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const challengers: readonly Model[] = [haiku];
const swapAfterSamples = 50;

const reviewerPair = (metrics: Metrics): readonly [Model, Model] => {
  const uptake = metrics.rateBy({
    among: { entry: 'grade', kind: draft },
    count: { entry: 'grade', kind: draft, grade: 'accepted' },
    by: 'model',
    days: 180,
  });
  const samples = (m: Model) => (uptake[m.name] ? uptake[m.name].samples : 0);
  const value = (m: Model) => (uptake[m.name] ? uptake[m.name].value ?? 0 : 0);
  let first = opus;
  let second = sonnet;
  for (const challenger of challengers) {
    if (samples(first) < swapAfterSamples || samples(second) < swapAfterSamples) break;
    if (value(first) >= value(second)) second = challenger;
    else first = challenger;
  }
  return [first, second];
};

const firstReviewerModel = H.policy.model('first-reviewer-model', choice => reviewerPair(choice.metrics)[0]);
const secondReviewerModel = H.policy.model('second-reviewer-model', choice => reviewerPair(choice.metrics)[1]);

const firstReviewer = H.seat('first-reviewer', reviewerRole).model(firstReviewerModel).recalls(taste, factLessons);
const secondReviewer = H.seat('second-reviewer', reviewerRole).model(secondReviewerModel).recalls(taste, factLessons);

const local = shell.local('local', { slots: 2 });
const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ issues: z.array(z.string()), repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(i => ['fact-check', '--text', i.body])
  .on(local)
  .recovery('rerun');
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .output(z.object({ merged: z.string() }))
  .argv(i => ['merge-critiques', '--first', i.first, '--second', i.second])
  .on(local)
  .recovery('rerun');

const editorReview = H.halt(
  'editor-review',
  z.object({ accept: z.boolean(), notes: z.string(), actedOn: z.array(z.enum(['first', 'second'])) })
);

const review = H.flow('review-draft')
  .for(draft)
  .does(async ctx => {
    const { title, section, body } = ctx.unit.data;
    ctx.tag(sectionFacet, section);
    const checked = await ctx.run(factCheck, { body });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(factLessons, {
        text: mistake.lesson,
        because: mistake.because,
        when: { roles: [reviewerRole] },
        status: 'accepted',
      });
    }
    const input = { title, section, body, factIssues: checked.value.issues };
    const scope = { scope: { facets: [sectionFacet.value(section)] } };
    const first = await ctx.run(firstReviewer, input, scope);
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(secondReviewer, input, scope);
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorReview, merged.value.merged);
    await ctx.grade(first, decision.actedOn.some(a => a === 'first') ? 'accepted' : 'rejected');
    await ctx.grade(second, decision.actedOn.some(a => a === 'second') ? 'accepted' : 'rejected');
    if (decision.accept) return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(
      z.object({ id: z.string(), title: z.string(), section: sections, body: z.string(), status: z.enum(['ready', 'resubmitted']) })
    ),
  }),
  read: body =>
    body.drafts.map((d): SupplyOf<typeof draft> =>
      d.status === 'ready'
        ? { create: { title: d.title, section: d.section, body: d.body }, key: d.id }
        : { update: d.id, patch: { title: d.title, body: d.body }, state: 'submitted' }
    ),
});

const drafts = H.lane('drafts', draft)
  .handler(review)
  .suppliers(cmsPoll)
  .store(http.store(draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_state' }));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  if (!notes) return [];
  return act.remember(taste, {
    text: `When reviewing ${event.unit.data.section} drafts, ${notes}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { roles: [reviewerRole], facets: [sectionFacet.value(event.unit.data.section)] },
    status: 'candidate',
  });
});

const reviewerUptake = H.report('reviewer-uptake', metrics => {
  const byModel = metrics.rateBy({
    among: { entry: 'grade', kind: draft },
    count: { entry: 'grade', kind: draft, grade: 'accepted' },
    by: 'model',
    days: 180,
  });
  const bySeat = metrics.rateBy({
    among: { entry: 'grade', kind: draft },
    count: { entry: 'grade', kind: draft, grade: 'accepted' },
    by: 'seat',
    days: 180,
  });
  const rows: Record<string, (typeof byModel)[string]> = {};
  for (const key in byModel) rows[`model ${key}`] = byModel[key];
  for (const key in bySeat) rows[`seat ${key}`] = bySeat[key];
  return rows;
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(editorReview, H.halts.changed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes(drafts)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .reports(reviewerUptake)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = harness.start();
