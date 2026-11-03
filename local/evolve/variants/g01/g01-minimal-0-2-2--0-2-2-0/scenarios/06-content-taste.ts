import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Model, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const swapAfterSamples = 50;

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'neutral');
const reviewFailed = H.state('reviewFailed', 'terminal', 'failure');

const draft = H.kind('Draft')
  .data(z.object({ draftId: z.string(), title: z.string(), section: sections, body: z.string(), editorNotes: z.string() }))
  .states(submitted, accepted, returned, reviewFailed);

const editorTaste = H.memory('editor-taste', 'taste');
const factLessons = H.memory('fact-checking-lessons', 'experience');
const tasteJournal = H.library('editor-taste-journal', editorTaste, jsonl.memory('memory/taste.jsonl'));
const factJournal = H.library('fact-checking-journal', factLessons, jsonl.memory('memory/fact-checking.jsonl'));

const apiAccount = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('editorial-models', [{ account: apiAccount, share: 1 }]);
const opusIncumbent = anthropic.model('claude-opus-4-1');
const opusChallenger = anthropic.model('claude-opus-4');
const sonnetIncumbent = anthropic.model('claude-sonnet-4-5');
const sonnetChallenger = anthropic.model('claude-sonnet-4');

const editorDecision = H.halt(
  'editor-decision',
  z.object({ action: z.enum(['accept', 'return']), notes: z.string(), actedOnA: z.boolean(), actedOnB: z.boolean() })
).about(z.object({ title: z.string(), critiqueA: z.string(), critiqueB: z.string() }));

const actedOnA = editorDecision.resolved({ actedOnA: true });
const actedOnB = editorDecision.resolved({ actedOnB: true });

const reviewerModel = (name: string, own: EntryFilter, rival: EntryFilter, incumbent: Model, challenger: Model) =>
  H.policy.model(name, [incumbent, challenger], choice => {
    const among = editorDecision.resolved();
    const mine = choice.metrics.rate({ among, count: own, days: 30 });
    const theirs = choice.metrics.rate({ among, count: rival, days: 30 });
    const enough = mine.samples >= swapAfterSamples && theirs.samples >= swapAfterSamples;
    const weaker = enough && (mine.value ?? 0) < (theirs.value ?? 0);
    return weaker ? challenger : incumbent;
  });

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: sections, body: z.string(), factIssues: z.array(z.string()) }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}".\n\nFact-check issues: ${input.factIssues.join('; ')}\n\n${input.body}`);

const reviewerA = H.seat('reviewer-a', reviewerRole)
  .model(reviewerModel('reviewer-a-model', actedOnA, actedOnB, opusIncumbent, opusChallenger))
  .recalls(tasteJournal, factJournal);
const reviewerB = H.seat('reviewer-b', reviewerRole)
  .model(reviewerModel('reviewer-b-model', actedOnB, actedOnA, sonnetIncumbent, sonnetChallenger))
  .recalls(tasteJournal, factJournal);

const local = shell.local('local', { slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({
    issues: z.array(z.string()),
    repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })),
  }))
  .argv(input => ['fact-check', '--text', input.body])
  .on(local)
  .recovery('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.first, '--second', input.second])
  .on(local)
  .recovery('rerun');

const review = H.flow('review-draft')
  .for(draft)
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    const checked = await ctx.run(factCheck, { body });
    if (!checked.ok) return ctx.fail(checked.error);
    for (const mistake of checked.value.repeatMistakes) {
      await ctx.remember(factJournal, { text: mistake.lesson, because: mistake.because, when: { roles: [reviewerRole] } });
    }
    const sectionValue = section.of(ctx.unit.data.section);
    ctx.tag(sectionValue);
    const scope = { skills: [sectionValue] };
    const input = { title, section: ctx.unit.data.section, body, factIssues: checked.value.issues };
    const first = await ctx.run(reviewerA, input, { scope });
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, input, { scope });
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorDecision, merged.value, {
      title,
      critiqueA: first.value.critique,
      critiqueB: second.value.critique,
    });
    if (decision.action === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=awaiting-review',
  every: { minutes: 5 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(z.object({ id: z.string(), revision: z.number(), title: z.string(), section: sections, body: z.string() })),
  }),
  read: body =>
    body.drafts.map((d): SupplyOf<typeof draft> => ({
      create: { draftId: d.id, title: d.title, section: d.section, body: d.body, editorNotes: '' },
      key: `${d.id}#${d.revision}`,
    })),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_status',
});

const retryOnce = H.policy.attemptRetry('retry-once', view => (view.failedAttempts >= 2 ? 'stop' : { retryInMs: 10 * 60 * 1000 }));

const drafts = H.lane('drafts', draft)
  .handler(review)
  .suppliers(cmsPoll)
  .store(cmsStore)
  .wip(4)
  .retry(retryOnce, 'reviewFailed');

const returnedNotesBecomeTaste = H.trigger(
  'returned-notes-become-taste-candidates',
  H.on.enters(draft, 'returned'),
  (event, act) =>
    act.remember(tasteJournal, {
      text: `When reviewing ${event.unit.data.section} drafts, check for what the editor asked: ${event.unit.data.editorNotes}`,
      because: `the editor returned "${event.unit.data.title}" with these notes`,
      when: { kinds: [draft], roles: [reviewerRole], skills: [section.of(event.unit.data.section)] },
      status: 'candidate',
    })
);

const supervisor = cc.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorDecision),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content-review.sqlite'))
  .lanes(drafts)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = contentReview.start();
