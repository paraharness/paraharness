import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric, Model } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as wordpress from 'harness-dsl/wordpress';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const Submitted = H.state.pending('Submitted');
const InReview = H.state.active('InReview');
const Accepted = H.state.terminal('Accepted', 'success');
const Returned = H.state.terminal('Returned', 'neutral');
const ReviewFailed = H.state.terminal('ReviewFailed', 'failure');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), section: z.string() })
  .fields({ title: z.string(), content: z.string() })
  .states([Submitted, InReview, Accepted, Returned, ReviewFailed])
  .key(draft => String(draft.attributes.postId));

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft against the house taste and the fact-checking lessons. Quote the passages you mean.')
  .input({ title: z.string(), draft: z.string(), section: z.string() })
  .output({ critique: z.string(), issues: z.array(z.string()) });

const editorialTaste = H.memory.taste('editorial-taste').curated();
const factCheckingLessons = H.memory.experience('fact-checking-lessons');

const sectionScoped = H.policy.recall('section-scoped', c => {
  const section = c.unit === null ? null : c.unit.attributes['section'];
  return c.candidates
    .filter(candidate => candidate.item.status === 'accepted')
    .filter(candidate => !('section' in candidate.item.when.attributes) || candidate.item.when.attributes['section'] === section)
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit);
});

const tasteJournal = H.journal('editorial-taste-journal', editorialTaste)
  .store(jsonl.memory('memory/editorial-taste.jsonl'))
  .recall(sectionScoped);
const factJournal = H.journal('fact-checking-journal', factCheckingLessons)
  .store(jsonl.memory('memory/fact-checking.jsonl'))
  .recall(sectionScoped);

const editorialApi = anthropic.account('editorial-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');

const swapAfterSamples = 50;
const scoreWindow = { days: 60 };

function reviewerPair(read: (metric: Metric) => { readonly rate: number | null; readonly n: number }): readonly [Model, Model] {
  const first = { model: opusScore.model, ...read(opusScore.metric) };
  const second = { model: sonnetScore.model, ...read(sonnetScore.metric) };
  const challenger = { model: haikuScore.model, ...read(haikuScore.metric) };
  const strength = (score: { readonly rate: number | null }) => score.rate ?? 0;
  if (challenger.n < swapAfterSamples) {
    if (first.n < swapAfterSamples || second.n < swapAfterSamples) return [first.model, second.model];
    return strength(first) >= strength(second) ? [first.model, challenger.model] : [challenger.model, second.model];
  }
  const ranked = [first, second, challenger].sort((a, b) => strength(b) - strength(a));
  return [ranked[0].model, ranked[1].model];
}

const firstReviewerModel = H.policy.model('first-reviewer-model', [opus, sonnet, haiku], c =>
  reviewerPair(metric => c.metrics.read(metric, { kind: Draft, window: scoreWindow }))[0],
);
const secondReviewerModel = H.policy.model('second-reviewer-model', [opus, sonnet, haiku], c =>
  reviewerPair(metric => c.metrics.read(metric, { kind: Draft, window: scoreWindow }))[1],
);

const firstCritic = H.agent('first-critic', reviewer)
  .model(firstReviewerModel)
  .pool(editorialApi)
  .recalls([tasteJournal, factJournal]);
const secondCritic = H.agent('second-critic', reviewer)
  .model(secondReviewerModel)
  .pool(editorialApi)
  .recalls([tasteJournal, factJournal]);

const factCheck = H.command('fact-check', ['./bin/fact-check', '--report-repeats']).parses({
  repeats: z.array(z.object({ rule: z.string(), because: z.string() })),
});
const mergeCritiques = H.command('merge-critiques', ['./bin/merge-critiques']).parses({ summary: z.string() });

const reviewFlow = H.flow('dual-review')
  .requires({ title: z.string(), content: z.string(), section: z.string() })
  .mark('reviewing')
  .step('factCheck', factCheck, c => ({ stdin: c.input.content }), { onRestart: 'rerun' })
  .step('critiqueFirst', firstCritic, c => ({ title: c.input.title, draft: c.input.content, section: c.input.section }), { onRestart: 'reconcile' })
  .step('critiqueSecond', secondCritic, c => ({ title: c.input.title, draft: c.input.content, section: c.input.section }), { onRestart: 'reconcile' })
  .step('merge', mergeCritiques, c => ({
    stdin: JSON.stringify({ first: c.out.critiqueFirst, second: c.out.critiqueSecond, repeats: c.out.factCheck.data.repeats }),
  }), { onRestart: 'rerun' })
  .halt('editor', {
    ask: c => `Accept or return "${c.input.title}"?\n\n${c.out.merge.data.summary}`,
    decision: {
      verdict: z.enum(['accept', 'return']),
      actedOn: z.enum(['first', 'second', 'both', 'neither']),
      notes: z.string(),
    },
  })
  .ends(['accepted', 'returned'], c => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const critiqueActedOn = (model: Model) =>
  H.metric(`critique-acted-on-${model.name}`)
    .step(reviewFlow, 'editor')
    .hit((decision, event) => {
      const wroteFirst = event.attempt.models['critiqueFirst'] === model.name;
      const wroteSecond = event.attempt.models['critiqueSecond'] === model.name;
      if (!wroteFirst && !wroteSecond) return null;
      const both = decision.actedOn === 'both';
      return (wroteFirst && (both || decision.actedOn === 'first')) || (wroteSecond && (both || decision.actedOn === 'second'));
    });

const opusScore = { model: opus, metric: critiqueActedOn(opus) };
const sonnetScore = { model: sonnet, metric: critiqueActedOn(sonnet) };
const haikuScore = { model: haiku, metric: critiqueActedOn(haiku) };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, post => ({
      create: {
        attributes: { postId: post.id, section: post.section },
        fields: { title: post.title, content: post.content },
      },
    })),
  ])
  .store(wordpress.store(Draft, {
    ...cms,
    status: { Submitted: 'pending', InReview: 'pending', Accepted: 'publish', Returned: 'draft', ReviewFailed: 'pending' },
  }))
  .runner(local.shell({ slots: 2 }))
  .handler(reviewFlow, {
    states: { reviewing: InReview, accepted: Accepted, returned: Returned, failed: ReviewFailed },
  });

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.transition(drafts, { to: [Returned] }))
  .records(tasteJournal, event => {
    const notes = event.outputs.editor === undefined ? '' : event.outputs.editor.notes;
    return notes
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => ({
        rule: line,
        because: `the editor returned post ${event.unit.attributes.postId} with this note`,
        when: { kinds: [Draft], roles: [reviewer], attributes: { section: event.unit.attributes.section } },
      }));
  });

const repeatMistakesBecomeLessons = H.trigger('repeat-mistakes-become-lessons', H.on.step(drafts, 'factCheck'))
  .where(event => event.status === 'succeeded' && event.output.data.repeats.length > 0)
  .records(factJournal, event =>
    event.output.data.repeats.map(repeat => ({
      rule: repeat.rule,
      because: repeat.because,
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

const oldestFirst = H.policy.schedule('oldest-first', c => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content-review.sqlite'))
  .lanes([drafts])
  .triggers([returnedNotesBecomeTaste, repeatMistakesBecomeLessons])
  .schedule(oldestFirst)
  .clients([claudeCode.supervisor('editor', editorDesk, { port: H.slot.port(0) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
