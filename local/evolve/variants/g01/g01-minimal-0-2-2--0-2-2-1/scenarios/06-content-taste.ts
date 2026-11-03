import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Metrics, Model, Rate } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'neutral');

const draftShape = z.object({ id: z.string(), title: z.string(), section: sections, body: z.string() });

const draft = H.kind('draft')
  .data(draftShape.extend({ editorNotes: z.string().optional() }))
  .states(submitted, accepted, returned);

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), section: sections, body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(piece => `Critique this ${piece.section} draft, "${piece.title}":\n\n${piece.body}`)
  .intents(['read']);

const editorReview = H.halt('editor-review', z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string().optional(),
  actedOnFirst: z.boolean(),
  actedOnSecond: z.boolean(),
}));

const editorActions: EntryFilter = { entry: 'halt', halt: editorReview, status: 'resolved', resolver: 'human' };

type Side = 'actedOnFirst' | 'actedOnSecond';

function actedOnRate(metrics: Metrics, side: Side): Rate {
  return metrics.rate({ among: editorActions, count: { ...editorActions, decision: { [side]: true } }, days: 60 });
}

function reviewerModel(name: string, incumbent: Model, challenger: Model, mine: Side, theirs: Side) {
  return H.policy.model(name, [incumbent, challenger], choice => {
    const own = actedOnRate(choice.metrics, mine);
    const other = actedOnRate(choice.metrics, theirs);
    if (own.samples < 50 || other.samples < 50) return incumbent;
    return (own.value ?? 0) < (other.value ?? 0) ? challenger : incumbent;
  });
}

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');

const editorialTaste = H.memory('editorial-taste', 'taste');
const factCheckExperience = H.memory('fact-check-experience', 'experience');
const tasteJournal = H.library('editorial-taste-journal', editorialTaste, jsonl.memory('.harness/taste.jsonl'));
const factJournal = H.library('fact-check-journal', factCheckExperience, jsonl.memory('.harness/fact-checks.jsonl'));

const firstReviewer = H.seat('first-reviewer', reviewerRole)
  .model(reviewerModel('first-reviewer-model', opus, challenger, 'actedOnFirst', 'actedOnSecond'))
  .recalls(tasteJournal, factJournal);
const secondReviewer = H.seat('second-reviewer', reviewerRole)
  .model(reviewerModel('second-reviewer-model', sonnet, challenger, 'actedOnSecond', 'actedOnFirst'))
  .recalls(tasteJournal, factJournal);

const local = shell.local('local', { slots: 2 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeats: z.array(z.string()) }))
  .argv(piece => ['./scripts/fact-check', piece.body])
  .on(local)
  .recovery('rerun');
const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(critiques => ['./scripts/merge-critiques', critiques.first, critiques.second])
  .on(local)
  .recovery('rerun');

const reviewDraft = H.flow('review-draft').for(draft).does(async ctx => {
  const { title, body } = ctx.unit.data;
  const pieceSection = ctx.unit.data.section;
  await ctx.facet(section, pieceSection);
  const brief = { title, section: pieceSection, body };
  const first = await ctx.run(firstReviewer, brief);
  if (!first.ok) return ctx.fail(first.error);
  const second = await ctx.run(secondReviewer, brief);
  if (!second.ok) return ctx.fail(second.error);
  const facts = await ctx.run(factCheck, { body });
  if (facts.ok) {
    for (const repeat of facts.value.repeats) {
      await ctx.remember(factJournal, {
        text: `When a draft claims "${repeat}", verify it against a primary source before critiquing style`,
        because: 'the fact check found this mistake in more than one draft',
        when: { kinds: [draft], roles: [reviewerRole] },
      });
    }
  }
  const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);
  const verdict = await ctx.halt(editorReview, merged.value);
  if (verdict.action === 'accept') return 'accepted';
  await ctx.update({ editorNotes: verdict.notes ?? '' });
  return 'returned';
});

const cmsHeaders = { 'X-Api-Token': H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready-for-review',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(draftShape) }),
  read: body => body.drafts.map(piece => ({ create: piece, key: piece.id })),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'review_state',
});

const drafts = H.lane('drafts', draft)
  .handler(reviewDraft)
  .suppliers(cmsPoll)
  .store(cmsStore)
  .wip(3)
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'returned' });

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  if (!notes) return [];
  return act.remember(tasteJournal, {
    text: `When reviewing ${event.unit.data.section} drafts: ${notes}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { kinds: [draft], roles: [reviewerRole], facets: [section.of(event.unit.data.section)] },
    status: 'candidate',
  });
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('editorial-api', [{ account: apiAccount, share: 1 }]);

const editor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorReview),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(drafts)
  .pools(apiPool)
  .triggers(returnedNotesBecomeTaste)
  .clients(editor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
