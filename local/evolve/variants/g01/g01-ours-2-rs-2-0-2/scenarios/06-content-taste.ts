import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric, Resource, Seat } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const submitted = H.state('submitted').pending();
const inReview = H.state('inReview').active();
const returned = H.state('returned').waiting();
const accepted = H.state('accepted').terminal('success');
const withdrawn = H.state('withdrawn').terminal('neutral');
const reviewFailed = H.state('reviewFailed').terminal('failure');

const sectionSchema = z.enum(['news', 'sports', 'opinion']);
type Section = z.infer<typeof sectionSchema>;
const draftSchema = z.object({ id: z.string(), title: z.string(), section: sectionSchema, body: z.string() });

const Draft = H.work('Draft').schema(draftSchema).states(submitted, inReview, returned, accepted, withdrawn, reviewFailed);

const sports = H.resource('sports');
const opinion = H.resource('opinion');

const sectionScope = (section: Section): Resource[] => {
  if (section === 'sports') return [sports];
  if (section === 'opinion') return [opinion];
  return [];
};

const taste = H.memory('editorialTaste').content(z.object({ preference: z.string() })).trust('taste');
const factLesson = H.memory('factCheckLesson').content(z.object({ lesson: z.string() })).trust('experience');

const tasteJournal = H.journal('editorialTaste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 15 }));
const factJournal = H.journal('factCheckLessons').of(factLesson).store(jsonl.store('memory/fact-check.jsonl')).recall(policies.specificity({ limit: 8 }));

const cmsBase = 'https://cms.example.com/api';
const cmsToken = H.env('CMS_TOKEN');
const cmsRecord = z.object({ draft: draftSchema, stage: z.string() });

const cmsStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${cmsBase}/drafts/${unit.key}/review`, { headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` } });
    if (!response.ok) return undefined;
    const record = cmsRecord.parse(await response.json());
    return { data: record.draft, state: record.stage };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${cmsBase}/drafts/${unit.key}/review`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ stage: change.state, draft: change.data }),
    });
  },
});

const cmsPoll = supply
  .poll({
    every: '15m',
    fetch: async ctx => {
      const response = await fetch(`${cmsBase}/drafts?status=submitted`, { headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` } });
      return z.array(draftSchema).parse(await response.json());
    },
  })
  .key(draft => draft.id);

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const challenger = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [apiAccount]).serves(opus, sonnet, challenger);

const reviewerRole = H.role('reviewer')
  .prompt('You critique a draft for the editor: structure, claims, tone, house style.')
  .intents([])
  .recall(taste, factLesson);

const critiqueSkill = H.skill('critique')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ points: z.array(z.string()) }))
  .prompt(i => `Section: ${i.section}\nTitle: ${i.title}\n\n${i.body}`);

const reviewerNames = z.enum(['reviewerA', 'reviewerB']);

const editorDecision = H.halt('editorDecision')
  .context(z.object({ title: z.string(), section: sectionSchema, merged: z.string() }))
  .ask(c => `Accept or return "${c.title}" (${c.section})?\n\n${c.merged}`)
  .decision(z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    scope: z.enum(['all', 'section']),
    actedOn: z.array(reviewerNames),
  }));

const swapWeakerReviewer = H.policy.seat('swapWeakerReviewer', ({ candidates, seat, metrics }) => {
  const rivalSeat = seat === reviewerA ? reviewerB : reviewerA;
  const own = metrics.read(critiqueActedOn, { window: '60d', where: { seat } });
  const rival = metrics.read(critiqueActedOn, { window: '60d', where: { seat: rivalSeat } });
  const enoughSamples = own.samples >= 50 && rival.samples >= 50;
  const weaker = enoughSamples && (own.value ?? 0) < (rival.value ?? 0);
  return weaker ? [...candidates].reverse() : candidates;
});

const reviewerA: Seat = H.seat('reviewerA').role(reviewerRole).models(opus, challenger).policy(swapWeakerReviewer);
const reviewerB: Seat = H.seat('reviewerB').role(reviewerRole).models(sonnet, challenger).policy(swapWeakerReviewer);

const critiqueActedOn: Metric = H.metric('critiqueActedOn').rate(
  H.events.credits(editorDecision, decision => decision.actedOn.map(name => (name === 'reviewerA' ? reviewerA : reviewerB))),
  H.events.decisions(editorDecision),
);

const recurringMistakes: ReadonlyArray<{ readonly pattern: RegExp; readonly lesson: string }> = [
  { pattern: /\bteh\b/i, lesson: 'When a draft is long, scan for transposed letters before critiquing style, because "teh" slipped through twice' },
  { pattern: /\b(19|20)\d{2}\s+World Cup\b/, lesson: 'When a draft cites a World Cup year, confirm the host and year together, because writers keep pairing them wrongly' },
  { pattern: /\bliterally\b/i, lesson: 'When "literally" appears in a claim, check whether the claim is literal, because it has been misused in published copy' },
];

const factCheck = H.command('factCheck')
  .input(z.object({ draftId: z.string(), body: z.string() }))
  .output(z.object({ issues: z.array(z.string()) }))
  .run(async (input, ctx) => {
    const hits = recurringMistakes.filter(mistake => mistake.pattern.test(input.body));
    for (const hit of hits) {
      await ctx.record(factJournal, { content: { lesson: hit.lesson }, when: { kinds: [Draft] } });
    }
    return { issues: hits.map(hit => `${input.draftId}: ${hit.lesson}`) };
  });

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ a: z.array(z.string()), b: z.array(z.string()), facts: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .run(async input => {
    const shared = input.a.filter(point => input.b.includes(point));
    const onlyA = input.a.filter(point => !input.b.includes(point));
    const onlyB = input.b.filter(point => !input.a.includes(point));
    const section = (heading: string, points: readonly string[]) => `## ${heading}\n${points.map(p => `- ${p}`).join('\n') || '- none'}`;
    return {
      merged: [
        section('Both reviewers', shared),
        section('Reviewer A', onlyA),
        section('Reviewer B', onlyB),
        section('Fact check', input.facts),
      ].join('\n\n'),
    };
  });

const review = H.flow('review')
  .input(draftSchema)
  .resources(s => sectionScope(s.input.section))
  .step('critiqueA', reviewerA.call(critiqueSkill), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('critiqueB', reviewerB.call(critiqueSkill), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('factCheck', factCheck, s => ({ draftId: s.input.id, body: s.input.body }))
  .step('merge', mergeCritiques, s => ({ a: s.steps.critiqueA.points, b: s.steps.critiqueB.points, facts: s.steps.factCheck.issues }))
  .halt('editor', editorDecision, s => ({ title: s.input.title, section: s.input.section, merged: s.steps.merge.merged }))
  .exit(s => (s.steps.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const drafts = H.lane('drafts')
  .of(Draft)
  .from(cmsPoll)
  .store(cmsStore)
  .handle(review, {
    exits: { accepted, returned },
    retry: { tries: 2, backoff: 'linear', delaySeconds: 120, exhausted: reviewFailed },
  })
  .wip(3);

const returnedNotesBecomeTaste = H.trigger('returnedNotesBecomeTaste')
  .on(H.resolved(editorDecision))
  .when(p => p.decision.verdict === 'return' && p.decision.notes.trim().length > 0)
  .do(
    H.record(tasteJournal, p => ({
      content: { preference: p.decision.notes },
      status: 'candidate',
      when: p.decision.scope === 'section'
        ? { kinds: [Draft], resources: sectionScope(p.context.section) }
        : { kinds: [Draft] },
    })),
  );

const oldestFirst = H.policy.schedule('oldestFirst', ({ candidates }) =>
  [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
);

const editor = claudeCode.client('editor');

const editorGrant = H.grant(
  editor,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(editorDecision),
  H.ops.memory.write(tasteJournal),
  H.ops.memory.curate(tasteJournal, factJournal),
  H.ops.telemetry.read,
);

export default H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste)
  .schedule(oldestFirst)
  .grants(editorGrant)
  .metrics(critiqueActedOn)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
