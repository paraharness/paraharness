import { z } from 'zod';
import { H } from 'harness-dsl';
import type { MemoryDraft, PolicyContext, Sample } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { wordpress } from 'harness-dsl/wordpress';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const InReview = H.state('in-review', 'runnable');
const Accepted = H.state('accepted', 'succeeded');
const Returned = H.state('returned', 'waiting');
const Withdrawn = H.state('withdrawn', 'cancelled');

const draftData = z.object({
  postId: z.string(),
  title: z.string(),
  content: z.string(),
  section: z.string(),
  author: z.string(),
  editorNotes: z.string().nullable(),
});
type DraftData = z.infer<typeof draftData>;

const Draft = H.kind('Draft', { data: draftData, key: (draft) => draft.postId })
  .states([InReview, Accepted, Returned, Withdrawn], { initial: InReview })
  .messages({ resubmitted: z.object({ content: z.string() }) })
  .on('resubmitted', {
    from: [Returned],
    to: InReview,
    guard: (unit, revision) => unit.data.content !== revision.content,
    update: (draft, revision) => ({ ...draft, content: revision.content }),
  })
  .on('cancel', { from: [InReview, Returned], to: Withdrawn, attempt: 'cancel' });

const Section = H.resource('section');

const Taste = H.memory('editorial-taste', { authority: 'owner' });
const FactChecking = H.memory('fact-checking', { authority: 'observed' });

const tasteJournal = H.journal('editorial-taste', Taste)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 25 }));
const factJournal = H.journal('fact-check-lessons', FactChecking)
  .store(jsonl.store('memory/fact-checking.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 10 }));

const apiAccount = anthropic.apiKey('newsroom-api', { key: H.env('ANTHROPIC_API_KEY') });
const newsroomPool = H.pool('newsroom').accounts([{ account: apiAccount, share: 1 }]);

const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const candidates = [opus, sonnet, haiku];

const editorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['reviewer-a', 'reviewer-b'])),
});

const modelOf = (sample: Sample<DraftData>, executable: string) =>
  sample.invocations.find((invocation) => invocation.executable === executable)?.model ?? 'unknown';

const actedOnBy = (reviewer: 'reviewer-a' | 'reviewer-b') =>
  H.metric(`editor-acted-on-${reviewer}`, {
    kind: Draft,
    sample: (sample) => {
      const decision = sample.decision('editor', editorDecision);
      return decision === null ? null : decision.actedOn.includes(reviewer);
    },
    group: (sample) => modelOf(sample, reviewer),
  });

const actedOnA = actedOnBy('reviewer-a');
const actedOnB = actedOnBy('reviewer-b');

const rankedModels = (context: PolicyContext) => {
  const scored = candidates.map((model) => {
    const a = context.metrics.read(actedOnA, { days: 90, group: model.name });
    const b = context.metrics.read(actedOnB, { days: 90, group: model.name });
    const samples = a.samples + b.samples;
    const hits = (a.value ?? 0) * a.samples + (b.value ?? 0) * b.samples;
    return { model, samples, rate: samples === 0 ? 0 : hits / samples };
  });
  const exploring = scored.filter((entry) => entry.samples < 50);
  const proven = scored.filter((entry) => entry.samples >= 50).sort((x, y) => y.rate - x.rate);
  return [...proven.slice(0, 1), ...exploring, ...proven.slice(1)].map((entry) => entry.model);
};

const reviewerAModel = H.choose('reviewer-a-model', candidates, (_query, context) => rankedModels(context)[0]);
const reviewerBModel = H.choose('reviewer-b-model', candidates, (_query, context) => rankedModels(context)[1]);

const reviewerRole = H.role('reviewer', {
  prompt: 'Critique the draft for the editor: structure, clarity, accuracy and house style.',
  intents: [],
  input: z.object({ title: z.string(), content: z.string(), section: z.string() }),
  output: z.object({ critique: z.string(), points: z.array(z.string()) }),
});

const reviewerA = H.agent('reviewer-a', reviewerRole).model(reviewerAModel).pool(newsroomPool).recall(tasteJournal, factJournal);
const reviewerB = H.agent('reviewer-b', reviewerRole).model(reviewerBModel).pool(newsroomPool).recall(tasteJournal, factJournal);

const local = shell.local({ slots: 4 });

const factCheck = H.command('fact-check', {
  input: z.object({ content: z.string() }),
  output: z.object({
    findings: z.array(z.string()),
    repeatMistakes: z.array(z.object({ mistake: z.string(), rule: z.string() })),
  }),
  argv: (input) => ['fact-check', '--json', '--text', input.content],
  runner: local,
}).record(factJournal, (result) =>
  result.repeatMistakes.map(
    (mistake): MemoryDraft => ({
      do: mistake.rule,
      condition: `when a draft claims ${mistake.mistake}`,
      because: 'the fact-check has caught this mistake in earlier drafts',
    }),
  ),
);

const mergeCritiques = H.command('merge-critiques', {
  input: z.object({ a: z.array(z.string()), b: z.array(z.string()), facts: z.array(z.string()) }),
  output: z.object({ report: z.string() }),
  argv: (input) => ['merge-critiques', '--json', JSON.stringify(input)],
  runner: local,
});

const reviewDraft = H.flow(
  'review-draft',
  {
    input: z.object({ title: z.string(), content: z.string(), section: z.string() }),
    writes: z.object({ editorNotes: z.string().nullable() }),
    exits: ['accepted', 'returned'],
  },
  async (ctx) => {
    const brief = { title: ctx.input.title, content: ctx.input.content, section: ctx.input.section };
    const [a, b] = await Promise.all([ctx.run('review-a', reviewerA, brief), ctx.run('review-b', reviewerB, brief)]);
    const facts = await ctx.run('fact-check', factCheck, { content: ctx.input.content });
    const merged = await ctx.run('merge', mergeCritiques, { a: a.points, b: b.points, facts: facts.findings });
    const verdict = await ctx.halt('editor', {
      question: `Accept "${ctx.input.title}" or return it with notes?`,
      report: merged.report,
      decision: editorDecision,
    });
    return verdict.action === 'accept'
      ? ctx.exit('accepted', { editorNotes: null })
      : ctx.exit('returned', { editorNotes: verdict.notes });
  },
);

const cmsToken = H.env('CMS_TOKEN');

const pendingPosts = wordpress
  .posts({ url: 'https://cms.example.com', token: cmsToken, status: 'pending', every: H.time.every({ minutes: 10 }) })
  .to(Draft, (post, unit) => [
    unit.create({
      postId: post.id,
      title: post.title,
      content: post.content,
      section: post.section,
      author: post.author,
      editorNotes: null,
    }),
    unit.send(post.id, 'resubmitted', { content: post.content }),
  ]);

const draftLane = H.lane('drafts', Draft)
  .supply(pendingPosts)
  .store(wordpress.store({ url: 'https://cms.example.com', token: cmsToken }))
  .handle(InReview, reviewDraft, { exits: { accepted: Accepted, returned: Returned } })
  .limit({ wip: 6 })
  .resources((draft) => [Section.key(draft.section)]);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.entered(Draft, Returned))
  .note(tasteJournal, (transition) =>
    (transition.unit.data.editorNotes ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(
        (line): MemoryDraft => ({
          do: line,
          condition: `when reviewing ${transition.unit.data.section} drafts`,
          because: `the editor returned "${transition.unit.data.title}" with this note`,
          when: { kinds: [Draft], resources: [Section.key(transition.unit.data.section)] },
          status: 'candidate',
        }),
      ),
  );

const scheduler = H.scheduler('oldest-first', (query) => ({
  order: [...query.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
}));

const editor = H.client('editor', claudeCode.session()).grant([
  H.ops.readWork,
  H.ops.resolveBlockers,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('content-ledger.db'))
  .lanes([draftLane])
  .journals([tasteJournal, factJournal])
  .triggers([returnedNotesBecomeTaste])
  .scheduler(scheduler)
  .clients([editor])
  .observers([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
