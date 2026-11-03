import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import type { PolicyContext } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as wordpress from 'harness-dsl/wordpress';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingEditor = H.state('AwaitingEditor', 'active');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'terminal', 'failure');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), revision: z.number(), section: z.string() })
  .fields({ title: z.string(), content: z.string() })
  .states([Queued, Reviewing, AwaitingEditor, Accepted, Returned])
  .key(u => `${u.attributes.postId}@${u.attributes.revision}`);

const editorTaste = H.memory.taste('editor-taste').curated();
const factChecking = H.memory.experience('fact-checking');

const mostSpecificFirst = H.policy.recall('most-specific-first', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const tasteJournal = H.journal('editor-taste', editorTaste)
  .store(jsonl.memory('memory/editor-taste.jsonl'))
  .recall(mostSpecificFirst);
const factJournal = H.journal('fact-checking', factChecking)
  .store(jsonl.memory('memory/fact-checking.jsonl'))
  .recall(mostSpecificFirst);

const editorVerdict = H.decision('editor-verdict', {
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.enum(['first', 'second', 'both', 'neither']),
});

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const contenders: readonly Model[] = [opus, sonnet, haiku];

const actedOnCritique = contenders.map(model => ({
  model,
  metric: H.metric(`editor-acted-on-${model.name}`)
    .of(editorVerdict)
    .hit((decision, fact) => {
      if (fact.attempt.models['critiqueFirst'] === model.name) {
        return decision.actedOn === 'first' || decision.actedOn === 'both';
      }
      if (fact.attempt.models['critiqueSecond'] === model.name) {
        return decision.actedOn === 'second' || decision.actedOn === 'both';
      }
      return null;
    }),
}));

const provenAfterSamples = 50;

function reviewerPair(c: PolicyContext): readonly [Model, Model] {
  const standings = actedOnCritique.map(entry => ({
    model: entry.model,
    standing: c.metrics.read(entry.metric, { kind: Draft, window: 'all' }),
  }));
  const proven = standings
    .filter(s => s.standing.n >= provenAfterSamples)
    .sort((a, b) => (b.standing.rate ?? 0) - (a.standing.rate ?? 0));
  const unproven = standings.filter(s => s.standing.n < provenAfterSamples);
  const ordered = [...proven.slice(0, 1), ...unproven, ...proven.slice(1)].map(s => s.model);
  return [ordered[0] ?? opus, ordered[1] ?? sonnet];
}

const firstReviewerModel = H.policy.model('first-reviewer-model', contenders, c => reviewerPair(c)[0]);
const secondReviewerModel = H.policy.model('second-reviewer-model', contenders, c => reviewerPair(c)[1]);

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft for accuracy, structure and voice. List concrete points the editor can act on.')
  .input({ title: z.string(), content: z.string(), section: z.string() })
  .output({ critique: z.string(), points: z.array(z.string()) });

const editorialApi = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const firstReviewer = H.agent('first-reviewer', reviewer)
  .model(firstReviewerModel)
  .pool(editorialApi)
  .recalls([tasteJournal, factJournal]);
const secondReviewer = H.agent('second-reviewer', reviewer)
  .model(secondReviewerModel)
  .pool(editorialApi)
  .recalls([tasteJournal, factJournal]);

const factCheck = H.command('fact-check', ['node', 'scripts/fact-check.js'])
  .parses({ repeats: z.array(z.object({ rule: z.string(), because: z.string() })) });
const mergeCritiques = H.command('merge-critiques', ['node', 'scripts/merge-critiques.js'])
  .parses({ merged: z.string() });

const reviewFlow = H.flow('draft-review')
  .requires({ postId: z.number(), section: z.string(), title: z.string(), content: z.string() })
  .step('factCheck', factCheck, c => ({ stdin: c.input.content }))
  .step('critiqueFirst', firstReviewer, c => ({ title: c.input.title, content: c.input.content, section: c.input.section }))
  .step('critiqueSecond', secondReviewer, c => ({ title: c.input.title, content: c.input.content, section: c.input.section }))
  .step('merge', mergeCritiques, c => ({
    stdin: JSON.stringify({ first: c.out.critiqueFirst, second: c.out.critiqueSecond, facts: c.out.factCheck.data }),
  }))
  .mark('awaitingEditor')
  .halt('editor', editorVerdict, {
    ask: c => `Accept or return "${c.input.title}" (${c.input.section})?\n\n${c.out.merge.data.merged}`,
  })
  .ends(['accepted', 'returned'], c => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, post => ({
      create: {
        attributes: { postId: post.id, revision: post.modifiedAt, section: post.section },
        fields: { title: post.title, content: post.content },
      },
    })),
  ])
  .store(wordpress.store(Draft, {
    ...cms,
    status: { Reviewing: 'pending', AwaitingEditor: 'pending', Accepted: 'ready-to-publish', Returned: 'draft' },
  }))
  .runner(local.shell({ slots: 2 }))
  .handler(reviewFlow, {
    outcomes: { accepted: Accepted, returned: Returned },
    progress: { awaitingEditor: AwaitingEditor },
  });

const tasteFromReturnedNotes = H.trigger('taste-from-returned-notes', H.on.transition(drafts, { to: [Returned] }))
  .records(tasteJournal, e =>
    (e.outputs.editor?.notes ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(note => ({
        rule: note,
        because: `the editor returned ${e.unit.attributes.section} draft ${e.unit.attributes.postId} with this note`,
        when: { kinds: [Draft], attributes: { section: e.unit.attributes.section } },
      })),
  );

const experienceFromFactCheck = H.trigger('experience-from-fact-check', H.on.step(drafts, 'factCheck'))
  .where(e => e.output.data.repeats.length > 0)
  .records(factJournal, e =>
    e.output.data.repeats.map(repeat => ({ rule: repeat.rule, because: repeat.because, when: { kinds: [Draft] } })),
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
  .ledger(sqlite.ledger('.harness/content-review.db'))
  .lanes([drafts])
  .triggers([tasteFromReturnedNotes, experienceFromFactCheck])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('content-review-control', harness)
  .clients([claudeCode.supervisor('editor-desk', editorAccess, { port: H.slot.port(0) })]);

export async function main(): Promise<void> {
  await harness.start();
  await control.serve();
}
