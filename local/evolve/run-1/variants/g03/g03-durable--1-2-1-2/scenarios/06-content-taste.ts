import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as wordpress from 'harness-dsl/wordpress';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Queued = H.state('queued', 'pending');
const Reviewing = H.state('reviewing', 'active');
const AwaitingEditor = H.state('awaitingEditor', 'waiting');
const Published = H.state('published', 'terminal', 'success');
const Returned = H.state('returned', 'terminal', 'neutral');
const Stalled = H.state('stalled', 'terminal', 'failure');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), revision: z.number(), title: z.string(), section: z.string() })
  .fields({ content: z.string() })
  .states([Queued, Reviewing, AwaitingEditor, Published, Returned, Stalled])
  .key(unit => `${unit.attributes.postId}:${unit.attributes.revision}`);

const EditorTaste = H.memory.taste('editorTaste').curated();
const FactCheckLessons = H.memory.experience('factCheckLessons');

const bySpecificityThenTrack = H.policy.recall('bySpecificityThenTrack', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const taste = H.journal('editorTaste', EditorTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(bySpecificityThenTrack);
const factLessons = H.journal('factCheckLessons', FactCheckLessons)
  .store(jsonl.memory('memory/fact-check.jsonl'))
  .recall(bySpecificityThenTrack);

const editorVerdict = H.decision('editorVerdict', {
  accepted: z.boolean(),
  actedOn: z.enum(['first', 'second', 'both', 'neither']),
  notes: z.array(z.object({ rule: z.string(), because: z.string(), sectionOnly: z.boolean() })),
});

const firstActedOn = H.metric('firstCritiqueActedOn')
  .of(editorVerdict)
  .hit(verdict => verdict.actedOn === 'first' || verdict.actedOn === 'both');
const secondActedOn = H.metric('secondCritiqueActedOn')
  .of(editorVerdict)
  .hit(verdict => verdict.actedOn === 'second' || verdict.actedOn === 'both');

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');
const apiAccount = anthropic.account('publication', { apiKey: H.env('ANTHROPIC_API_KEY') });

const abWindow = { days: 60 };
const swapAfterSamples = 50;

const firstReviewerModel = H.policy.model('firstReviewerModel', [opus, challenger], c => {
  const mine = c.metrics.read(firstActedOn, { kind: Draft, model: opus, window: abWindow });
  const theirs = c.metrics.read(secondActedOn, { kind: Draft, model: sonnet, window: abWindow });
  const weaker = mine.n >= swapAfterSamples && theirs.n >= swapAfterSamples && (mine.rate ?? 0) < (theirs.rate ?? 0);
  return weaker ? challenger : opus;
});
const secondReviewerModel = H.policy.model('secondReviewerModel', [sonnet, challenger], c => {
  const mine = c.metrics.read(secondActedOn, { kind: Draft, model: sonnet, window: abWindow });
  const theirs = c.metrics.read(firstActedOn, { kind: Draft, model: opus, window: abWindow });
  const weaker = mine.n >= swapAfterSamples && theirs.n >= swapAfterSamples && (mine.rate ?? 0) < (theirs.rate ?? 0);
  return weaker ? challenger : sonnet;
});

const reviewerRole = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft for argument, clarity, accuracy and house style. Cite paragraphs.')
  .input({ title: z.string(), section: z.string(), content: z.string() })
  .output({ critique: z.string(), factClaims: z.array(z.string()) });

const firstReviewer = H.agent('firstReviewer', reviewerRole)
  .model(firstReviewerModel)
  .pool(apiAccount)
  .recalls([taste, factLessons]);
const secondReviewer = H.agent('secondReviewer', reviewerRole)
  .model(secondReviewerModel)
  .pool(apiAccount)
  .recalls([taste, factLessons]);

const mergeCritiques = H.command('mergeCritiques', ['./bin/merge-critiques']).parses({ merged: z.string() });
const factCheck = H.command('factCheck', ['./bin/fact-check']).parses({
  repeats: z.array(z.object({ rule: z.string(), because: z.string() })),
});

const reviewFlow = H.flow('reviewDraft')
  .requires({ title: z.string(), section: z.string(), content: z.string() })
  .step('critiqueFirst', firstReviewer, c => ({ title: c.input.title, section: c.input.section, content: c.input.content }))
  .step('critiqueSecond', secondReviewer, c => ({ title: c.input.title, section: c.input.section, content: c.input.content }))
  .step('merge', mergeCritiques, c => ({
    stdin: JSON.stringify({ first: c.out.critiqueFirst.critique, second: c.out.critiqueSecond.critique }),
  }))
  .step('factCheck', factCheck, c => ({
    stdin: JSON.stringify([...c.out.critiqueFirst.factClaims, ...c.out.critiqueSecond.factClaims]),
  }))
  .halt('editorReview', editorVerdict, {
    ask: c => `"${c.input.title}" (${c.input.section}). Merged critique:\n${c.out.merge.data.merged}`,
  })
  .ends(['accepted', 'returned'], c => (c.out.editorReview.accepted ? 'accepted' : 'returned'));

const cms = { site: 'https://magazine.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, (post, supply) =>
      supply.create({
        attributes: { postId: post.id, revision: post.modifiedAt, title: post.title, section: post.section },
        fields: { content: post.content },
      }),
    ),
  ])
  .store(wordpress.store(Draft, { ...cms, status: { published: 'publish', returned: 'draft', awaitingEditor: 'pending' } }))
  .runner(local.shell({ slots: 2 }))
  .handler(reviewFlow, {
    opens: Reviewing,
    halts: { editorReview: AwaitingEditor },
    ends: { accepted: Published, returned: Returned },
  })
  .retry(H.retry.exponential({ maxRetries: 3, initialDelayMs: 60_000 }), { exhausted: Stalled });

const notesBecomeTaste = H.trigger('returnedNotesBecomeTaste', H.on.transition(drafts, { to: [Returned] }))
  .records(taste, event => {
    const review = event.outputs.editorReview;
    if (review === undefined) return [];
    return review.notes.map(note => ({
      rule: note.rule,
      because: note.because,
      when: note.sectionOnly
        ? { kinds: [Draft], roles: [reviewerRole], attributes: { section: event.unit.attributes.section } }
        : { kinds: [Draft], roles: [reviewerRole] },
    }));
  });

const repeatMistakesBecomeExperience = H.trigger('repeatMistakesBecomeExperience', H.on.step(drafts, 'factCheck'))
  .where(event => event.status === 'succeeded')
  .records(factLessons, event =>
    event.output.data.repeats.map(repeat => ({
      rule: repeat.rule,
      because: repeat.because,
      when: { kinds: [Draft], roles: [reviewerRole] },
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

const oldestFirst = H.policy.schedule('oldestFirst', c => ({ start: c.order(candidate => candidate.enqueuedAt) }));

const harness = H.harness('contentReview')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([drafts])
  .triggers([notesBecomeTaste, repeatMistakesBecomeExperience])
  .schedule(oldestFirst)
  .clients([claudeCode.supervisor('editor', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

void harness.start();
