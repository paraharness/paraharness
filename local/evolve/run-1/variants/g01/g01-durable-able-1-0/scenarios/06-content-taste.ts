import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import type { ChoicePolicy, Metrics } from 'harness-dsl/kernel';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as wordpress from 'harness-dsl/wordpress';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Queued = H.state('queued', 'pending');
const Reviewing = H.state('reviewing', 'active');
const AwaitingEditor = H.state('awaiting-editor', 'active');
const Accepted = H.state('accepted', 'terminal', 'success');
const Returned = H.state('returned', 'terminal', 'failure');
const ReviewFailed = H.state('review-failed', 'terminal', 'failure');

const Draft = H.work('draft')
  .attributes({ postId: z.number(), revision: z.number(), section: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Queued, Reviewing, AwaitingEditor, Accepted, Returned, ReviewFailed])
  .key(draft => `${draft.attributes.postId}@${draft.attributes.revision}`);

const editorTaste = H.memory.taste('editor-taste').curated();
const factCheckingLessons = H.memory.experience('fact-checking-lessons');

const specificFirst = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const tasteJournal = H.journal('editor-taste-journal', editorTaste)
  .store(jsonl.memory('memory/editor-taste.jsonl'))
  .recall(specificFirst);
const lessonsJournal = H.journal('fact-checking-journal', factCheckingLessons)
  .store(jsonl.memory('memory/fact-checking.jsonl'))
  .recall(specificFirst);

const editorialApi = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('claude-opus-4');
const sonnet = anthropic.model('claude-sonnet-4');
const haiku = anthropic.model('claude-haiku-4');
const roster = [opus, sonnet, haiku];

const seatOrder = (metrics: Metrics): readonly Model[] =>
  actedOnByModel
    .map((entry, index) => ({ entry, index, reading: metrics.read(entry.metric, { lane: drafts, window: { days: 60 } }) }))
    .map(scored => ({ ...scored, score: scored.reading.n < 50 ? 1 : (scored.reading.rate ?? 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(scored => scored.entry.model);

const firstSeat: ChoicePolicy<Model> = H.policy.model('first-reviewer-seat', roster, c => seatOrder(c.metrics)[0] ?? opus);
const secondSeat: ChoicePolicy<Model> = H.policy.model('second-reviewer-seat', roster, c => seatOrder(c.metrics)[1] ?? sonnet);

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft against the house taste and the fact-checking lessons. Be concrete.')
  .input({ title: z.string(), body: z.string(), section: z.string() })
  .output({ critique: z.string(), points: z.array(z.string()) });

const firstReviewer = H.agent('first-reviewer', reviewer).model(firstSeat).pool(editorialApi).recalls([tasteJournal, lessonsJournal]);
const secondReviewer = H.agent('second-reviewer', reviewer).model(secondSeat).pool(editorialApi).recalls([tasteJournal, lessonsJournal]);

const factCheck = H.command('fact-check', ['bin/fact-check']).parses({
  repeats: z.array(z.object({ rule: z.string(), because: z.string() })),
});
const mergeCritiques = H.command('merge-critiques', ['bin/merge-critiques']).parses({
  summary: z.string(),
  points: z.array(z.string()),
});

const reviewFlow = H.flow('draft-review')
  .requires({ title: z.string(), body: z.string(), section: z.string() })
  .mark('reviewing')
  .step('critiqueFirst', firstReviewer, c => ({ title: c.input.title, body: c.input.body, section: c.input.section }))
  .step('critiqueSecond', secondReviewer, c => ({ title: c.input.title, body: c.input.body, section: c.input.section }))
  .step('factCheck', factCheck, c => ({ stdin: c.input.body }))
  .step('merge', mergeCritiques, c => ({
    stdin: JSON.stringify({ first: c.out.critiqueFirst, second: c.out.critiqueSecond, facts: c.out.factCheck.data }),
  }))
  .mark('awaitingEditor')
  .halt('editor', {
    ask: c => `Accept or return "${c.input.title}" (${c.input.section})?\n\n${c.out.merge.data.summary}`,
    decision: {
      verdict: z.enum(['accept', 'return']),
      actedOn: z.array(z.enum(['first', 'second'])),
      notes: z.array(z.object({ rule: z.string(), because: z.string(), sectionOnly: z.boolean() })),
    },
  })
  .ends(['accepted', 'returned'], c => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, post => ({
      create: {
        attributes: { postId: post.id, revision: post.modifiedAt, section: post.section },
        fields: { title: post.title, body: post.content },
      },
    })),
  ])
  .store(
    wordpress.store(Draft, {
      ...cms,
      status: { queued: 'pending', reviewing: 'pending', 'awaiting-editor': 'pending', accepted: 'publish', returned: 'draft' },
    }),
  )
  .runner(local.shell({ slots: 2 }))
  .handler(reviewFlow, {
    states: {
      reviewing: Reviewing,
      awaitingEditor: AwaitingEditor,
      accepted: Accepted,
      returned: Returned,
      failed: ReviewFailed,
    },
  });

const seatOf = (models: Readonly<Record<string, string>>, model: Model): 'first' | 'second' | null =>
  models['critiqueFirst'] === model.name ? 'first' : models['critiqueSecond'] === model.name ? 'second' : null;

const actedOnByModel = roster.map(model => ({
  model,
  metric: H.metric(`editor-acted-on-${model.name}`)
    .step(reviewFlow, 'editor')
    .hit((decision, event) => {
      const seat = seatOf(event.attempt.models, model);
      return seat === null ? null : decision.actedOn.includes(seat);
    }),
}));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.transition(drafts, { to: [Returned] }))
  .records(tasteJournal, e =>
    (e.outputs.editor?.notes ?? []).map(note => ({
      rule: note.rule,
      because: note.because,
      when: note.sectionOnly
        ? { kinds: [Draft], attributes: { section: e.unit.attributes.section } }
        : { kinds: [Draft] },
    })),
  );

const repeatMistakesBecomeLessons = H.trigger('repeat-mistakes-become-lessons', H.on.step(drafts, 'factCheck'))
  .records(lessonsJournal, e =>
    e.output.data.repeats.map(repeat => ({ rule: repeat.rule, because: repeat.because, when: { roles: [reviewer] } })),
  );

const editorAccess = H.access('editor').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('state/content-review.db'))
  .lanes([drafts])
  .triggers([returnedNotesBecomeTaste, repeatMistakesBecomeLessons])
  .schedule(H.policy.schedule('longest-waiting-first', c => ({ start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients([claudeCode.supervisor('editor-desk', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = harness.start();
