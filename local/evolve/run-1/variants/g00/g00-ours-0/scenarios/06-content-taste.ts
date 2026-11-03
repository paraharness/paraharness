import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, ChooseContext } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { ghost } from 'harness-dsl/ghost';
import type { GhostPost } from 'harness-dsl/ghost';
import { byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { local } from 'harness-dsl/local';

const draft = z.object({
  postId: z.string(),
  title: z.string(),
  html: z.string(),
  section: z.string(),
  editorNotes: z.string().optional(),
});
type DraftData = z.infer<typeof draft>;

const Submitted = H.state('submitted').pending();
const InReview = H.state('in-review').active();
const AwaitingEditor = H.state('awaiting-editor').active();
const Returned = H.state('returned').active();
const Accepted = H.state('accepted').succeeded();
const ReviewFailed = H.state('review-failed').failed();

const Draft = H.work('draft')
  .schema(draft)
  .states(Submitted, InReview, AwaitingEditor, Returned, Accepted, ReviewFailed)
  .resources(post => [post.section]);

const Taste = H.memory('editorial-taste').content(z.object({ rule: z.string(), because: z.string() }));
const FactCheckLesson = H.memory('fact-check-lesson').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);

const tasteJournal = H.journal('editorial-taste')
  .of(Taste)
  .store(jsonl.store('.harness/editorial-taste.jsonl'))
  .recall(byApplicability({ budgetTokens: 1500 }));
const factJournal = H.journal('fact-check-lessons')
  .of(FactCheckLesson)
  .store(jsonl.store('.harness/fact-check-lessons.jsonl'))
  .recall(byApplicability({ budgetTokens: 800 }));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('opus', apiAccount, 'claude-opus-4-1');
const sonnet = H.model('sonnet', apiAccount, 'claude-sonnet-4-5');
const haiku = H.model('haiku', apiAccount, 'claude-haiku-4-5');

function reviewerModelOrder(ctx: ChooseContext): readonly Candidate[] {
  const proven = ctx.candidates
    .map(candidate => ({
      candidate,
      stats: ctx.metrics.rate(critiqueActedOn, { key: `model:${candidate.name}`, window: '90d' }),
    }))
    .filter(entry => entry.stats.samples >= 50);
  const weakest =
    proven.length >= 2
      ? [...proven].sort((a, b) => (a.stats.rate ?? 0) - (b.stats.rate ?? 0))[0]
      : undefined;
  const ranked =
    weakest === undefined
      ? [...ctx.candidates]
      : [...ctx.candidates.filter(c => c !== weakest.candidate), weakest.candidate];
  return ctx.agent === reviewerB.name
    ? [...ranked.slice(1, 2), ...ranked.slice(0, 1), ...ranked.slice(2)]
    : ranked;
}

const reviewerModels = H.pool('reviewer-models', [opus, sonnet, haiku]).policy(
  H.policy.choose('swap-weaker-reviewer-after-50', reviewerModelOrder),
);

const reviewerRole = H.role('reviewer')
  .prompt('Critique the draft against house taste and factual accuracy. List concrete, actionable points.')
  .recall(Taste, FactCheckLesson);

const reviewerA = H.agent('reviewer-a').role(reviewerRole).model(reviewerModels);
const reviewerB = H.agent('reviewer-b').role(reviewerRole).model(reviewerModels);

const critiqueOutput = z.object({ points: z.array(z.string()) });
const critique = H.skill('critique')
  .input(z.object({ title: z.string(), html: z.string(), section: z.string() }))
  .output(critiqueOutput)
  .prompt(post => `Section: ${post.section}\nTitle: ${post.title}\n\n${post.html}`);

const localRunner = H.runner('local', local()).slots(4);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critiqueOutput, b: critiqueOutput }))
  .output(z.object({ merged: z.string() }))
  .run(async ({ input }) => {
    const points = [...input.a.points, ...input.b.points];
    const unique = points.filter((point, index) => points.indexOf(point) === index);
    return { merged: unique.map(point => `- ${point}`).join('\n') };
  });

const factCheckReport = z.object({
  findings: z.array(z.object({ claim: z.string(), repeat: z.boolean(), lesson: z.string() })),
});

const factCheck = H.command('fact-check')
  .input(z.object({ html: z.string(), critique: z.string() }))
  .output(z.object({ critique: z.string() }))
  .runner(localRunner)
  .run(async ({ input, exec, record }) => {
    const result = await exec('fact-check --format json', { stdin: input.html });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    const report = factCheckReport.parse(JSON.parse(result.stdout));
    for (const finding of report.findings.filter(f => f.repeat)) {
      await record(factJournal, {
        content: {
          do: finding.lesson,
          when: `a draft claims "${finding.claim}"`,
          because: 'the fact-check found this mistake in an earlier draft too',
        },
        when: { kinds: [Draft] },
      });
    }
    const facts = report.findings.map(f => `- fact: ${f.claim}`).join('\n');
    return { critique: `${input.critique}\n${facts}` };
  });

const EditorDecision = H.blocker('editor-decision').resolution(
  z.object({
    decision: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.array(z.string()),
  }),
);

const reviewFlow = H.flow('review')
  .for(Draft)
  .transition(InReview)
  .parallel('critiques', {
    a: branch =>
      branch.step('critique-a', critique.by(reviewerA), {
        input: (_, ctx) => ({ title: ctx.unit.data.title, html: ctx.unit.data.html, section: ctx.unit.data.section }),
      }),
    b: branch =>
      branch.step('critique-b', critique.by(reviewerB), {
        input: (_, ctx) => ({ title: ctx.unit.data.title, html: ctx.unit.data.html, section: ctx.unit.data.section }),
      }),
  })
  .step('merge', mergeCritiques)
  .step('fact-check', factCheck, {
    input: (merged, ctx) => ({ html: ctx.unit.data.html, critique: merged.merged }),
  })
  .transition(AwaitingEditor)
  .halt(EditorDecision, checked => checked.critique)
  .patch(decided => ({ editorNotes: decided.resolution.notes }))
  .transition(decided => (decided.resolution.decision === 'accept' ? Accepted : Returned))
  .onError(ReviewFailed);

const cmsKey = H.env('GHOST_ADMIN_KEY');
const fromPost = (post: GhostPost): DraftData => ({
  postId: post.id,
  title: post.title,
  html: post.html,
  section: post.primaryTag ?? 'general',
});

const drafts = H.lane('drafts')
  .of(Draft)
  .from(
    ghost.poll<DraftData>({
      url: 'https://cms.example.com',
      adminKey: cmsKey,
      every: '10m',
      map: post => (post.status === 'draft' ? fromPost(post) : null),
    }),
  )
  .store(
    ghost.store<DraftData>({
      url: 'https://cms.example.com',
      adminKey: cmsKey,
      map: fromPost,
      states: {
        submitted: 'draft',
        'in-review': 'draft',
        'awaiting-editor': 'draft',
        returned: 'draft',
        accepted: 'scheduled',
        'review-failed': 'draft',
      },
    }),
  )
  .handle(reviewFlow);

const critiqueActedOn = H.metric('critique-acted-on')
  .over(drafts.resolved(EditorDecision))
  .sample(decided =>
    [reviewerA.name, reviewerB.name].map(agent => ({
      key: `model:${decided.attempt.models[agent] ?? 'unknown'}`,
      hit: decided.resolution.actedOn.includes(agent),
    })),
  );

const returnedNotesBecomeTasteCandidates = H.trigger('returned-notes-become-taste-candidates')
  .on(drafts.enters(Returned))
  .record(
    tasteJournal,
    returned => ({
      content: {
        rule: returned.unit.data.editorNotes ?? '',
        because: `the editor returned "${returned.unit.data.title}" with this note`,
      },
      when: { kinds: [Draft], resources: [returned.unit.data.section] },
    }),
    { candidate: true },
  );

const revisedDraftReturnsToReview = H.trigger('revised-draft-returns-to-review')
  .on(
    drafts
      .updated()
      .where(change => change.unit.state.name === Returned.name && change.unit.data.html !== change.previous.data.html),
  )
  .transition(Submitted);

const scheduler = H.scheduler('review')
  .concurrency(3)
  .policy(
    H.policy.schedule('oldest-first', ctx => ({
      start: [...ctx.pending].sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime()),
    })),
  );

const supervisor = H.supervisor('editor')
  .client(claudeCode.client({ port: 7460 }))
  .grant(
    H.ops.work.read,
    H.ops.blockers.resolve,
    H.ops.memory.read,
    H.ops.memory.write,
    H.ops.memory.curate,
    H.ops.telemetry.read,
  );

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTasteCandidates, revisedDraftReturnsToReview)
  .metrics(critiqueActedOn)
  .scheduler(scheduler)
  .supervisor(supervisor)
  .observe(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const running = contentReview.start();
