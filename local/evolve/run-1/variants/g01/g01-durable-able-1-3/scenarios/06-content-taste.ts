import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PolicyContext } from 'harness-dsl/kernel';
import * as claude from 'harness-dsl/claude-code';
import * as wordpress from 'harness-dsl/wordpress';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'terminal', 'failure');
const ReviewBroken = H.state('ReviewBroken', 'terminal', 'failure');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), section: z.string(), title: z.string() })
  .fields({ content: z.string() })
  .states([Queued, Reviewing, Accepted, Returned, ReviewBroken])
  .key((unit) => String(unit.attributes.postId));

const connection = { site: 'https://magazine.example.com', token: H.env('WORDPRESS_TOKEN') };

const subscription = claude.subscription('editorial-max', { configDir: H.env('CLAUDE_CONFIG_DIR') });
const opus = claude.model('claude-opus-4');
const sonnet = claude.model('claude-sonnet-4');
const challenger = claude.model('claude-haiku-4');

const ranked = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const editorialTaste = H.memory.taste('editorial-taste').curated();
const factChecking = H.memory.experience('fact-checking');

const tasteJournal = H.journal('editor-taste', editorialTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(ranked);
const factJournal = H.journal('fact-lessons', factChecking)
  .store(jsonl.memory('memory/fact-checking.jsonl'))
  .recall(ranked);

const window = { days: 30 };

function weakerReviewer(c: PolicyContext): 'a' | 'b' | null {
  const a = c.metrics.read(actedOnA, { lane: drafts, window });
  const b = c.metrics.read(actedOnB, { lane: drafts, window });
  if (a.n < 50 || b.n < 50 || a.rate === null || b.rate === null) return null;
  if (a.rate < b.rate) return 'a';
  if (b.rate < a.rate) return 'b';
  return null;
}

const reviewerAModel = H.policy.model('reviewer-a-model', [opus, challenger], (c) =>
  weakerReviewer(c) === 'a' ? challenger : opus,
);
const reviewerBModel = H.policy.model('reviewer-b-model', [sonnet, challenger], (c) =>
  weakerReviewer(c) === 'b' ? challenger : sonnet,
);

const reviewer = H.role('reviewer')
  .intents(['read', 'remember'])
  .instructions('Critique the draft for argument, accuracy and house style. Name concrete passages.')
  .input({ title: z.string(), section: z.string(), content: z.string() })
  .output({ critique: z.string(), issues: z.array(z.string()) });

const reviewerA = H.agent('reviewer-a', reviewer)
  .model(reviewerAModel)
  .pool(subscription)
  .recalls([tasteJournal, factJournal]);
const reviewerB = H.agent('reviewer-b', reviewer)
  .model(reviewerBModel)
  .pool(subscription)
  .recalls([tasteJournal, factJournal]);

const mergeCritiques = H.command('merge-critiques', ['node', 'scripts/merge-critiques.js']).parses({
  merged: z.string(),
});
const factCheck = H.command('fact-check', ['node', 'scripts/fact-check.js']).parses({
  repeatMistake: z.boolean(),
  lesson: z.string(),
  because: z.string(),
});

const reviewFlow = H.flow('draft-review')
  .requires({ title: z.string(), section: z.string(), content: z.string() })
  .mark('reviewing')
  .step('critiqueA', reviewerA, (c) => ({ title: c.input.title, section: c.input.section, content: c.input.content }))
  .step('critiqueB', reviewerB, (c) => ({ title: c.input.title, section: c.input.section, content: c.input.content }))
  .step('merge', mergeCritiques, (c) => ({
    stdin: JSON.stringify({ a: c.out.critiqueA, b: c.out.critiqueB }),
  }), { onRestart: 'rerun' })
  .step('factCheck', factCheck, (c) => ({ stdin: c.input.content }), { onRestart: 'rerun' })
  .halt('editor', {
    ask: (c) => `Review "${c.input.title}" (${c.input.section}).\n\n${c.out.merge.data.merged}`,
    decision: {
      verdict: z.enum(['accept', 'return']),
      notes: z.string(),
      actedOn: z.enum(['a', 'b', 'both', 'neither']),
    },
  })
  .ends(['accepted', 'returned'], (c) => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const actedOnA = H.metric('editor-acted-on-a')
  .step(reviewFlow, 'editor')
  .hit((decision) => decision.actedOn === 'a' || decision.actedOn === 'both');
const actedOnB = H.metric('editor-acted-on-b')
  .step(reviewFlow, 'editor')
  .hit((decision) => decision.actedOn === 'b' || decision.actedOn === 'both');

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...connection, status: 'pending' }, (post) => ({
      attributes: { postId: post.id, section: post.section, title: post.title },
      fields: { content: post.content },
    })),
  ])
  .store(wordpress.store(Draft, {
    ...connection,
    status: { Reviewing: 'pending', Accepted: 'publish', Returned: 'draft', ReviewBroken: 'pending' },
  }))
  .handler(reviewFlow, {
    states: { reviewing: Reviewing, accepted: Accepted, returned: Returned, failed: ReviewBroken },
  })
  .runner(local.shell({ slots: 2 }))
  .wip(4);

const returnedNotesBecomeTaste = H.trigger('returned-notes-to-taste', H.on.transition(drafts, { to: [Returned] }))
  .where((e) => (e.outputs.editor?.notes ?? '').trim().length > 0)
  .records(tasteJournal, (e) => [
    {
      rule: e.outputs.editor?.notes ?? '',
      because: `the editor returned "${e.unit.attributes.title}" with this note`,
      when: { kinds: [Draft], attributes: { section: e.unit.attributes.section } },
    },
  ]);

const repeatMistakesBecomeExperience = H.trigger('repeat-mistake-to-experience', H.on.step(drafts, 'factCheck'))
  .where((e) => e.output.data.repeatMistake)
  .records(factJournal, (e) => [
    { rule: e.output.data.lesson, because: e.output.data.because, when: { kinds: [Draft] } },
  ]);

const editorAccess = H.access('editor').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const contentHarness = H.harness('content-review')
  .ledger(sqlite.ledger('content-ledger.sqlite'))
  .lanes([drafts])
  .triggers([returnedNotesBecomeTaste, repeatMistakesBecomeExperience])
  .schedule(H.policy.schedule('oldest-first', (c) => ({
    start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients([claude.supervisor('editor-desk', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
