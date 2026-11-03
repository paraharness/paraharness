import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Resource } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const draftSchema = z.object({ draftId: z.string(), title: z.string(), section: z.string(), body: z.string() });
const cmsRecord = z.object({ draft: draftSchema, harnessState: z.string() });
const critiqueSchema = z.object({ points: z.array(z.string()), verdict: z.string() });
const factReport = z.object({ issues: z.array(z.object({ claim: z.string(), repeat: z.boolean(), lesson: z.string(), pattern: z.string() })) });

const submitted = H.state('submitted').pending();
const inReview = H.state('inReview').active();
const accepted = H.state('accepted').terminal('success');
const returned = H.state('returned').waiting();
const stuck = H.state('stuck').waiting();

const draft = H.work('Draft').schema(draftSchema).states(submitted, inReview, accepted, returned, stuck);

const sports = H.resource('sports');
const opinion = H.resource('opinion');
const sectionResources = (section: string): readonly Resource[] =>
  section === 'sports' ? [sports] : section === 'opinion' ? [opinion] : [];

const taste = H.memory('editorialTaste').content(z.object({ prefer: z.string() })).trust('taste');
const factLessons = H.memory('factLessons')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const tasteJournal = H.journal('editorialTaste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 15 }));
const factJournal = H.journal('factLessons').of(factLessons).store(jsonl.store('memory/facts.jsonl')).recall(policies.specificity({ limit: 8 }));

const local = H.runner.local('local', { slots: 4 });

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ critiques: z.array(critiqueSchema) }))
  .output(z.object({ merged: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const points = [...new Set(input.critiques.flatMap(c => c.points))];
    return { merged: points.map(p => `- ${p}`).join('\n') };
  });

const factCheck = H.command('factCheck')
  .input(z.object({ draftId: z.string(), body: z.string() }))
  .output(z.object({ issues: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`fact-check --draft ${input.draftId} --json`, { stdin: input.body });
    const report = factReport.parse(JSON.parse(result.stdout));
    for (const issue of report.issues.filter(i => i.repeat)) {
      await ctx.record(factJournal, { content: { do: issue.lesson, when: issue.pattern, because: issue.claim }, status: 'candidate' });
    }
    return { issues: report.issues.map(i => i.claim) };
  });

const editorReview = H.halt('editorReview')
  .context(z.object({ title: z.string(), section: z.string(), merged: z.string(), factIssues: z.array(z.string()) }))
  .ask(c => `Review "${c.title}" (${c.section}).\n\nCritique:\n${c.merged}\n\nFact issues:\n${c.factIssues.join('\n')}`)
  .decision(z.object({ verdict: z.enum(['accept', 'return']), notes: z.string(), actedOn: z.array(z.enum(['a', 'b'])) }));

const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const challenger = H.model('claude-haiku-4-5').pricing(anthropic.pricing());

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const apiPool = H.pool('api', [apiAccount]).serves(opus, sonnet, challenger);

const critiqueActedOn = H.metric('critiqueActedOn').rate(
  H.events.decisions(editorReview, { credit: d => d.actedOn.map(r => (r === 'a' ? reviewerA : reviewerB)) }),
  H.events.decisions(editorReview),
);

const swapWeakerReviewer = H.policy.seat('swapWeakerReviewer', ({ candidates, seat, metrics }) => {
  const rival = seat === reviewerA ? reviewerB : reviewerA;
  const leading = candidates[0];
  if (leading === undefined) return candidates;
  const mine = metrics.read(critiqueActedOn, { window: '90d', where: { seat, model: leading } });
  const theirs = metrics.read(critiqueActedOn, { window: '90d', where: { seat: rival } });
  const weaker = mine.samples >= 50 && theirs.samples >= 50 && (mine.value ?? 0) < (theirs.value ?? 0);
  return weaker ? [...candidates].reverse() : candidates;
});

const reviewerRole = H.role('reviewer').promptFile('roles/reviewer.md').recall(taste, factLessons);
const reviewerA = H.seat('reviewerA').role(reviewerRole).models(opus, challenger).policy(swapWeakerReviewer);
const reviewerB = H.seat('reviewerB').role(reviewerRole).models(sonnet, challenger).policy(swapWeakerReviewer);

const critique = H.skill('critique')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(critiqueSchema)
  .prompt(i => `Critique this ${i.section} draft, "${i.title}":\n\n${i.body}`);

const review = H.flow('review')
  .input(draftSchema)
  .resources(s => sectionResources(s.input.section))
  .step('critiqueA', reviewerA.call(critique), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('critiqueB', reviewerB.call(critique), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('merge', mergeCritiques, s => ({ critiques: [s.steps.critiqueA, s.steps.critiqueB] }))
  .step('factCheck', factCheck, s => ({ draftId: s.input.draftId, body: s.input.body }))
  .halt('editor', editorReview, s => ({
    title: s.input.title,
    section: s.input.section,
    merged: s.steps.merge.merged,
    factIssues: s.steps.factCheck.issues,
  }))
  .exit(s => (s.steps.editor.verdict === 'accept' ? 'accepted' : 'returned'));

const cmsToken = H.env('CMS_TOKEN');
const cmsBase = 'https://cms.example.com/api';

const cmsStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${cmsBase}/drafts/${unit.key}`, { headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` } });
    if (!response.ok) return undefined;
    const record = cmsRecord.parse(await response.json());
    return { data: record.draft, state: record.harnessState };
  },
  save: async (unit, change, ctx) => {
    await fetch(`${cmsBase}/drafts/${unit.key}/review-state`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const cmsPoll = supply.poll({
  every: '15m',
  fetch: async ctx => {
    const response = await fetch(`${cmsBase}/drafts?status=ready`, { headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` } });
    return z.array(draftSchema).parse(await response.json());
  },
}).key(d => d.draftId);

const drafts = H.lane('drafts')
  .of(draft)
  .from(cmsPoll)
  .store(cmsStore)
  .handle(review)
  .exits({ accepted, returned, failed: { tries: 2, backoff: 'linear', delaySeconds: 120, then: stuck } });

const notesBecomeTaste = H.trigger('returnedNotesBecomeTaste')
  .on(editorReview.resolved())
  .when(p => p.decision.verdict === 'return' && p.decision.notes.trim().length > 0)
  .do(tasteJournal.record(p => ({
    content: { prefer: p.decision.notes },
    when: { kinds: [draft], resources: sectionResources(p.context.section) },
    status: 'candidate',
  })));

const editor = claudeCode.client('editor');

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(notesBecomeTaste)
  .grants(H.grant(
    editor,
    H.ops.work.read,
    H.ops.resolve(editorReview),
    H.ops.memory.write(tasteJournal),
    H.ops.memory.curate(tasteJournal, factJournal),
    H.ops.telemetry.read,
  ))
  .metrics(critiqueActedOn)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
