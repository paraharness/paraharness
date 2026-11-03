import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as wordpress from 'harness-dsl/wordpress';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Submitted = H.state('submitted', 'pending');
const Reviewing = H.state('reviewing', 'active');
const AwaitingEditor = H.state('awaiting editor', 'active');
const Accepted = H.state('accepted', 'succeeded');
const Returned = H.state('returned', 'concluded');
const Failed = H.state('failed', 'failed');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), section: z.string() })
  .fields({ title: z.string(), content: z.string() })
  .states([Submitted, Reviewing, AwaitingEditor, Accepted, Returned, Failed])
  .key(unit => String(unit.attributes.postId));

const cms = { site: 'https://news.example.com', token: H.env('CMS_TOKEN') };
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('claude-opus-4-1');
const opusPrevious = anthropic.model('claude-opus-4');
const sonnet = anthropic.model('claude-sonnet-4-5');
const sonnetPrevious = anthropic.model('claude-sonnet-4');

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const EditorialTaste = H.memory.taste('editorial-taste').curated();
const FactCheckingExperience = H.memory.experience('fact-checking-experience');
const tasteJournal = H.journal('editorial-taste-journal', EditorialTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);
const factJournal = H.journal('fact-checking-journal', FactCheckingExperience)
  .store(jsonl.memory('memory/fact-checking.jsonl'))
  .recall(specificThenProven);

const reviewerAModel = H.policy.model('reviewer-a-model', [opus, opusPrevious], (c): Model => {
  const mine = c.metrics.read(editorActedOnReviewerA, { agent: reviewerA, model: opus, windowDays: 120 });
  const rival = c.metrics.read(editorActedOnReviewerB, { agent: reviewerB, windowDays: 120 });
  return mine.n >= 50 && rival.n >= 50 && mine.rate !== null && rival.rate !== null && mine.rate < rival.rate
    ? opusPrevious
    : opus;
});

const reviewerBModel = H.policy.model('reviewer-b-model', [sonnet, sonnetPrevious], (c): Model => {
  const mine = c.metrics.read(editorActedOnReviewerB, { agent: reviewerB, model: sonnet, windowDays: 120 });
  const rival = c.metrics.read(editorActedOnReviewerA, { agent: reviewerA, windowDays: 120 });
  return mine.n >= 50 && rival.n >= 50 && mine.rate !== null && rival.rate !== null && mine.rate < rival.rate
    ? sonnetPrevious
    : sonnet;
});

const reviewerRole = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft against the publication taste and fact-checking lessons.')
  .input({ title: z.string(), content: z.string(), section: z.string() })
  .output({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.agent('reviewer-a', reviewerRole).model(reviewerAModel).pool(apiAccount).recalls([tasteJournal, factJournal]);
const reviewerB = H.agent('reviewer-b', reviewerRole).model(reviewerBModel).pool(apiAccount).recalls([tasteJournal, factJournal]);

const factCheck = H.command('fact-check', ['tools/fact-check']).parses({
  repeatMistakes: z.array(z.object({ rule: z.string(), because: z.string() })),
});
const mergeCritiques = H.command('merge-critiques', ['tools/merge-critiques']).parses({ critique: z.string() });

const reviewFlow = H.flow('draft-review')
  .requires({ title: z.string(), content: z.string(), section: z.string() })
  .mark('reviewing')
  .step('reviewA', reviewerA, c => ({ title: c.input.title, content: c.input.content, section: c.input.section }))
  .step('reviewB', reviewerB, c => ({ title: c.input.title, content: c.input.content, section: c.input.section }))
  .step('factCheck', factCheck, c => ({ stdin: c.input.content }))
  .step('merge', mergeCritiques, c => ({
    stdin: JSON.stringify({ a: c.out.reviewA, b: c.out.reviewB, facts: c.out.factCheck.data }),
  }))
  .mark('awaitingEditor')
  .halt('editor', {
    ask: c => `Review "${c.input.title}" (${c.input.section}):\n\n${c.out.merge.data.critique}`,
    decision: {
      verdict: z.enum(['accept', 'return']),
      actedOn: z.enum(['a', 'b', 'both', 'neither']),
      notes: z.array(z.object({ rule: z.string(), sectionOnly: z.boolean() })),
    },
  })
  .ends(['accepted', 'returned'], c => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const draftLane = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 15 }), { ...cms, status: 'pending' }, post => ({
      attributes: { postId: post.id, section: post.section },
      fields: { title: post.title, content: post.content },
    })),
  ])
  .store(wordpress.store(Draft, {
    ...cms,
    status: { submitted: 'pending', reviewing: 'pending', 'awaiting editor': 'pending', accepted: 'publish', returned: 'draft' },
  }))
  .runner(local.shell({ slots: 2 }))
  .handler(reviewFlow, {
    states: {
      reviewing: Reviewing,
      awaitingEditor: AwaitingEditor,
      accepted: Accepted,
      returned: Returned,
      failed: Failed,
    },
  });

const editorActedOnReviewerA = H.metric('editor-acted-on-reviewer-a')
  .step(reviewFlow, 'editor')
  .hit(decision => decision.actedOn === 'a' || decision.actedOn === 'both');
const editorActedOnReviewerB = H.metric('editor-acted-on-reviewer-b')
  .step(reviewFlow, 'editor')
  .hit(decision => decision.actedOn === 'b' || decision.actedOn === 'both');

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.transition(draftLane, { to: [Returned] }))
  .records(tasteJournal, event =>
    (event.outputs.editor ? event.outputs.editor.notes : []).map(note => ({
      rule: note.rule,
      because: `the editor returned "${event.unit.key}" with this note`,
      when: note.sectionOnly
        ? { kinds: [Draft], attributes: { section: event.unit.attributes.section } }
        : { kinds: [Draft] },
    })),
  );

const repeatMistakesBecomeExperience = H.trigger('repeat-mistakes-become-experience', H.on.step(draftLane, 'factCheck'))
  .where(event => event.output.data.repeatMistakes.length > 0)
  .records(factJournal, event => event.output.data.repeatMistakes);

const editorAccess = H.access('editor').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('review-ledger.db'))
  .lanes([draftLane])
  .triggers([returnedNotesBecomeTaste, repeatMistakesBecomeExperience])
  .clients([claudeCode.supervisor('editor-supervisor', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
