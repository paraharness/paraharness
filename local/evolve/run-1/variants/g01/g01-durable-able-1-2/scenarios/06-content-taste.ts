import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as wordpress from 'harness-dsl/wordpress';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const InReview = H.state('InReview', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'terminal', 'neutral');
const Unreviewed = H.state('Unreviewed', 'terminal', 'failure');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), section: z.string(), revision: z.number() })
  .fields({ title: z.string(), content: z.string(), author: z.string() })
  .states([InReview, Reviewing, Accepted, Returned, Unreviewed])
  .key(u => `${u.attributes.postId}@${u.attributes.revision}`);

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft against the publication taste you are given. Name concrete changes, most important first.')
  .input({ title: z.string(), content: z.string(), section: z.string(), factIssues: z.array(z.string()) })
  .output({ critique: z.string(), changes: z.array(z.string()) });

const specificFirst = H.policy.recall('specificFirst', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

const editorTaste = H.memory.taste('editorTaste').curated();
const factCheckLessons = H.memory.experience('factCheckLessons');

const tasteJournal = H.journal('editorTasteJournal', editorTaste)
  .store(jsonl.memory('memory/editor-taste.jsonl'))
  .recall(specificFirst);
const lessonsJournal = H.journal('factCheckLessonsJournal', factCheckLessons)
  .store(jsonl.memory('memory/fact-check-lessons.jsonl'))
  .recall(specificFirst);

const editorVerdict = H.decision('editorVerdict', {
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['first', 'second'])),
});

const actedOnFirst = H.metric('actedOnFirstCritique').of(editorVerdict).hit(d => d.actedOn.includes('first'));
const actedOnSecond = H.metric('actedOnSecondCritique').of(editorVerdict).hit(d => d.actedOn.includes('second'));

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');
const publicationAccount = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const comparisonWindow = { days: 60 };
const samplesBeforeSwap = 50;

const firstReviewerModel = H.policy.model('firstReviewerModel', [opus, challenger], c => {
  const mine = c.metrics.read(actedOnFirst, { window: comparisonWindow });
  const theirs = c.metrics.read(actedOnSecond, { window: comparisonWindow });
  if (mine.n < samplesBeforeSwap || mine.rate === null || theirs.rate === null) return opus;
  return mine.rate < theirs.rate ? challenger : opus;
});

const secondReviewerModel = H.policy.model('secondReviewerModel', [sonnet, challenger], c => {
  const mine = c.metrics.read(actedOnSecond, { window: comparisonWindow });
  const theirs = c.metrics.read(actedOnFirst, { window: comparisonWindow });
  if (mine.n < samplesBeforeSwap || mine.rate === null || theirs.rate === null) return sonnet;
  return mine.rate < theirs.rate ? challenger : sonnet;
});

const firstReviewer = H.agent('firstReviewer', reviewer)
  .model(firstReviewerModel)
  .pool(publicationAccount)
  .recalls([tasteJournal, lessonsJournal]);

const secondReviewer = H.agent('secondReviewer', reviewer)
  .model(secondReviewerModel)
  .pool(publicationAccount)
  .recalls([tasteJournal, lessonsJournal]);

const factCheck = H.command('factCheck', ['bin/fact-check', '--json']).parses({
  issues: z.array(z.string()),
  repeats: z.array(z.object({ claim: z.string(), lesson: z.string(), source: z.string() })),
});

const mergeCritiques = H.command('mergeCritiques', ['bin/merge-critiques', '--json']).parses({
  summary: z.string(),
  changes: z.array(z.string()),
});

const reviewFlow = H.flow('draftReview')
  .requires({ title: z.string(), content: z.string(), section: z.string() })
  .step('factCheck', factCheck, c => ({ stdin: c.input.content }), { retry: H.retry.fixed({ maxRetries: 2, delayMs: 30000 }) })
  .step('firstCritique', firstReviewer, c => ({
    title: c.input.title,
    content: c.input.content,
    section: c.input.section,
    factIssues: c.out.factCheck.data.issues,
  }))
  .step('secondCritique', secondReviewer, c => ({
    title: c.input.title,
    content: c.input.content,
    section: c.input.section,
    factIssues: c.out.factCheck.data.issues,
  }))
  .step('merged', mergeCritiques, c => ({
    stdin: JSON.stringify({ first: c.out.firstCritique, second: c.out.secondCritique }),
  }))
  .halt('editor', editorVerdict, {
    ask: c => `"${c.input.title}" (${c.input.section})\n\n${c.out.merged.data.summary}\n\n- ${c.out.merged.data.changes.join('\n- ')}`,
  })
  .ends(['accepted', 'returned'], c => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, post => ({
      create: {
        attributes: { postId: post.id, section: post.section, revision: post.modifiedAt },
        fields: { title: post.title, content: post.content, author: post.author },
      },
    })),
  ])
  .store(wordpress.store(Draft, {
    ...cms,
    status: { InReview: 'pending', Reviewing: 'pending', Accepted: 'publish', Returned: 'draft', Unreviewed: 'pending' },
  }))
  .runner(local.shell({ slots: 2 }))
  .wip(3)
  .handler(reviewFlow, { states: { accepted: Accepted, returned: Returned, failed: Unreviewed } });

const tasteFromReturnedDrafts = H.trigger('tasteFromReturnedDrafts', H.on.transition(drafts, { to: [Returned] }))
  .records(tasteJournal, e =>
    (e.outputs.editor?.notes ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => ({
        rule: line,
        because: `the editor returned draft ${e.unit.key} with this note`,
        when: { kinds: [Draft], roles: [reviewer], attributes: { section: e.unit.attributes.section } },
      })));

const lessonsFromRepeatMistakes = H.trigger('lessonsFromRepeatMistakes', H.on.step(drafts, 'factCheck'))
  .where(e => e.status === 'succeeded' && e.output.data.repeats.length > 0)
  .records(lessonsJournal, e =>
    e.output.data.repeats.map(repeat => ({
      rule: `when a draft claims "${repeat.claim}", ${repeat.lesson}`,
      because: `the fact check found this mistake again (source: ${repeat.source})`,
      when: { kinds: [Draft], roles: [reviewer] },
    })));

const oldestFirst = H.policy.schedule('oldestFirst', c => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

const editorDesk = H.access('editorDesk').allows([
  H.ops.readWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content-review.sqlite'))
  .lanes([drafts])
  .triggers([tasteFromReturnedDrafts, lessonsFromRepeatMistakes])
  .schedule(oldestFirst)
  .clients([claudeCode.supervisor('editor', editorDesk, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
