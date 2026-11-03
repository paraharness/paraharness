import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model, PolicyContext } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as wordpress from 'harness-dsl/wordpress';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';
import * as claudeCode from 'harness-dsl/claude-code';

const queued = H.state('queued', 'pending');
const reviewing = H.state('reviewing', 'active');
const awaitingEditor = H.state('awaitingEditor', 'active');
const accepted = H.state('accepted', 'terminal', 'success');
const returned = H.state('returned', 'terminal', 'failure');
const stalled = H.state('stalled', 'waiting');

const Draft = H.work('draft')
  .attributes({ postId: z.number(), revision: z.number(), section: z.string(), title: z.string() })
  .fields({ content: z.string() })
  .states([queued, reviewing, awaitingEditor, accepted, returned, stalled])
  .key((unit) => `${unit.attributes.postId}@${unit.attributes.revision}`);

const houseTaste = H.memory.taste('house-taste').curated();
const factChecking = H.memory.experience('fact-checking');

const specificThenProven = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present),
    )
    .slice(0, c.limit),
);

const tastePlaybook = H.playbook('house-taste', houseTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);
const factLessons = H.playbook('fact-lessons', factChecking)
  .store(jsonl.memory('memory/fact-lessons.jsonl'))
  .recall(specificThenProven);

const editorial = H.decision('editorial', {
  verdict: z.enum(['accept', 'return']),
  notes: z.array(z.object({ rule: z.string(), because: z.string(), sectionOnly: z.boolean() })),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
});

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');
const reviewerModels: readonly Model[] = [sonnet, opus, haiku];

const actedOn = reviewerModels.map((model) => ({
  model,
  metric: H.metric(`editor-acted-on-${model.name}`)
    .of(editorial)
    .hit(
      (decision, fact) =>
        (decision.actedOnA && fact.attempt.models['reviewA'] === model.name) ||
        (decision.actedOnB && fact.attempt.models['reviewB'] === model.name),
    ),
}));

const rankedReviewers = (c: PolicyContext): readonly Model[] => {
  const reads = actedOn.map((entry) => ({
    model: entry.model,
    read: c.metrics.read(entry.metric, { kind: Draft, model: entry.model, window: 'all' }),
  }));
  const proven = reads.filter((r) => r.read.n >= 50).sort((a, b) => (b.read.rate ?? 0) - (a.read.rate ?? 0));
  const trial = reads.filter((r) => r.read.n < 50);
  return [...proven.slice(0, 1), ...trial, ...proven.slice(1)].map((r) => r.model);
};

const firstReviewerModel = H.policy.model('reviewer-a-model', reviewerModels, (c) => rankedReviewers(c)[0] ?? sonnet);
const secondReviewerModel = H.policy.model('reviewer-b-model', reviewerModels, (c) => rankedReviewers(c)[1] ?? opus);

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft for clarity, accuracy and house style. Cite the passage for every point.')
  .input({ draft: z.string(), section: z.string(), factIssues: z.array(z.string()) })
  .output({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.agent('reviewer-a', reviewer)
  .model(firstReviewerModel)
  .pool(apiAccount)
  .recalls([tastePlaybook, factLessons]);
const reviewerB = H.agent('reviewer-b', reviewer)
  .model(secondReviewerModel)
  .pool(apiAccount)
  .recalls([tastePlaybook, factLessons]);

const factCheck = H.command('fact-check', ['node', 'tools/fact-check.js']).parses({
  issues: z.array(z.string()),
  repeats: z.array(z.object({ rule: z.string(), because: z.string() })),
});
const mergeCritiques = H.command('merge-critiques', ['node', 'tools/merge-critiques.js']).parses({
  summary: z.string(),
});

const reviewFlow = H.flow('review-draft')
  .requires({ title: z.string(), section: z.string(), content: z.string() })
  .step('factcheck', factCheck, (c) => ({ stdin: c.input.content }))
  .step('reviewA', reviewerA, (c) => ({
    draft: c.input.content,
    section: c.input.section,
    factIssues: c.out.factcheck.data.issues,
  }))
  .step('reviewB', reviewerB, (c) => ({
    draft: c.input.content,
    section: c.input.section,
    factIssues: c.out.factcheck.data.issues,
  }))
  .step('merge', mergeCritiques, (c) => ({ stdin: JSON.stringify({ a: c.out.reviewA, b: c.out.reviewB }) }))
  .halt('editor', editorial, { ask: (c) => `${c.input.title}\n\n${c.out.merge.data.summary}` })
  .ends(['accepted', 'returned'], (c) => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const cms = { site: 'https://magazine.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, (post, supply) =>
      supply.create({
        attributes: { postId: post.id, revision: post.modifiedAt, section: post.section, title: post.title },
        fields: { content: post.content },
      }),
    ),
  ])
  .store(wordpress.store(Draft, { ...cms, status: { queued: 'pending', accepted: 'publish', returned: 'draft' } }))
  .runner(local.shell({ slots: 2 }))
  .retry(H.retry.fixed({ maxRetries: 2, delayMs: 60_000 }))
  .handler(reviewFlow, {
    opens: reviewing,
    during: { editor: awaitingEditor },
    ends: { accepted, returned },
    exhausted: stalled,
  });

const notesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.transition(drafts, { to: [returned] })).records(
  tastePlaybook,
  (e) =>
    (e.outputs.editor?.notes ?? []).map((note) => ({
      rule: note.rule,
      because: note.because,
      when: note.sectionOnly
        ? { kinds: [Draft], attributes: { section: e.unit.attributes.section } }
        : { kinds: [Draft] },
    })),
);

const repeatMistakesBecomeExperience = H.trigger(
  'repeat-mistakes-become-experience',
  H.on.step(drafts, 'factcheck'),
).records(factLessons, (e) =>
  e.output.data.repeats.map((r) => ({ rule: r.rule, because: r.because, when: { kinds: [Draft] } })),
);

const editorAccess = H.access('editor').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('data/content-ledger.sqlite'))
  .lanes([drafts])
  .triggers([notesBecomeTaste, repeatMistakesBecomeExperience])
  .schedule(H.policy.schedule('oldest-first', (c) => ({ start: c.order((x) => x.enqueuedAt) })))
  .clients([claudeCode.supervisor('editor', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('board.md'), markdown.telemetry('telemetry.md')]);
