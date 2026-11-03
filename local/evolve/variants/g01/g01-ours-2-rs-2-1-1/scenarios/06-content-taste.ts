import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Policy } from 'harness-dsl';
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
const failed = H.state('failed').terminal('failure');

const draft = z.object({ id: z.string(), title: z.string(), section: z.string(), body: z.string(), revision: z.number() });
const Draft = H.work('Draft').schema(draft).states(submitted, returned, accepted, failed);

const sections = [H.resource('sports'), H.resource('opinion')];
const sectionOf = (name: string) => sections.filter(section => section.name === name);

const taste = H.memory('editor-taste').content(z.object({ preference: z.string() })).trust('taste').curated();
const factLessons = H.memory('fact-check-lessons')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const challenger = H.model('claude-opus-4-5').pricing(anthropic.pricing());

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const apiPool = H.pool('anthropic', [apiAccount]).serves(opus, sonnet, challenger);

const reviewerRole = H.role('reviewer')
  .prompt('Critique the draft for the editor: argument, accuracy, house style.')
  .intents([])
  .recall(taste, factLessons);
const critiqueSkill = H.skill('critique')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ critique: z.string(), issues: z.array(z.string()) }))
  .prompt(input => `Section: ${input.section}\nTitle: ${input.title}\n\n${input.body}`);

const actedOnSamples = 50;

const reviewerModels: Policy<'models'> = H.policy.models('swap-weaker-reviewer', choice => {
  const self = choice.seat === reviewerA.name ? reviewerA : reviewerB;
  const other = self === reviewerA ? reviewerB : reviewerA;
  const mine = choice.metrics.read(critiqueActedOn, self);
  const theirs = choice.metrics.read(critiqueActedOn, other);
  const weaker =
    mine.samples >= actedOnSamples && theirs.samples >= actedOnSamples && (mine.value ?? 0) < (theirs.value ?? 0);
  return weaker ? [...choice.candidates].reverse() : choice.candidates;
});

const reviewerA = H.seat('reviewer-a').role(reviewerRole).skill(critiqueSkill).models(opus, challenger).policy(reviewerModels);
const reviewerB = H.seat('reviewer-b').role(reviewerRole).skill(critiqueSkill).models(sonnet, challenger).policy(reviewerModels);

const editorReview = H.halt('editor-review')
  .context(z.object({ title: z.string(), section: z.string(), merged: z.string(), critiqueA: z.string(), critiqueB: z.string() }))
  .decision(z.object({
    action: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOn: z.array(z.enum([reviewerA.name, reviewerB.name])),
  }))
  .ask(context => `${context.title} (${context.section})\n\n${context.merged}`);

const critiqueActedOn = H.metric('critique-acted-on', H.events.decisions(editorReview))
  .rate(event => event.decision.actedOn.some(name => name === event.seat))
  .by('seat')
  .window('30d');

const local = runners.local({ name: 'local', slots: 4 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.array(z.string()), b: z.array(z.string()) }))
  .output(z.object({ merged: z.string() }))
  .effect('repeatable')
  .run(async input => {
    const issues = [...new Set([...input.a, ...input.b])];
    return { merged: issues.map(issue => `- ${issue}`).join('\n') };
  });

const factCheck = H.command('fact-check')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ problems: z.array(z.string()), repeats: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['factcheck', '--json'], { stdin: input.body });
    const parsed = z.object({ problems: z.array(z.string()), repeats: z.array(z.string()) }).parse(JSON.parse(result.stdout));
    for (const repeat of parsed.repeats) {
      ctx.remember(factLessons, {
        do: `verify "${repeat}" against a primary source`,
        when: 'a draft repeats a claim of this kind',
        because: `the same mistake recurred in "${input.title}"`,
      });
    }
    return parsed;
  });

const review = H.flow('review-draft')
  .input(draft)
  .resources(input => sectionOf(input.section).map(section => section.shared()))
  .parallel('reviews', call => ({
    a: call(reviewerA, state => ({ title: state.input.title, section: state.input.section, body: state.input.body })),
    b: call(reviewerB, state => ({ title: state.input.title, section: state.input.section, body: state.input.body })),
  }))
  .step('facts', factCheck, state => ({ title: state.input.title, body: state.input.body }))
  .step('merge', mergeCritiques, state => ({
    a: [...state.reviews.a.issues, ...state.facts.problems],
    b: state.reviews.b.issues,
  }))
  .halt('editor', editorReview, state => ({
    title: state.input.title,
    section: state.input.section,
    merged: state.merge.merged,
    critiqueA: state.reviews.a.critique,
    critiqueB: state.reviews.b.critique,
  }))
  .when(state => state.editor.action === 'return', sendBack => sendBack.exit('returned'))
  .exit('accepted');

const cmsUrl = H.env('CMS_URL');
const cmsToken = H.env('CMS_TOKEN');

const drafts = H.lane('drafts').of(Draft)
  .from(rest.poll({
    name: 'cms-ready-drafts',
    baseUrl: cmsUrl,
    token: cmsToken,
    path: '/drafts?status=ready',
    interval: '5m',
    item: draft,
    key: item => item.id,
    data: item => item,
  }))
  .store(rest.store({ name: 'cms', baseUrl: cmsUrl, token: cmsToken, path: '/drafts', schema: draft }))
  .handle(review, {
    exits: { accepted, returned },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: failed },
  });

const tasteJournal = H.journal('editor-taste').of(taste)
  .store(jsonl.memory('.harness/editor-taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));
const factJournal = H.journal('fact-check-lessons').of(factLessons)
  .store(jsonl.memory('.harness/fact-check-lessons.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const returnedNotesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(H.events.decisions(editorReview).where(event => event.decision.action === 'return' && event.decision.notes.length > 0))
  .do(tasteJournal.record(event => ({
    content: { preference: event.decision.notes },
    when: { resources: sectionOf(event.context.section) },
  })));

const resubmittedDraftReenters = H.trigger('resubmitted-draft-reenters')
  .on(H.events.updates(drafts).where(event => event.unit.state === returned.name && event.unit.data.revision > event.previous.revision))
  .do(drafts.move(event => event.unit.key, submitted));

const oldestFirst = H.policy.units('oldest-first', choice =>
  [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

const editor = claudeCode.client({ name: 'editor' });

export const contentReview = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(returnedNotesBecomeTaste, resubmittedDraftReenters)
  .scheduler(oldestFirst)
  .grants(H.grant(
    editor,
    H.ops.work.read,
    H.ops.resolve(editorReview),
    H.ops.memory.read(taste),
    H.ops.memory.write(taste),
    H.ops.memory.curate(taste),
    H.ops.telemetry.read,
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void contentReview.start();
