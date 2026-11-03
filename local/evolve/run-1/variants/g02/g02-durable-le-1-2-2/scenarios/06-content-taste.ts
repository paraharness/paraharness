import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model, Metric } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as wordpress from 'harness-dsl/wordpress';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Queued = H.state('Queued', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingEditor = H.state('AwaitingEditor', 'active');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'terminal', 'neutral');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), section: z.string() })
  .fields({ title: z.string(), content: z.string() })
  .states([Queued, Reviewing, AwaitingEditor, Accepted, Returned])
  .key((u) => String(u.attributes.postId));

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft against the publication taste you are given. Name concrete changes, most important first.')
  .input({ title: z.string(), section: z.string(), content: z.string() })
  .output({ critique: z.string(), changes: z.array(z.string()) });

const EditorialTaste = H.memory.taste('editorial-taste').curated();
const FactCheckLesson = H.memory.experience('fact-check-lesson');

const mostSpecificFirst = H.policy.recall('most-specific-first', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const taste = H.journal('editorial-taste', EditorialTaste)
  .store(jsonl.memory('.harness/taste.jsonl'))
  .recall(mostSpecificFirst);
const lessons = H.journal('fact-check-lessons', FactCheckLesson)
  .store(jsonl.memory('.harness/fact-check-lessons.jsonl'))
  .recall(mostSpecificFirst);

const editorVerdict = H.decision('editor-verdict', {
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
});

const actedOnA = H.metric('editor-acted-on-reviewer-a').of(editorVerdict).hit((d) => d.actedOnA);
const actedOnB = H.metric('editor-acted-on-reviewer-b').of(editorVerdict).hit((d) => d.actedOnB);

const keepOrSwap = (name: string, primary: Model, challenger: Model, mine: Metric, rival: Metric) =>
  H.policy.model(name, [primary, challenger], (c) => {
    const window = { days: 60 };
    const own = c.metrics.read(mine, { agent: c.agent, model: primary, window });
    const other = c.metrics.read(rival, { window });
    if (own.n < 50 || other.n < 50 || own.rate === null || other.rate === null) return primary;
    if (own.rate >= other.rate) return primary;
    const tried = c.metrics.read(mine, { agent: c.agent, model: challenger, window });
    return tried.n >= 50 && tried.rate !== null && tried.rate < own.rate ? primary : challenger;
  });

const api = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('claude-opus-4-1');
const opusNext = anthropic.model('claude-opus-4-5');
const sonnet = anthropic.model('claude-sonnet-4');
const sonnetNext = anthropic.model('claude-sonnet-4-5');

const reviewerA = H.agent('reviewer-a', reviewer)
  .model(keepOrSwap('reviewer-a-model', opus, opusNext, actedOnA, actedOnB))
  .pool(api)
  .recalls([taste, lessons]);
const reviewerB = H.agent('reviewer-b', reviewer)
  .model(keepOrSwap('reviewer-b-model', sonnet, sonnetNext, actedOnB, actedOnA))
  .pool(api)
  .recalls([taste, lessons]);

const mergeCritiques = H.command('merge-critiques', ['./bin/merge-critiques', '--json']).parses({ merged: z.string() });
const factCheck = H.command('fact-check', ['./bin/fact-check', '--json']).parses({
  repeats: z.array(z.object({ lesson: z.string(), because: z.string() })),
});

const reviewDraft = H.flow('review-draft')
  .requires({ postId: z.number(), section: z.string(), title: z.string(), content: z.string() })
  .step('critiqueA', reviewerA, (c) => ({ title: c.input.title, section: c.input.section, content: c.input.content }))
  .step('critiqueB', reviewerB, (c) => ({ title: c.input.title, section: c.input.section, content: c.input.content }))
  .step('merge', mergeCritiques, (c) => ({ stdin: JSON.stringify({ a: c.out.critiqueA, b: c.out.critiqueB }) }))
  .step('factCheck', factCheck, (c) => ({ stdin: c.input.content }))
  .mark('awaitingEditor')
  .halt('editor', editorVerdict, {
    ask: (c) => `${c.input.title}\n\n${c.out.merge.data.merged}\n\nFact-check repeats: ${c.out.factCheck.data.repeats.length}`,
  })
  .ends(['accepted', 'returned'], (c) => (c.out.editor.action === 'accept' ? 'accepted' : 'returned'));

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, (post, to) =>
      to.create({
        attributes: { postId: post.id, section: post.section },
        fields: { title: post.title, content: post.content },
      }),
    ),
  ])
  .store(wordpress.store(Draft, { ...cms, status: { Reviewing: 'pending', AwaitingEditor: 'pending', Accepted: 'publish', Returned: 'draft' } }))
  .reuseKeys()
  .runner(local.shell({ slots: 2 }))
  .wip(4)
  .handler(reviewDraft, {
    ends: { accepted: Accepted, returned: Returned },
    marks: { awaitingEditor: AwaitingEditor },
  });

const scopedSections = ['sports', 'opinion'];

const notesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.transition(drafts, { to: [Returned] }))
  .records(taste, (e) => {
    const notes = e.outputs.editor?.notes ?? '';
    const section = e.unit.attributes.section;
    const when = scopedSections.includes(section)
      ? { kinds: [Draft], roles: [reviewer], attributes: { section } }
      : { kinds: [Draft], roles: [reviewer] };
    return notes
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({
        rule: `When reviewing a draft, check this: ${line}`,
        because: `the editor returned draft ${e.unit.key} with this note`,
        when,
      }));
  });

const repeatMistakesBecomeLessons = H.trigger('repeat-mistakes-become-lessons', H.on.step(drafts, 'factCheck'))
  .where((e) => e.status === 'succeeded')
  .records(lessons, (e) =>
    e.output.data.repeats.map((repeat) => ({
      rule: repeat.lesson,
      because: repeat.because,
      when: { kinds: [Draft], roles: [reviewer] },
    })),
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
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([drafts])
  .triggers([notesBecomeTaste, repeatMistakesBecomeLessons])
  .schedule(H.policy.schedule('longest-waiting-first', (c) => ({ start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients([claudeCode.supervisor('editor-supervisor', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
