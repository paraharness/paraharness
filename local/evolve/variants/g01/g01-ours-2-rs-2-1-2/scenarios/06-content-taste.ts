import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { rest } from 'harness-dsl/rest';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const submitted = H.state('submitted').pending();
const returned = H.state('returned').waiting();
const accepted = H.state('accepted').terminal('success');
const stuck = H.state('stuck').terminal('failure');

const draftSchema = z.object({ id: z.string(), section: z.string(), title: z.string(), body: z.string(), revision: z.number() });
const draft = H.work('Draft').schema(draftSchema).states(submitted, returned, accepted, stuck);

const section = H.resource('section');

const taste = H.memory('editorial-taste').content(z.object({ rule: z.string() })).trust('taste').curated();
const factLessons = H.memory('fact-check-experience').content(z.object({ rule: z.string() })).trust('experience');
const tasteJournal = H.journal('editorial-taste').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 12 }));
const factJournal = H.journal('fact-check-experience').of(factLessons).store(jsonl.memory('.harness/fact-check.jsonl')).recall(policies.specificity({ limit: 6 }));

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4').pricing(anthropic.pricing());
const challenger = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('anthropic', [api]).share(api, 1).serves(opus, sonnet, challenger);

const critiqueSchema = z.object({ notes: z.array(z.string()), verdict: z.enum(['publish', 'revise']) });
const critique = H.skill('critique-draft')
  .input(z.object({ title: z.string(), body: z.string(), section: z.string() }))
  .output(critiqueSchema)
  .prompt(i => `Critique this ${i.section} draft, "${i.title}":\n\n${i.body}`);

const reviewerRole = H.role('reviewer').prompt('You critique drafts the way this publication\'s editor would.').recall(taste, factLessons);

const swapWeaker = H.policy.models('swap-weaker-reviewer', c => {
  const other = c.seat.name === reviewerA.name ? reviewerB : reviewerA;
  const primary = c.candidates[0];
  const mine = c.metrics.read(actedOn, c.seat, primary);
  const theirs = c.metrics.read(actedOn, other);
  const weaker = mine.samples >= 50 && theirs.samples >= 50 && (mine.value ?? 0) < (theirs.value ?? 0);
  return weaker ? [...c.candidates].reverse() : c.candidates;
});

const reviewerA = H.seat('reviewer-a').role(reviewerRole).skill(critique).models(opus, challenger).policy(swapWeaker);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).skill(critique).models(sonnet, challenger).policy(swapWeaker);

const editorial = H.halt('editorial')
  .context(z.object({ title: z.string(), merged: z.string() }))
  .decision(z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    scope: z.enum(['all', 'section']),
    actedOn: z.array(z.string()),
  }))
  .ask(c => `Accept or return "${c.title}"?\n\n${c.merged}`);

const actedOn = H.metric('critique-acted-on', H.events.decisions(editorial).where(d => d.resolver === 'human').credit(reviewerA, reviewerB))
  .rate(c => c.event.decision.actedOn.includes(c.seat.name))
  .by('seat', 'model')
  .window('90d');

const cmsUrl = H.env('CMS_URL');
const cmsToken = H.env('CMS_TOKEN');
const cmsRunner = runners.local({ name: 'cms', slots: 4 }).env({ CMS_URL: cmsUrl, CMS_TOKEN: cmsToken });

const factCheck = H.command('fact-check')
  .input(z.object({ body: z.string(), section: z.string() }))
  .output(z.object({ issues: z.array(z.string()) }))
  .runner(cmsRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/fact-check'], { stdin: input.body });
    const issues = result.stdout.split('\n').filter(line => line.length > 0);
    for (const issue of issues.filter(line => line.startsWith('REPEAT: '))) {
      ctx.remember(factLessons, { rule: `When a draft claims ${issue.slice(8)}, verify it against the primary source, because this mistake has been made before.` }, { kinds: [draft], resources: [section.is(input.section)] });
    }
    return { issues };
  });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critiqueSchema, b: critiqueSchema, facts: z.array(z.string()) }))
  .output(z.object({ text: z.string() }))
  .effect('repeatable')
  .run(async input => ({
    text: [
      `## ${reviewerA.name} (${input.a.verdict})`, ...input.a.notes.map(n => `- ${n}`),
      `## ${reviewerB.name} (${input.b.verdict})`, ...input.b.notes.map(n => `- ${n}`),
      '## fact-check', ...input.facts.map(n => `- ${n}`),
    ].join('\n'),
  }));

const returnToAuthor = H.command('return-to-author')
  .input(z.object({ id: z.string(), notes: z.string() }))
  .output(z.object({ returned: z.boolean() }))
  .runner(cmsRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/cms-return', input.id], { stdin: input.notes });
    if (result.code !== 0) throw new Error(result.stderr);
    return { returned: true };
  });

const reviewFlow = H.flow('review')
  .input(draftSchema)
  .tag(section, s => s.input.section)
  .parallel('critiques', call => ({
    a: call(reviewerA, s => ({ title: s.input.title, body: s.input.body, section: s.input.section })),
    b: call(reviewerB, s => ({ title: s.input.title, body: s.input.body, section: s.input.section })),
  }))
  .step('facts', factCheck, s => ({ body: s.input.body, section: s.input.section }))
  .step('merge', mergeCritiques, s => ({ a: s.critiques.a, b: s.critiques.b, facts: s.facts.issues }))
  .halt('editorial', editorial, s => ({ title: s.input.title, merged: s.merge.text }))
  .when(s => s.editorial.action === 'accept', f => f.exit('accepted'))
  .step('sendBack', returnToAuthor, s => ({ id: s.input.id, notes: s.editorial.notes }))
  .exit('returned');

const drafts = H.lane('drafts').of(draft);

const draftLane = drafts
  .from(rest.poll({
    name: 'cms-drafts',
    baseUrl: cmsUrl,
    token: cmsToken,
    path: '/drafts?status=in-review',
    interval: '5m',
    item: draftSchema,
    key: d => d.id,
    data: d => d,
    mode: 'upsert',
  }))
  .store(rest.store({ name: 'cms', baseUrl: cmsUrl, token: cmsToken, path: '/drafts', schema: draftSchema }))
  .handle(reviewFlow, {
    exits: { accepted, returned },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: stuck },
  });

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste')
  .on(H.events.decisions(editorial).where(d => d.decision.action === 'return'))
  .do(tasteJournal.record(d => ({
    content: { rule: d.decision.notes },
    when: d.decision.scope === 'section'
      ? { kinds: [draft], resources: [section.is(d.unit.resources[section.name])] }
      : { kinds: [draft] },
  })));

const revisedDraftResubmits = H.trigger('revised-draft-resubmits')
  .on(H.events.updates(drafts).where(u => u.unit.data.revision !== u.previous.revision))
  .do(drafts.move({ state: returned, where: (data, u) => data.id === u.unit.data.id }, submitted));

const editor = H.grant(
  claudeCode.client({ name: 'editor' }),
  H.ops.work.read,
  H.ops.resolve(editorial),
  H.ops.memory.read(taste),
  H.ops.memory.write(taste),
  H.ops.memory.curate(taste),
  H.ops.memory.read(factLessons),
  H.ops.telemetry.read,
);

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(draftLane)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, revisedDraftResubmits)
  .grants(editor)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
