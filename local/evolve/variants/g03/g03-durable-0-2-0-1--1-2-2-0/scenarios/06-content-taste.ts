import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { contentful } from 'harness-dsl/contentful';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const InReview = H.state('in-review', 'pending');
const Returned = H.state('returned', 'waiting');
const Accepted = H.terminal('accepted', 'success');
const Abandoned = H.terminal('abandoned', 'failure');

const sections = H.resources('section', ['sports', 'opinion']);

function sectionScope(section: string) {
  const parsed = sections.schema.safeParse(section);
  return parsed.success ? [sections.get(parsed.data)] : [];
}

const draft = z.object({
  entryId: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
  editorNotes: z.string().optional(),
});

const Draft = H.kind('draft').attributes(draft).states(InReview, Returned, Accepted, Abandoned).key(a => a.entryId).initial(InReview);

const reviewerRole = H.role('reviewer').intents('read').instructions('Critique the draft: structure, claims, voice.');
const editorRole = H.role('editor').instructions('Accept or return drafts with notes; curate taste.');

const taste = H.journal('editorial-taste', H.memory('editorial-taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(reviewerRole)
  .recordedBy(editorRole);

const factChecking = H.journal('fact-checking', H.memory('fact-check-lessons', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/fact-checking.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(reviewerRole);

const apiAccount = anthropic.account('anthropic-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('content-quota', { path: '.harness/quota.db' }),
});
const reviewPool = H.pool('review').accounts(apiAccount);

const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const reviewLineup = H.policy.lineup('reviewer-lineup', [opus, sonnet, haiku], ctx => {
  const scored = ctx.assignments.map(assignment => ({
    assignment,
    record: ctx.metrics.rate(critiqueActedOn, { seat: assignment.seat, model: assignment.model, window: { lastDays: 90 } }),
  }));
  if (ctx.spare.length === 0 || scored.some(entry => entry.record.samples < 50)) return ctx.assignments;
  const weakest = scored.reduce((low, entry) => (entry.record.rate < low.record.rate ? entry : low));
  return ctx.assignments.map(assignment =>
    assignment.seat === weakest.assignment.seat ? { seat: assignment.seat, model: ctx.spare[0] } : assignment,
  );
});

const firstReviewer = H.seat('first-reviewer').role(reviewerRole).model(reviewLineup).pool(reviewPool);
const secondReviewer = H.seat('second-reviewer').role(reviewerRole).model(reviewLineup).pool(reviewPool);

const workstation = local.runner('workstation');

const factCheck = H.command('fact-check')
  .input(z.object({ entryId: z.string(), body: z.string() }))
  .argv(input => ['fact-check', '--entry', input.entryId, '--body', input.body])
  .output(z.object({ repeatMistake: z.object({ claim: z.string(), lesson: z.string() }).optional() }))
  .runner(workstation);

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', '--first', input.first, '--second', input.second])
  .runner(workstation);

const editorial = H.halt('editorial-decision').decision(
  z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.array(z.enum(['first', 'second'])),
  }),
);

const resubmitted = H.signal('resubmitted');

const review = H.flow('draft-review')
  .input(draft)
  .step('factCheck', factCheck, ctx => ({ entryId: ctx.unit.attributes.entryId, body: ctx.unit.attributes.body }))
  .step('firstCritique', firstReviewer, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}" (${ctx.unit.attributes.section}):\n${ctx.unit.attributes.body}`,
    resources: sectionScope(ctx.unit.attributes.section),
  }))
  .step('secondCritique', secondReviewer, ctx => ({
    task: `Critique "${ctx.unit.attributes.title}" (${ctx.unit.attributes.section}):\n${ctx.unit.attributes.body}`,
    resources: sectionScope(ctx.unit.attributes.section),
  }))
  .step('merge', mergeCritiques, ctx => ({ first: ctx.steps.firstCritique, second: ctx.steps.secondCritique }))
  .halt('editorial', editorial, {
    ask: ctx => `Merged critiques for "${ctx.unit.attributes.title}":\n${ctx.steps.merge.stdout}`,
    annotate: (_, decision) => ({ editorNotes: decision.notes }),
  })
  .exit('accepted', ctx => ctx.steps.editorial.action === 'accept')
  .exit('returned');

const cmsToken = H.env('CONTENTFUL_TOKEN');

const drafts = H.lane('drafts', Draft)
  .supply(contentful.drafts({ space: 'newsroom', token: cmsToken, everyMinutes: 10 }), (entry, to) =>
    to.create({ entryId: entry.id, title: entry.title, section: entry.section, body: entry.body }),
  )
  .handler(review, { exits: { accepted: Accepted, returned: Returned } })
  .store(contentful.store({ space: 'newsroom', token: cmsToken }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: Abandoned })
  .on(resubmitted, { enter: InReview });

const critiqueActedOn = H.metric('critique-acted-on', H.when.decision(Draft, editorial)).samples(event => [
  { seat: firstReviewer, model: event.modelOf(firstReviewer), hit: event.decision.actedOn.includes('first') },
  { seat: secondReviewer, model: event.modelOf(secondReviewer), hit: event.decision.actedOn.includes('second') },
]);

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.when.transition(drafts, { to: Returned }))
  .record(taste, event =>
    event.unit.attributes.editorNotes === undefined
      ? undefined
      : {
          text: `When reviewing ${event.unit.attributes.section} drafts, apply the editor's note "${event.unit.attributes.editorNotes}", because the editor returned "${event.unit.attributes.title}" for it.`,
          when: { roles: [reviewerRole], resources: sectionScope(event.unit.attributes.section) },
          status: 'candidate',
        },
  );

const repeatMistakeBecomesExperience = H.trigger('repeat-mistake-becomes-experience')
  .on(H.when.step(drafts, 'factCheck'))
  .record(factChecking, event =>
    event.output?.repeatMistake === undefined
      ? undefined
      : {
          text: `When a draft claims "${event.output.repeatMistake.claim}", ${event.output.repeatMistake.lesson}, because the fact-check found this mistake again.`,
          when: { roles: [reviewerRole] },
        },
  );

const supervisor = claudeCode.supervisor('editor-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.resolve(editorial),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(drafts)
  .journals(taste, factChecking)
  .triggers(returnedNotesBecomeTaste, repeatMistakeBecomesExperience)
  .metrics(critiqueActedOn)
  .scheduler(H.scheduler('review').standard(drafts).wip(drafts, 4))
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
