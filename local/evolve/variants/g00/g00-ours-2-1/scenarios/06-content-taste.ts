import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Metric } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { rest } from 'harness-dsl/rest';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const draft = z.object({ id: z.string(), title: z.string(), section: z.string(), body: z.string() });
const critique = z.object({ summary: z.string(), points: z.array(z.string()) });

const submitted = H.state('submitted').pending();
const reviewing = H.state('reviewing').active();
const returned = H.state('returned').waiting();
const accepted = H.state('accepted').terminal('success');
const stalled = H.state('stalled').terminal('failure');

const Draft = H.work('draft').schema(draft).states(submitted, reviewing, returned, accepted, stalled);

const section = H.facet('section');

const editorial = H.halt('editorial-decision')
  .context(z.object({ title: z.string(), section: z.string(), merged: z.string() }))
  .decision(z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.enum(['a', 'b', 'both', 'neither']),
  }))
  .ask(context => `Accept or return "${context.title}" (${context.section})?\n\n${context.merged}`);

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste').curated();
const factLesson = H.memory('fact-lesson').content(z.object({ rule: z.string() })).trust('experience');

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());

const reviewer = H.role('reviewer').promptFile('prompts/reviewer.md').recall(taste, factLesson);
const critiqueDraft = H.skill('critique-draft')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string(), factIssues: z.array(z.string()) }))
  .output(critique)
  .prompt(input => `Critique "${input.title}" for the ${input.section} section.\nKnown fact issues: ${input.factIssues.join('; ')}\n\n${input.body}`);

const editorActedOn = H.events.decisions(editorial).where(event => event.resolver === 'human');
const actedOnA = H.metric('critique-a-acted-on', editorActedOn)
  .rate(event => event.decision.actedOn === 'a' || event.decision.actedOn === 'both')
  .window('30d');
const actedOnB = H.metric('critique-b-acted-on', editorActedOn)
  .rate(event => event.decision.actedOn === 'b' || event.decision.actedOn === 'both')
  .window('30d');

const swapWhenWeaker = (name: string, own: Metric<never>, rival: Metric<never>) =>
  H.policy.models(name, choice => {
    const mine = choice.metrics.read(own);
    const theirs = choice.metrics.read(rival);
    const weaker = mine.samples >= 50 && theirs.samples >= 50 && (mine.value ?? 0) < (theirs.value ?? 0);
    return weaker ? [...choice.candidates].reverse() : [...choice.candidates];
  });

const reviewerA = H.seat('reviewer-a').role(reviewer).skill(critiqueDraft).models(opus, haiku).policy(swapWhenWeaker('reviewer-a-swap', actedOnA, actedOnB));
const reviewerB = H.seat('reviewer-b').role(reviewer).skill(critiqueDraft).models(sonnet, haiku).policy(swapWhenWeaker('reviewer-b-swap', actedOnB, actedOnA));

const factCheck = H.command('fact-check')
  .input(z.object({ section: z.string(), body: z.string() }))
  .output(z.object({ issues: z.array(z.string()), repeats: z.array(z.string()) }))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['fact-check', '--section', input.section, '--json'], { stdin: input.body });
    const issues = result.stdout.split('\n').filter(line => line.startsWith('ISSUE ')).map(line => line.slice(6));
    const repeats = result.stdout.split('\n').filter(line => line.startsWith('REPEAT ')).map(line => line.slice(7));
    repeats.forEach(mistake => ctx.remember(
      factLesson,
      { rule: `When a draft claims "${mistake}", verify it against a primary source, because this mistake has recurred.` },
      { facets: [section.is(input.section)] },
    ));
    return { issues, repeats };
  });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: critique, b: critique }))
  .output(z.object({ merged: z.string() }))
  .effect('repeatable')
  .run(async input => ({
    merged: [`A: ${input.a.summary}`, ...input.a.points.map(point => `- ${point}`), `B: ${input.b.summary}`, ...input.b.points.map(point => `- ${point}`)].join('\n'),
  }));

const review = H.flow('review')
  .input(draft)
  .tag(section, state => state.input.section)
  .step('facts', factCheck, state => ({ section: state.input.section, body: state.input.body }))
  .parallel('critiques', call => ({
    a: call(reviewerA, state => ({ title: state.input.title, section: state.input.section, body: state.input.body, factIssues: state.facts.issues })),
    b: call(reviewerB, state => ({ title: state.input.title, section: state.input.section, body: state.input.body, factIssues: state.facts.issues })),
  }))
  .step('merge', mergeCritiques, state => ({ a: state.critiques.a, b: state.critiques.b }))
  .halt('editor', editorial, state => ({ title: state.input.title, section: state.input.section, merged: state.merge.merged }))
  .when(state => state.editor.verdict === 'return', back => back.exit('returned'))
  .exit('accepted');

const cmsUrl = 'https://cms.example.com/api';
const cmsToken = H.env('CMS_TOKEN');

const drafts = H.lane('drafts').of(Draft)
  .from(rest.poll({
    name: 'cms-drafts',
    baseUrl: cmsUrl,
    token: cmsToken,
    path: '/drafts?status=ready-for-review',
    interval: '5m',
    item: draft,
    key: item => item.id,
    data: item => item,
    mode: 'upsert',
  }))
  .store(rest.store({ name: 'cms', baseUrl: cmsUrl, token: cmsToken, path: '/drafts', schema: draft }))
  .handle(review, {
    exits: { accepted, returned },
    retry: { retries: 2, backoff: { initial: '2m', factor: 2 }, exhausted: stalled },
  });

const tasteJournal = H.journal('taste-journal').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 12 }));
const factJournal = H.journal('fact-lesson-journal').of(factLesson).store(jsonl.memory('.harness/fact-lessons.jsonl')).recall(policies.specificity({ limit: 6 }));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.events.decisions(editorial).where(event => event.decision.verdict === 'return' && event.decision.notes.trim().length > 0))
  .do(tasteJournal.record(event => ({
    content: { rule: event.decision.notes },
    when: { kinds: [Draft], facets: [section.is(event.context.section)] },
  })));

const revisedDraftReenters = H.trigger('revised-draft-reenters-review')
  .on(H.events.updates(drafts).where(event => event.unit.state === returned.name && event.unit.data.body !== event.previous.body))
  .do(drafts.move(event => event.unit.key, submitted));

const oldestFirst = H.policy.units('oldest-first', choice =>
  [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

const editor = claudeCode.client({ name: 'editor' });

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(H.pool('api', [apiAccount]).serves(opus, sonnet, haiku))
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, revisedDraftReenters)
  .scheduler(oldestFirst)
  .grants(H.grant(
    editor,
    H.ops.work.read,
    H.ops.resolve(editorial),
    H.ops.memory.write(taste),
    H.ops.memory.curate(taste),
    H.ops.memory.read(factLesson),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export default harness;
