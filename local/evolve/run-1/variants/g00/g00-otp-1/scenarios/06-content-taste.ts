import { z } from 'zod';
import { H, Model, ModelChoice, PolicyEnv } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const Submitted = H.state('submitted', 'pending');
const Reviewing = H.state('reviewing', 'active');
const WithEditor = H.state('with-editor', 'active');
const Accepted = H.state('accepted', 'succeeded');
const Returned = H.state('returned', 'concluded');
const ReviewFailed = H.state('review-failed', 'failed');

const DraftSchema = z.object({
  id: z.string(),
  revision: z.number(),
  section: z.string(),
  title: z.string(),
  body: z.string(),
  editorNotes: z.string().optional(),
});
type DraftData = z.infer<typeof DraftSchema>;

const Draft = H.work('Draft', DraftSchema)
  .states(Submitted, Reviewing, WithEditor, Accepted, Returned, ReviewFailed)
  .key(draft => `${draft.id}@${draft.revision}`);

const cmsHeaders = { Authorization: H.env('CMS_TOKEN') };
const cmsDrafts = http.poll<DraftData>({
  url: H.env('CMS_DRAFTS_URL'),
  everyMinutes: 10,
  headers: cmsHeaders,
  map: body => z.object({ drafts: z.array(DraftSchema) }).parse(body).drafts,
});
const cms = http.store<DraftData>({
  baseUrl: H.env('CMS_API_URL'),
  headers: cmsHeaders,
  read: body => DraftSchema.parse(body),
  write: (draft, state) => ({ id: draft.id, revision: draft.revision, reviewState: state, editorNotes: draft.editorNotes }),
});

const apiAccount = anthropic.apiKey('editorial-api', { key: H.env('ANTHROPIC_API_KEY') });
const editorialPool = H.pool('editorial').accounts(apiAccount);
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const reviewerModels: readonly Model[] = [opus, sonnet, haiku];

const followedA = H.metric('critique-a-acted-on', {
  count: { decision: 'editor', where: { followedA: true } },
  of: { decision: 'editor' },
});
const followedB = H.metric('critique-b-acted-on', {
  count: { decision: 'editor', where: { followedB: true } },
  of: { decision: 'editor' },
});
const reviewerSlots = [
  { agent: 'reviewer-a', metric: followedA },
  { agent: 'reviewer-b', metric: followedB },
];
const swapAfterSamples = 50;

const standing = (model: Model, env: PolicyEnv) => {
  const reads = reviewerSlots.map(slot => env.metrics.read(slot.metric, { agent: slot.agent, model, sinceDays: 180 }));
  const hits = reads.reduce((sum, read) => sum + read.hits, 0);
  const samples = reads.reduce((sum, read) => sum + read.samples, 0);
  return { model, hits, samples, rate: samples === 0 ? 0 : hits / samples };
};

const reviewerModel = (slot: number) =>
  H.policy(`reviewer-model-${slot}`, (_choice: ModelChoice, env: PolicyEnv): Model => {
    const ranked = reviewerModels
      .map(model => standing(model, env))
      .sort((x, y) => {
        const xExploring = x.samples < swapAfterSamples;
        const yExploring = y.samples < swapAfterSamples;
        if (xExploring !== yExploring) return xExploring ? -1 : 1;
        return xExploring ? 0 : y.rate - x.rate;
      });
    return ranked[slot].model;
  });

const editorialTaste = H.journal('editorial-taste', H.memory.taste('editorial-taste').curated())
  .store(jsonl.memory('.harness/editorial-taste.jsonl'))
  .recall(H.policy.specificity({ limit: 25 }));
const factChecking = H.journal('fact-checking', H.memory.experience('fact-checking'))
  .store(jsonl.memory('.harness/fact-checking.jsonl'))
  .recall(H.policy.specificity({ limit: 10, trackRecord: true }));

const reviewerRole = H.role('reviewer').instructions('Critique the draft for structure, clarity, accuracy and house style.');
const critique = z.object({ critique: z.string(), issues: z.array(z.string()) });

const reviewerA = H.agent('reviewer-a', reviewerRole)
  .model(reviewerModel(0))
  .pool(editorialPool)
  .recall(editorialTaste, factChecking)
  .output(critique);
const reviewerB = H.agent('reviewer-b', reviewerRole)
  .model(reviewerModel(1))
  .pool(editorialPool)
  .recall(editorialTaste, factChecking)
  .output(critique);

const factCheck = H.command('fact-check')
  .run((input: { id: string; body: string }) => ['fact-check', '--draft', input.id, '--body', input.body])
  .output(z.object({ repeats: z.array(z.object({ topic: z.string(), lesson: z.string(), reason: z.string() })) }));
const mergeCritiques = H.command('merge-critiques')
  .run((input: { first: string; second: string }) => ['merge-critiques', '--first', input.first, '--second', input.second])
  .output(z.object({ merged: z.string() }));

const reviewPrompt = (draft: DraftData): string => `Section: ${draft.section}\nTitle: ${draft.title}\n\n${draft.body}`;

const review = H.flow<DraftData>('review-draft')
  .exits('accepted', 'returned')
  .label(ctx => ({ section: ctx.unit.data.section }))
  .call('critiqueA', reviewerA, ctx => reviewPrompt(ctx.unit.data))
  .call('critiqueB', reviewerB, ctx => reviewPrompt(ctx.unit.data))
  .call('factCheck', factCheck, ctx => ({ id: ctx.unit.data.id, body: ctx.unit.data.body }))
  .record(factChecking, ctx =>
    ctx.steps.factCheck.repeats.map(repeat => ({
      do: repeat.lesson,
      when: `a draft makes claims about ${repeat.topic}`,
      because: repeat.reason,
    })),
  )
  .call('merge', mergeCritiques, ctx => ({ first: ctx.steps.critiqueA.critique, second: ctx.steps.critiqueB.critique }))
  .halt('editor', {
    ask: ctx => `"${ctx.unit.data.title}" (${ctx.unit.data.section})\n\n${ctx.steps.merge.merged}`,
    decision: z.object({
      verdict: z.enum(['accept', 'return']),
      notes: z.string(),
      followedA: z.boolean(),
      followedB: z.boolean(),
    }),
  })
  .update(ctx => ({ editorNotes: ctx.steps.editor.notes }))
  .exit(ctx => (ctx.steps.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const draftLane = H.lane(Draft)
  .supply(cmsDrafts)
  .store(cms)
  .handler(review)
  .exits({ accepted: Accepted, returned: Returned, crashed: ReviewFailed })
  .phases({ critiqueA: Reviewing, critiqueB: Reviewing, factCheck: Reviewing, merge: Reviewing, editor: WithEditor })
  .runner(local.runner('local'));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.on.enter(Draft, Returned))
  .do(event =>
    (event.unit.data.editorNotes ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(note =>
        H.do.record(editorialTaste, {
          do: note,
          when: `reviewing a ${event.unit.data.section} draft`,
          because: `the editor returned "${event.unit.data.title}" with this note`,
        }),
      ),
  );

const editorGrant = H.grant(
  'editor',
  H.op.readWork,
  H.op.resolveBlocker,
  H.op.readMemory,
  H.op.writeMemory,
  H.op.curateMemory,
  H.op.readTelemetry,
);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(draftLane)
  .triggers(returnedNotesBecomeTaste)
  .clients(claude.supervisor({ grant: editorGrant }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
