import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Metrics, Model, Rate, SupplyOf } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sectionSchema);

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

export const draft = H.kind('Draft')
  .data(
    z.object({
      title: z.string(),
      body: z.string(),
      section: sectionSchema,
      editorNotes: z.string().optional(),
    })
  )
  .states(submitted, returned, accepted, withdrawn);

const critiquing = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sectionSchema }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft for the editor.\n\n${input.title}\n\n${input.body}`);

const tasteMemory = H.memory('editor-taste', 'taste');
const factCheckingMemory = H.memory('fact-checking', 'experience');
const taste = H.journal('editor-taste', tasteMemory, jsonl.memory('memory/taste.jsonl'));
const factChecking = H.journal('fact-checking', factCheckingMemory, jsonl.memory('memory/fact-checking.jsonl'));

const editorDecision = H.halt(
  'editor-decision',
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOnFirst: z.boolean(),
    actedOnSecond: z.boolean(),
  })
).about(z.object({ merged: z.string() }));

const opus = claude.model('claude-opus-4-1');
const sonnet = claude.model('claude-sonnet-4-5');
const challenger = claude.model('claude-haiku-4-5');

const editorResolutions: EntryFilter = { entry: 'halt', halt: editorDecision, status: 'resolved' };
const swapAfterSamples = 50;

const actedOnRate = (metrics: Metrics, which: 'first' | 'second', model: Model): Rate =>
  metrics
    .rateBy({
      among: editorResolutions,
      count: { ...editorResolutions, decision: which === 'first' ? { actedOnFirst: true } : { actedOnSecond: true } },
      by: { modelOf: which === 'first' ? firstReviewer : secondReviewer },
      days: 90,
    })
    .of(model);

const chooseReviewerModel = (metrics: Metrics, mine: 'first' | 'second'): Model => {
  const incumbent = mine === 'first' ? opus : sonnet;
  const rivalModel = mine === 'first' ? sonnet : opus;
  const own = actedOnRate(metrics, mine, incumbent);
  const rival = actedOnRate(metrics, mine === 'first' ? 'second' : 'first', rivalModel);
  const compared = own.samples >= swapAfterSamples && rival.samples >= swapAfterSamples;
  return compared && own.value !== null && rival.value !== null && own.value < rival.value ? challenger : incumbent;
};

const firstReviewerModel = H.policy.model('first-reviewer-model', [opus, challenger], choice =>
  chooseReviewerModel(choice.metrics, 'first')
);
const secondReviewerModel = H.policy.model('second-reviewer-model', [sonnet, challenger], choice =>
  chooseReviewerModel(choice.metrics, 'second')
);

const firstReviewer = H.seat('first-reviewer', critiquing).model(firstReviewerModel).recalls(taste, factChecking);
const secondReviewer = H.seat('second-reviewer', critiquing).model(secondReviewerModel).recalls(taste, factChecking);

const subscription = claude.subscription('claude-desk', { token: H.env('CLAUDE_TOKEN') });
const deskPool = H.pool('desk', [{ account: subscription, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(input => ['scripts/fact-check', '--text', input.body])
  .on(local);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['scripts/merge-critiques', '--first', input.first, '--second', input.second])
  .on(local);

const review = H.flow('review-draft')
  .for(draft)
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    const draftSection = ctx.unit.data.section;
    const checked = await ctx.run(factCheck, { body });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(factChecking, {
        text: mistake.lesson,
        because: mistake.because,
        when: { kinds: [draft] },
        status: 'accepted',
      });
    }
    const first = await ctx.run(firstReviewer, { title, body, section: draftSection });
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(secondReviewer, { title, body, section: draftSection });
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorDecision, merged.value, { merged: merged.value });
    if (decision.verdict === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  section: sectionSchema,
  status: z.enum(['submitted', 'resubmitted', 'withdrawn']),
});

const toSupply = (found: z.infer<typeof cmsDraft>): SupplyOf<typeof draft> => {
  if (found.status === 'submitted') {
    return { create: { title: found.title, body: found.body, section: found.section }, key: found.id };
  }
  if (found.status === 'resubmitted') {
    return { update: found.id, patch: { title: found.title, body: found.body }, state: 'submitted' };
  }
  return { update: found.id, state: 'withdrawn' };
};

const cmsToken = H.env('CMS_TOKEN');

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?changed=recent',
  every: { minutes: 15 },
  headers: { authorization: cmsToken },
  body: z.object({ drafts: z.array(cmsDraft) }),
  read: body => body.drafts.map(toSupply),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: { authorization: cmsToken },
  stateField: 'review_state',
});

export const draftsLane = H.lane('drafts', draft)
  .handler(review, { retries: 1, exhausted: H.halts.exhausted })
  .suppliers(cmsPoll)
  .store(cmsStore)
  .facet(section, data => data.section);

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(draft, 'returned'),
  (event, act) => {
    const notes = event.unit.data.editorNotes;
    if (notes === undefined || notes.trim() === '') return [];
    return act.remember(taste, {
      text: `When reviewing a ${event.unit.data.section} draft, check for what the editor asked: ${notes}`,
      because: `the editor returned "${event.unit.data.title}" with these notes`,
      when: { kinds: [draft], facets: [section.of(event.unit.data.section)] },
      status: 'candidate',
    });
  }
);

const editor = claude.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
    H.ops.resolve(editorDecision, H.halts.exhausted, H.halts.interrupted, H.halts.definitionChanged),
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content.sqlite'))
  .lanes(draftsLane)
  .pools(deskPool)
  .triggers(returnedNotesBecomeTaste)
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
