import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PolicyContext } from 'harness-dsl/kernel';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as wordpress from 'harness-dsl/wordpress';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const cms = { site: 'https://news.example.com', token: H.env('WORDPRESS_TOKEN') };

const Queued = H.state('Queued', 'pending');
const Reviewing = H.state('Reviewing', 'active');
const Accepted = H.state('Accepted', 'terminal', 'success');
const Returned = H.state('Returned', 'waiting');

const Draft = H.work('Draft')
  .attributes({ postId: z.number(), section: z.string() })
  .fields({ title: z.string(), content: z.string() })
  .states([Queued, Reviewing, Accepted, Returned])
  .events({ revised: { modifiedAt: z.number() } })
  .key(u => String(u.attributes.postId));

const editorialTaste = H.memory.taste('editorial-taste').curated();
const factChecking = H.memory.experience('fact-checking');

const specificFirst = H.policy.recall('specific-first', c =>
  [...c.candidates]
    .sort((x, y) => y.specificity - x.specificity || y.track.succeeded - x.track.succeeded)
    .slice(0, c.limit));

const tasteJournal = H.journal('editorial-taste-journal', editorialTaste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificFirst);
const factJournal = H.journal('fact-checking-journal', factChecking)
  .store(jsonl.memory('memory/fact-checking.jsonl'))
  .recall(specificFirst);

const editorVerdict = H.decision('editor-verdict', {
  verdict: z.enum(['accept', 'return']),
  actedOn: z.enum(['a', 'b', 'both', 'none']),
  notes: z.array(z.object({ rule: z.string(), because: z.string(), sectionOnly: z.boolean() })),
});

const actedOnA = H.metric('editor-acted-on-reviewer-a').of(editorVerdict).hit(d => d.actedOn === 'a' || d.actedOn === 'both');
const actedOnB = H.metric('editor-acted-on-reviewer-b').of(editorVerdict).hit(d => d.actedOn === 'b' || d.actedOn === 'both');

function weakerReviewer(c: PolicyContext): 'a' | 'b' | null {
  const a = c.metrics.read(actedOnA, { window: { days: 30 } });
  const b = c.metrics.read(actedOnB, { window: { days: 30 } });
  if (a.n < 50 || b.n < 50 || a.rate === null || b.rate === null) return null;
  if (a.rate < b.rate) return 'a';
  if (b.rate < a.rate) return 'b';
  return null;
}

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-opus-4-5');

const reviewerAModel = H.policy.model('reviewer-a-model', [opus, challenger], c => (weakerReviewer(c) === 'a' ? challenger : opus));
const reviewerBModel = H.policy.model('reviewer-b-model', [sonnet, challenger], c => (weakerReviewer(c) === 'b' ? challenger : sonnet));

const apiAccount = anthropic.account('publication-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const reviewer = H.role('reviewer')
  .intents(['read'])
  .instructions('Critique the draft for argument, accuracy and house style.')
  .input({ title: z.string(), section: z.string(), content: z.string(), factNotes: z.string() })
  .output({ critique: z.string(), points: z.array(z.string()) });

const reviewerA = H.agent('reviewer-a', reviewer).model(reviewerAModel).pool(apiAccount).recalls([tasteJournal, factJournal]);
const reviewerB = H.agent('reviewer-b', reviewer).model(reviewerBModel).pool(apiAccount).recalls([tasteJournal, factJournal]);

const factCheck = H.command('fact-check', ['scripts/fact-check.sh']).parses({
  notes: z.string(),
  repeats: z.array(z.object({ rule: z.string(), because: z.string() })),
});
const mergeCritiques = H.command('merge-critiques', ['scripts/merge-critiques.sh']).parses({ merged: z.string() });

const review = H.flow('review-draft')
  .requires({ title: z.string(), section: z.string(), content: z.string() })
  .step('factCheck', factCheck, c => ({ stdin: c.input.content }))
  .step('critiqueA', reviewerA, c => ({ title: c.input.title, section: c.input.section, content: c.input.content, factNotes: c.out.factCheck.data.notes }))
  .step('critiqueB', reviewerB, c => ({ title: c.input.title, section: c.input.section, content: c.input.content, factNotes: c.out.factCheck.data.notes }))
  .step('merged', mergeCritiques, c => ({ stdin: JSON.stringify({ a: c.out.critiqueA, b: c.out.critiqueB }) }))
  .halt('editor', editorVerdict, { ask: c => `${c.input.title} (${c.input.section})\n\n${c.out.merged.data.merged}` })
  .ends(['accepted', 'returned'], c => (c.out.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const drafts = H.lane('drafts', Draft)
  .supply([
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'pending' }, (post, supply) =>
      supply.create({ attributes: { postId: post.id, section: post.section }, fields: { title: post.title, content: post.content } })),
    wordpress.poll(Draft, H.time.every({ minutes: 10 }), { ...cms, status: 'revised' }, (post, supply) =>
      supply.event(String(post.id), 'revised', { modifiedAt: post.modifiedAt })),
  ])
  .store(wordpress.store(Draft, { ...cms, status: { Queued: 'pending', Reviewing: 'in-review', Accepted: 'publish', Returned: 'draft' } }))
  .runner(local.shell({ slots: 2 }))
  .handler(review, { states: { accepted: Accepted, returned: Returned }, opens: Reviewing })
  .reacts({ revised: H.reaction(Queued).from([Returned]) });

const tasteFromReturns = H.trigger('taste-from-returned-drafts', H.on.transition(drafts, { to: [Returned] }))
  .records(tasteJournal, e =>
    (e.outputs.editor ? e.outputs.editor.notes : []).map(note => ({
      rule: note.rule,
      because: note.because,
      when: note.sectionOnly
        ? { kinds: [Draft], roles: [reviewer], attributes: { section: e.unit.attributes.section } }
        : { kinds: [Draft], roles: [reviewer] },
    })));

const experienceFromFactCheck = H.trigger('experience-from-repeat-mistakes', H.on.step(drafts, 'factCheck'))
  .where(e => e.output.data.repeats.length > 0)
  .records(factJournal, e =>
    e.output.data.repeats.map(repeat => ({ rule: repeat.rule, because: repeat.because, when: { kinds: [Draft], roles: [reviewer] } })));

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
  .triggers([tasteFromReturns, experienceFromFactCheck])
  .schedule(H.policy.schedule('oldest-first', c => ({ start: c.order(x => x.enqueuedAt) })))
  .clients([claudeCode.supervisor('editor-desk', editorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
