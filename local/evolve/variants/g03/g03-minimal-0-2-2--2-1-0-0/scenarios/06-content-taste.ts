import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);

const draft = H.kind('draft')
  .data(z.object({ title: z.string(), body: z.string(), section: sections, editorNotes: z.string().optional() }))
  .states(
    H.state('submitted', 'pending'),
    H.state('returned', 'waiting'),
    H.state('accepted', 'terminal', 'success'),
    H.state('review-failed', 'terminal', 'failure')
  );

const section = H.facet('section', sections);

const tasteKind = H.memory('editorial-taste', 'taste');
const factKind = H.memory('fact-checking', 'experience');
const taste = H.journal('editorial-taste', tasteKind, jsonl.memory('.harness/taste.jsonl'));
const facts = H.journal('fact-checking', factKind, jsonl.memory('.harness/fact-checking.jsonl'));

const opus = anthropic.model('claude-opus-4-1');
const sonnetNew = anthropic.model('claude-sonnet-4-5');
const sonnetOld = anthropic.model('claude-sonnet-4');
const haiku = anthropic.model('claude-haiku-4-5');

const reviewPool = H.pool('review', [
  { account: anthropic.account('review-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]).serves(opus, sonnetNew, sonnetOld, haiku);

const editorial = H.halt(
  'editorial',
  z.object({ action: z.enum(['accept', 'return']), notes: z.string() })
);

const reviewerChoice = (name: string, incumbent: Model, challenger: Model) =>
  H.policy.model(name, [incumbent, challenger], choice => {
    const mine = choice.metrics
      .rateBy({
        among: editorial.resolved(),
        count: { entry: 'credit', halt: editorial, seat: choice.seat },
        by: { modelOf: choice.seat },
        days: 90,
      })
      .of(incumbent);
    const [rival] = choice.rivals;
    if (rival === undefined || mine.samples < 50) return incumbent;
    const theirs = choice.metrics.rate({
      among: editorial.resolved(),
      count: { entry: 'credit', halt: editorial, seat: rival.seat },
      days: 90,
    });
    const weaker = (mine.value ?? 0) < (theirs.value ?? 0);
    return weaker && challenger !== rival.model ? challenger : incumbent;
  });

const reviewerRole = H.role('reviewer')
  .input(z.object({ title: z.string(), body: z.string(), section: sections }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}".\n\n${input.body}`);

const firstReviewer = H.seat('first-reviewer', reviewerRole)
  .model(reviewerChoice('first-reviewer-model', opus, sonnetNew))
  .recalls(taste, facts)
  .judgedBy(editorial);

const secondReviewer = H.seat('second-reviewer', reviewerRole)
  .model(reviewerChoice('second-reviewer-model', sonnetOld, haiku))
  .recalls(taste, facts)
  .judgedBy(editorial);

const local = shell.local('local', { slots: 2 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.string()) }))
  .argv(input => ['fact-check', '--json', input.body])
  .on(local)
  .recovery('rerun');

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', input.first, input.second])
  .on(local)
  .recovery('rerun');

const review = H.flow('review-draft')
  .for(draft)
  .does(async ctx => {
    const piece = { title: ctx.unit.data.title, body: ctx.unit.data.body, section: ctx.unit.data.section };
    const first = await ctx.run(firstReviewer, piece);
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(secondReviewer, piece);
    if (!second.ok) return ctx.fail(second.error);
    const checked = await ctx.run(factCheck, { body: piece.body });
    if (checked.ok) {
      for (const mistake of checked.value.repeatMistakes) {
        await ctx.remember(facts, {
          text: `When a draft claims ${mistake}, verify it against the primary source before approving`,
          because: 'the fact-check found the same mistake in an earlier draft',
          when: { kinds: [draft] },
        });
      }
    }
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorial, merged.value);
    if (decision.action === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsHeaders = { authorization: H.env('CMS_TOKEN') };

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?status=ready',
  every: { minutes: 15 },
  headers: cmsHeaders,
  body: z.object({
    drafts: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
        section: sections,
        status: z.enum(['submitted', 'resubmitted']),
      })
    ),
  }),
  read: (body, supply) =>
    body.drafts.map(item =>
      item.status === 'resubmitted'
        ? supply.update(item.id, { patch: { title: item.title, body: item.body }, state: 'submitted' })
        : supply.create({ title: item.title, body: item.body, section: item.section }, { key: item.id })
    ),
});

const drafts = H.lane('drafts', draft)
  .handler(review)
  .retries(1, { exhausted: 'review-failed' })
  .suppliers(cmsPoll)
  .store(http.store(draft, { url: 'https://cms.example.com/api/drafts', headers: cmsHeaders, stateField: 'review_status' }))
  .facet(section, data => data.section);

const notesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(draft, 'returned'), (event, act) =>
  act.remember(taste, {
    text: `When reviewing ${event.unit.data.section} drafts, ${event.unit.data.editorNotes ?? 'apply the editor notes'}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    when: { kinds: [draft], roles: [reviewerRole], facets: [section.of(event.unit.data.section)] },
    status: 'candidate',
  })
);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/content-ledger.db'))
  .lanes(drafts)
  .pools(reviewPool)
  .triggers(notesBecomeTaste)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.resolve(editorial),
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.curateMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
