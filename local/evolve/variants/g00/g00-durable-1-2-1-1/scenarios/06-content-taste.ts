import { z } from 'zod';
import { H, type Model, type Metric } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as wordpress from 'harness-dsl/wordpress';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Incoming = H.state('Incoming', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const WithEditor = H.state('WithEditor', 'waiting');
const Held = H.state('Held', 'waiting');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'terminal', 'neutral');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), revision: z.number(), section: z.string() })
  .fields({ title: z.string(), content: z.string() })
  .states([Incoming, Reviewing, WithEditor, Held, Accepted, Returned])
  .key((u) => `${u.attributes.postId}@${u.attributes.revision}`);

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft for structure, accuracy and voice. Name each change you would make.')
  .input({ title: z.string(), section: z.string(), content: z.string(), factIssues: z.array(z.string()) })
  .output({ critique: z.string(), points: z.array(z.string()) });

const editorialTaste = H.memory.taste('editorial-taste').curated();
const factLessons = H.memory.experience('fact-check-lessons');

const mostSpecific = H.policy.recall('most-specific-first', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const tasteJournal = H.journal('taste-journal', editorialTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(mostSpecific);
const lessonsJournal = H.journal('lessons-journal', factLessons)
  .store(jsonl.memory('memory/fact-lessons.jsonl'))
  .recall(mostSpecific);

const editorCall = H.decision('editor-call', {
  verdict: z.enum(['accept', 'return']),
  notes: z.array(z.string()),
  actedOn: z.enum(['first', 'second', 'both', 'neither']),
});

const actedOnFirst = H.metric('acted-on-first')
  .of(editorCall)
  .hit((d) => d.actedOn === 'first' || d.actedOn === 'both');
const actedOnSecond = H.metric('acted-on-second')
  .of(editorCall)
  .hit((d) => d.actedOn === 'second' || d.actedOn === 'both');

const api = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');

const firstSlot = { name: 'reviewer-first' };
const secondSlot = { name: 'reviewer-second' };

function swapWeakerAfterFifty(
  name: string,
  own: { readonly name: string },
  ownMetric: Metric,
  other: { readonly name: string },
  otherMetric: Metric,
  incumbent: Model,
  challenger: Model,
) {
  return H.policy.model(name, [incumbent, challenger], (c) => {
    const mine = c.metrics.read(ownMetric, { agent: own, model: incumbent, window: 'all' });
    const theirs = c.metrics.read(otherMetric, { agent: other, window: 'all' });
    if (mine.n < 50 || theirs.n < 50 || mine.rate === null || theirs.rate === null) return incumbent;
    return mine.rate < theirs.rate ? challenger : incumbent;
  });
}

const reviewerFirst = H.agent(firstSlot.name, reviewer)
  .model(swapWeakerAfterFifty('first-reviewer-model', firstSlot, actedOnFirst, secondSlot, actedOnSecond, sonnet, haiku))
  .pool(api)
  .recalls([tasteJournal, lessonsJournal]);
const reviewerSecond = H.agent(secondSlot.name, reviewer)
  .model(swapWeakerAfterFifty('second-reviewer-model', secondSlot, actedOnSecond, firstSlot, actedOnFirst, opus, haiku))
  .pool(api)
  .recalls([tasteJournal, lessonsJournal]);

const factCheck = H.command('fact-check', ['node', 'tools/fact-check.mjs']).parses({
  issues: z.array(z.string()),
  repeats: z.array(z.object({ claim: z.string(), lesson: z.string() })),
});
const mergeCritiques = H.command('merge-critiques', ['node', 'tools/merge-critiques.mjs']).parses({
  summary: z.string(),
});

const twoReviewers = H.flow('two-reviewer-review')
  .requires({ title: z.string(), section: z.string(), content: z.string() })
  .step('factCheck', factCheck, (c) => ({ stdin: c.input.content }))
  .step('first', reviewerFirst, (c) => ({
    title: c.input.title,
    section: c.input.section,
    content: c.input.content,
    factIssues: c.out.factCheck.data.issues,
  }))
  .step('second', reviewerSecond, (c) => ({
    title: c.input.title,
    section: c.input.section,
    content: c.input.content,
    factIssues: c.out.factCheck.data.issues,
  }))
  .step('merge', mergeCritiques, (c) => ({ stdin: JSON.stringify({ first: c.out.first, second: c.out.second }) }))
  .halt('editor', editorCall, {
    ask: (c) => `Accept or return "${c.input.title}" (${c.input.section}).\n\n${c.out.merge.data.summary}`,
  })
  .ends(['accepted', 'returned'], (c) => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, (post, s) =>
      s.create({
        attributes: { postId: post.id, revision: post.modifiedAt, section: post.section },
        fields: { title: post.title, content: post.content },
      }),
    ),
  ])
  .store(wordpress.store(Draft, { ...cms, status: { WithEditor: 'pending', Accepted: 'publish', Returned: 'draft' } }))
  .runner(local.shell({ slots: 2 }))
  .wip(4)
  .handler(twoReviewers, {
    opens: Reviewing,
    blocked: Held,
    states: { factCheck: Reviewing, editor: WithEditor, accepted: Accepted, returned: Returned },
  });

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.transition(drafts, { to: [Returned] }))
  .records(tasteJournal, (e) =>
    (e.outputs.editor?.notes ?? []).map((note) => ({
      rule: note,
      because: `the editor returned post ${e.unit.attributes.postId} with this note`,
      when: { kinds: [Draft], roles: [reviewer], attributes: { section: e.unit.attributes.section } },
    })),
  );

const repeatMistakesBecomeLessons = H.trigger('repeat-mistakes-become-lessons', H.on.step(drafts, 'factCheck'))
  .records(lessonsJournal, (e) =>
    e.output.data.repeats.map((repeat) => ({
      rule: repeat.lesson,
      because: `the claim "${repeat.claim}" was wrong in an earlier draft`,
      when: { kinds: [Draft], roles: [reviewer] },
    })),
  );

const editorDesk = H.access('editor-desk').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const publication = H.harness('publication')
  .ledger(sqlite.ledger('state/publication.sqlite'))
  .lanes([drafts])
  .triggers([returnedNotesBecomeTaste, repeatMistakesBecomeLessons])
  .clients([claudeCode.supervisor('editor', editorDesk, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = publication.start();
