import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric, Model } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const cmsUrl = H.env('CMS_URL');
const cmsToken = H.env('CMS_TOKEN');

const sectionSchema = z.enum(['news', 'sports', 'opinion', 'culture']);
const draftSchema = z.object({
  cmsId: z.string(),
  title: z.string(),
  section: sectionSchema,
  body: z.string(),
  revision: z.number(),
});
type Draft = z.infer<typeof draftSchema>;

const submitted = H.state('submitted').pending();
const inReview = H.state('inReview').active();
const returned = H.state('returned').waiting();
const accepted = H.state('accepted').terminal('success');
const withdrawn = H.state('withdrawn').terminal('neutral');
const stalled = H.state('stalled').terminal('failure');

const draftKind = H.work('Draft').schema(draftSchema).states(submitted, inReview, returned, accepted, withdrawn, stalled);

const sports = H.resource('sports');
const opinion = H.resource('opinion');
const sectionResources = new Map([['sports', sports], ['opinion', opinion]]);

const taste = H.memory('editorial-taste').content(z.object({ preference: z.string() })).trust('taste');
const factLessons = H.memory('fact-check-lessons')
  .content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }))
  .trust('experience');

const tasteJournal = H.journal('editorial-taste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 15 }));
const experienceJournal = H.journal('fact-check-lessons').of(factLessons).store(jsonl.store('memory/fact-checks.jsonl')).recall(policies.specificity({ limit: 10 }));

const subscription = H.account('newsroom', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_DIR') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const challenger = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const pool = H.pool('newsroom', [subscription]).serves(opus, sonnet, challenger);

const reviewerRole = H.role('reviewer').promptFile('prompts/reviewer.md').intents(['read']).recall(taste, factLessons);

const critiqueSchema = z.object({ points: z.array(z.string()), claims: z.array(z.string()) });
const critique = H.skill('critique')
  .input(z.object({ title: z.string(), section: sectionSchema, body: z.string() }))
  .output(critiqueSchema)
  .prompt(i => `Critique this ${i.section} draft, "${i.title}", and list every factual claim it makes:\n\n${i.body}`);

const editorReview = H.halt('editor-review')
  .context(z.object({ title: z.string(), section: sectionSchema, merged: z.string(), factIssues: z.array(z.string()) }))
  .ask(c => `${c.title} (${c.section})\n\n${c.merged}\n\nFact issues:\n${c.factIssues.join('\n')}`)
  .decision(z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    sectionOnly: z.boolean(),
    actedOn: z.array(z.enum(['a', 'b'])),
  }));

const actedOnRate = (letter: 'a' | 'b') => H.metric(`editor-acted-on-${letter}`).rate(
  H.events.decisions(editorReview, { match: d => d.actedOn.includes(letter), resolver: 'human' }),
  H.events.decisions(editorReview, { resolver: 'human' }),
);
const actedOnA = actedOnRate('a');
const actedOnB = actedOnRate('b');

const swapAfterSamples = 50;
const swapWeaker = (name: string, mine: Metric, theirs: Metric, incumbent: Model, rival: Model) =>
  H.policy.seat(name, ({ metrics }) => {
    const own = metrics.read(mine, { window: '60d', where: { model: incumbent } });
    const other = metrics.read(theirs, { window: '60d', where: { model: rival } });
    const weaker = own.samples >= swapAfterSamples && other.samples >= swapAfterSamples && (own.value ?? 0) < (other.value ?? 0);
    return weaker ? [challenger, incumbent] : [incumbent, challenger];
  });

const reviewerA = H.seat('reviewer-a').role(reviewerRole).models(opus, challenger)
  .policy(swapWeaker('reviewer-a-swaps-when-weaker', actedOnA, actedOnB, opus, sonnet));
const reviewerB = H.seat('reviewer-b').role(reviewerRole).models(sonnet, challenger)
  .policy(swapWeaker('reviewer-b-swaps-when-weaker', actedOnB, actedOnA, sonnet, opus));

const local = H.runner.local('local', { slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critiqueSchema, b: critiqueSchema }))
  .output(z.object({ merged: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const points = [...new Set([...input.a.points, ...input.b.points])];
    return { merged: points.map(p => `- ${p}`).join('\n') };
  });

const factReport = z.object({ issues: z.array(z.object({ claim: z.string(), problem: z.string(), lesson: z.string(), repeat: z.boolean() })) });

const factCheck = H.command('fact-check')
  .input(z.object({ cmsId: z.string(), claims: z.array(z.string()) }))
  .output(z.object({ issues: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh('./fact-check --json', { stdin: JSON.stringify(input) });
    const report = factReport.parse(JSON.parse(result.stdout));
    for (const issue of report.issues.filter(i => i.repeat)) {
      await ctx.record(experienceJournal, {
        content: { condition: `when a draft claims "${issue.claim}"`, action: issue.lesson, reason: issue.problem },
        when: { roles: [reviewerRole] },
      });
    }
    return { issues: report.issues.map(i => `${i.claim}: ${i.problem}`) };
  });

const review = H.flow('review')
  .input(draftSchema)
  .resources(s => {
    const section = sectionResources.get(s.input.section);
    return section === undefined ? [] : [section];
  })
  .step('critiqueA', reviewerA.call(critique), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('critiqueB', reviewerB.call(critique), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('merge', mergeCritiques, s => ({ a: s.steps.critiqueA, b: s.steps.critiqueB }))
  .step('factCheck', factCheck, s => ({
    cmsId: s.input.cmsId,
    claims: [...s.steps.critiqueA.claims, ...s.steps.critiqueB.claims],
  }))
  .halt('editorReview', editorReview, s => ({
    title: s.input.title,
    section: s.input.section,
    merged: s.steps.merge.merged,
    factIssues: s.steps.factCheck.issues,
  }))
  .exit(s => (s.steps.editorReview.verdict === 'accept' ? 'accepted' : 'returned'));

const storedSchema = z.object({ data: z.unknown(), state: z.string() });

const drafts = H.lane('drafts')
  .of(draftKind)
  .from(supply.poll({
    every: '5m',
    fetch: async (ctx): Promise<Draft[]> => {
      const response = await fetch(`${ctx.resolve(cmsUrl)}/drafts?status=submitted`, {
        headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` },
      });
      return z.array(draftSchema).parse(await response.json());
    },
  }).key(data => data.cmsId))
  .store(http.store({
    load: async (unit, ctx) => {
      const response = await fetch(`${ctx.resolve(cmsUrl)}/drafts/${unit.key}/harness`, {
        headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` },
      });
      if (response.status === 404) return undefined;
      const body = storedSchema.parse(await response.json());
      return { data: body.data, state: body.state };
    },
    save: async (unit, change, ctx) => {
      await fetch(`${ctx.resolve(cmsUrl)}/drafts/${unit.key}/harness`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}`, 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
    },
  }))
  .handle(review)
  .exits({ accepted, returned })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 120, exhausted: stalled });

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(editorReview.resolved())
  .when(p => p.decision.verdict === 'return' && p.decision.notes.trim().length > 0)
  .do(tasteJournal.record(p => {
    const section = sectionResources.get(p.context.section);
    return {
      content: { preference: p.decision.notes },
      status: 'candidate',
      when: p.decision.sectionOnly && section !== undefined ? { resources: [section] } : { kinds: [draftKind] },
    };
  }));

const editor = H.grant(
  claudeCode.client('editor', { session: 'newsroom' }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(editorReview),
  H.ops.memory.write(tasteJournal),
  H.ops.memory.curate(tasteJournal, experienceJournal),
  H.ops.telemetry.read,
);

export default H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(drafts)
  .journals(tasteJournal, experienceJournal)
  .triggers(returnedNotesBecomeTaste)
  .grants(editor)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
