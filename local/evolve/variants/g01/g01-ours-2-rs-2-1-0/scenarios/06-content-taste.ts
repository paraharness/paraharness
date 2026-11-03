import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Policy } from 'harness-dsl';
import type { DecisionEvent, UpdateEvent } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { rest } from 'harness-dsl/rest';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const section = H.facet('section');

const inReview = H.state('in-review').pending();
const returned = H.state('returned').waiting();
const accepted = H.state('accepted').terminal('success');
const reviewFailed = H.state('review-failed').terminal('failure');

const draftSchema = z.object({ id: z.string(), title: z.string(), body: z.string(), section: z.string() });
type Draft = z.infer<typeof draftSchema>;

const draft = H.work('draft').schema(draftSchema).states(inReview, returned, accepted, reviewFailed);

const taste = H.memory('editorial-taste').content(z.object({ rule: z.string() })).trust('taste').curated();
const factLesson = H.memory('fact-check-lesson').content(z.object({ rule: z.string() })).trust('experience');

const tasteLog = H.journal('editorial-taste').of(taste).store(jsonl.memory('memory/taste.jsonl')).recall(policies.specificity({ limit: 15 }));
const factLessons = H.journal('fact-check-lessons')
  .of(factLesson)
  .store(jsonl.memory('memory/fact-lessons.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const quotaEvents = sqlite.quota('.harness/quota.sqlite');
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quotaEvents);
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('review-api', [apiAccount]).serves(opus, sonnet, haiku).policy(policies.soonestReset());

const reviewerRole = H.role('reviewer').promptFile('prompts/reviewer.md').recall(taste, factLesson);

const critiqueSkill = H.skill('critique')
  .input(z.object({ title: z.string(), body: z.string(), section: z.string() }))
  .output(z.object({ points: z.array(z.string()) }))
  .prompt(i => `Section: ${i.section}\n# ${i.title}\n\n${i.body}`);

const reviewerModels: Policy<'models'> = H.policy.models('swap-weaker-reviewer-after-50', choice => {
  const other = [reviewerA, reviewerB].find(s => s.name !== choice.seat.name);
  const byExperience = [...choice.candidates].sort(
    (a, b) => choice.metrics.read(actedOn, choice.seat, b).samples - choice.metrics.read(actedOn, choice.seat, a).samples,
  );
  if (other === undefined) return byExperience;
  const mine = choice.metrics.read(actedOn, choice.seat);
  const theirs = choice.metrics.read(actedOn, other);
  const weaker = mine.samples >= 50 && theirs.samples >= 50 && (mine.value ?? 0) < (theirs.value ?? 0);
  return weaker ? [...byExperience.slice(1), ...byExperience.slice(0, 1)] : byExperience;
});

const reviewerA = H.seat('reviewer-a').role(reviewerRole).skill(critiqueSkill).models(opus, haiku).policy(reviewerModels);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).skill(critiqueSkill).models(sonnet, haiku).policy(reviewerModels);

const local = runners.local({ name: 'local', slots: 4 });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string(), points: z.array(z.string()) }))
  .output(z.object({ issues: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/fact-check'], { stdin: input.body });
    const issues = result.stdout.split('\n').filter(line => line.length > 0);
    const repeats = issues.filter(issue => input.points.some(point => point.includes(issue)));
    for (const repeat of repeats) {
      ctx.remember(factLesson, { rule: `when a draft claims "${repeat}", verify it against a primary source, because reviewers flag it repeatedly` }, { kinds: [draft] });
    }
    return { issues };
  });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.array(z.string()), second: z.array(z.string()), issues: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const points = [...new Set([...input.first, ...input.second])];
    return { merged: [...points.map(p => `- ${p}`), ...input.issues.map(i => `- fact: ${i}`)].join('\n') };
  });

const editorContext = z.object({ title: z.string(), merged: z.string() });
const editorDecision = z.object({
  action: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOn: z.array(z.enum(['first', 'second'])),
  sectionOnly: z.boolean(),
});
type EditorEvent = DecisionEvent<z.infer<typeof editorContext>, z.infer<typeof editorDecision>>;

const editorReview = H.halt('editor-review')
  .context(editorContext)
  .decision(editorDecision)
  .ask(c => `Accept or return "${c.title}"?\n\n${c.merged}`);

const actedOn = H.metric(
  'critique-acted-on',
  H.events.decisions(editorReview).credit([reviewerA, reviewerB], (e, seat) =>
    e.decision.actedOn.includes(seat.name === reviewerA.name ? 'first' : 'second'),
  ),
)
  .rate(e => e.credited)
  .by('seat', 'model')
  .window('90d');

const review = H.flow('review')
  .input(draftSchema)
  .tag(section, s => s.input.section)
  .parallel('critiques', call => ({
    first: call(reviewerA, s => ({ title: s.input.title, body: s.input.body, section: s.input.section })),
    second: call(reviewerB, s => ({ title: s.input.title, body: s.input.body, section: s.input.section })),
  }))
  .step('facts', factCheck, s => ({ body: s.input.body, points: [...s.critiques.first.points, ...s.critiques.second.points] }))
  .step('merge', mergeCritiques, s => ({ first: s.critiques.first.points, second: s.critiques.second.points, issues: s.facts.issues }))
  .halt('editor', editorReview, s => ({ title: s.input.title, merged: s.merge.merged }))
  .when(s => s.editor.action === 'return', f => f.exit('returned'))
  .exit('accepted');

const cmsUrl = H.env('CMS_URL');
const cmsToken = H.env('CMS_TOKEN');

const drafts = H.lane('drafts')
  .of(draft)
  .from(
    rest.poll({
      name: 'cms-drafts',
      baseUrl: cmsUrl,
      token: cmsToken,
      path: '/drafts?status=ready',
      interval: '5m',
      item: draftSchema,
      key: d => d.id,
      data: d => d,
      mode: 'upsert',
    }),
  )
  .store(rest.store({ name: 'cms', baseUrl: cmsUrl, token: cmsToken, path: '/drafts', schema: draftSchema }))
  .handle(review, {
    exits: { accepted, returned },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: reviewFailed },
  });

const revisedDraftReenters = H.trigger('revised-draft-reenters-review')
  .on(H.events.updates(drafts).where(e => e.unit.state === returned.name))
  .do(drafts.move((e: UpdateEvent<Draft>) => e.unit.key, inReview));

const returnNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.events.decisions(editorReview).where(e => e.decision.action === 'return' && e.decision.notes.length > 0))
  .do(
    tasteLog.record((e: EditorEvent) => ({
      content: { rule: e.decision.notes },
      when: e.decision.sectionOnly ? { kinds: [draft], facets: [section.is(e.unit.facets['section'] ?? '')] } : { kinds: [draft] },
    })),
  );

const oldestFirst = H.policy.units('oldest-first', choice =>
  [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()),
);

const editor = claudeCode.client({ name: 'editor' });

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(drafts)
  .journals(tasteLog, factLessons)
  .triggers(revisedDraftReenters, returnNotesBecomeTaste)
  .scheduler(oldestFirst)
  .grants(
    H.grant(
      editor,
      H.ops.work.read,
      H.ops.resolve(editorReview),
      H.ops.memory.read(taste),
      H.ops.memory.curate(taste),
      H.ops.memory.read(factLesson),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
