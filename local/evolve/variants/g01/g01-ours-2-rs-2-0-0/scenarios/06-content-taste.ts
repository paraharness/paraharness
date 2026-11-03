import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SeatPolicyInput, ModelRef } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const submitted = H.state('submitted').pending();
const inReview = H.state('in-review').active();
const accepted = H.state('accepted').terminal('success');
const returned = H.state('returned').terminal('failure');
const reviewFailed = H.state('review-failed').terminal('failure');

const draftSchema = z.object({ id: z.string(), title: z.string(), section: z.string(), body: z.string() });
const draft = H.work('draft').schema(draftSchema).states(submitted, inReview, accepted, returned, reviewFailed);

const sports = H.resource('sports');
const opinion = H.resource('opinion');
const sectionScope = (section: string) => [sports, opinion].filter(resource => resource.name === section);

const taste = H.memory('editorial-taste')
  .content(z.object({ prefer: z.string(), because: z.string() }))
  .trust('taste');
const factLesson = H.memory('fact-check-lesson')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const tasteJournal = H.journal('editorial-taste-journal')
  .of(taste)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));
const factJournal = H.journal('fact-check-journal')
  .of(factLesson)
  .store(jsonl.store('memory/fact-check.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const opus41 = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet45 = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus4 = H.model('claude-opus-4').pricing(anthropic.pricing());

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const pool = H.pool('api', [apiAccount]).serves(opus41, sonnet45, opus4).policy(policies.soonestExpiring());

const reviewerRole = H.role('reviewer').promptFile('prompts/reviewer.md').intents(['read']).recall(taste, factLesson);

function chooseReviewerModel(input: SeatPolicyInput): readonly ModelRef[] {
  const rival = input.seat === firstReviewer ? secondReviewer : firstReviewer;
  const rivalReading = input.metrics.read(actedOn, { window: '60d', where: { seat: rival } });
  const kept = input.candidates.find(model => {
    const own = input.metrics.read(actedOn, { window: '60d', where: { seat: input.seat, model } });
    if (own.samples < 50 || rivalReading.samples < 50) return true;
    return (own.value ?? 0) >= (rivalReading.value ?? 0);
  });
  return kept === undefined ? input.candidates.slice(-1) : [kept];
}

const abPolicy = H.policy.seat('editor-acted-on', chooseReviewerModel);
const firstReviewer = H.seat('first-reviewer').role(reviewerRole).models(opus41, opus4).policy(abPolicy);
const secondReviewer = H.seat('second-reviewer').role(reviewerRole).models(sonnet45, opus4).policy(abPolicy);

const critique = H.skill('critique')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ points: z.array(z.string()) }))
  .prompt(input => `Critique this ${input.section} draft titled "${input.title}":\n\n${input.body}`);

const local = H.runner.local('local', { slots: 4 });
const cmsUrl = H.env('CMS_URL');
const cmsToken = H.env('CMS_TOKEN');

const factCheck = H.command('fact-check')
  .input(z.object({ draftId: z.string(), body: z.string() }))
  .output(z.object({ issues: z.array(z.string()) }))
  .runner(local)
  .run(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(H.env('FACT_CHECK_URL'))}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: input.draftId, body: input.body }),
    });
    const result = z.object({ issues: z.array(z.object({ text: z.string(), repeat: z.boolean(), lesson: z.string() })) }).parse(await response.json());
    for (const issue of result.issues.filter(found => found.repeat)) {
      await ctx.record(factJournal, {
        content: { do: issue.lesson, when: 'reviewing claims of this sort', because: `the same mistake recurred: ${issue.text}` },
        when: { roles: [reviewerRole] },
      });
    }
    return { issues: result.issues.map(found => found.text) };
  });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ first: z.array(z.string()), second: z.array(z.string()), facts: z.array(z.string()) }))
  .output(z.object({ items: z.array(z.object({ source: z.enum(['first', 'second', 'facts']), text: z.string() })) }))
  .runner(local)
  .run(async input => {
    const seen = new Set<string>();
    const items: { source: 'first' | 'second' | 'facts'; text: string }[] = [];
    const add = (source: 'first' | 'second' | 'facts', text: string) => {
      const normal = text.trim().toLowerCase();
      if (seen.has(normal)) return;
      seen.add(normal);
      items.push({ source, text });
    };
    input.first.forEach(text => add('first', text));
    input.second.forEach(text => add('second', text));
    input.facts.forEach(text => add('facts', text));
    return { items };
  });

const editorDecision = H.halt('editor-decision')
  .context(z.object({
    draftId: z.string(),
    title: z.string(),
    section: z.string(),
    items: z.array(z.object({ source: z.enum(['first', 'second', 'facts']), text: z.string() })),
  }))
  .ask(context => `Accept or return "${context.title}"?\n\n${context.items.map(item => `- [${item.source}] ${item.text}`).join('\n')}`)
  .decision(z.object({
    accept: z.boolean(),
    notes: z.string(),
    actedOn: z.array(z.enum(['first', 'second'])),
  }));

const review = H.flow('review')
  .input(draftSchema)
  .resources(s => sectionScope(s.input.section))
  .step('first', firstReviewer.call(critique), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('second', secondReviewer.call(critique), s => ({ title: s.input.title, section: s.input.section, body: s.input.body }))
  .step('factCheck', factCheck, s => ({ draftId: s.input.id, body: s.input.body }))
  .step('merge', mergeCritiques, s => ({ first: s.steps.first.points, second: s.steps.second.points, facts: s.steps.factCheck.issues }))
  .halt('edit', editorDecision, s => ({ draftId: s.input.id, title: s.input.title, section: s.input.section, items: s.steps.merge.items }))
  .exit(s => (s.steps.edit.accept ? 'accepted' : 'returned'));

const actedOn = H.metric('critique-acted-on').rate(
  H.events.decisions(editorDecision, {
    credit: decision => decision.actedOn.map(which => (which === 'first' ? firstReviewer : secondReviewer)),
  }),
  H.events.decisions(editorDecision),
);
const acceptance = H.metric('draft-acceptance').rate(H.events.entered(accepted), H.events.terminal());

const reviewDraft = H.handler('review-draft')
  .of(draft)
  .flow(review)
  .exits({ accepted, returned })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: reviewFailed });

const storedDraft = z.object({ data: draftSchema, state: z.string() });

const cmsStore = http.store({
  load: async (unit, ctx) => {
    const response = await fetch(`${ctx.resolve(cmsUrl)}/drafts/${unit.key}/review`, {
      headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` },
    });
    if (response.status === 404) return undefined;
    return storedDraft.parse(await response.json());
  },
  save: async (unit, change, ctx) => {
    await fetch(`${ctx.resolve(cmsUrl)}/drafts/${unit.key}/review`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify(change),
    });
  },
});

const drafts = H.lane('drafts', reviewDraft)
  .from(supply.poll({
    every: '5m',
    fetch: async ctx => {
      const response = await fetch(`${ctx.resolve(cmsUrl)}/drafts?status=ready-for-review`, {
        headers: { authorization: `Bearer ${ctx.resolve(cmsToken)}` },
      });
      return z.array(draftSchema).parse(await response.json());
    },
  }).key(data => data.id))
  .store(cmsStore)
  .wip(3);

const notesBecomeTaste = H.trigger('returned-notes-become-taste-candidates')
  .on(editorDecision.resolved())
  .when(p => p.decision.accept === false && p.decision.notes.trim().length > 0)
  .do(tasteJournal.record(p => ({
    content: { prefer: p.decision.notes, because: `the editor returned "${p.context.title}" with these notes` },
    status: 'candidate',
    when: { kinds: [draft], resources: sectionScope(p.context.section) },
  })));

const editor = claudeCode.client('editor');
const editorGrant = H.grant(
  editor,
  H.ops.work.read,
  H.ops.resolve(editorDecision),
  H.ops.memory.write(tasteJournal),
  H.ops.memory.curate(tasteJournal, factJournal),
  H.ops.telemetry.read,
);

export const harness = H.harness('content-review')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(drafts)
  .journals(tasteJournal, factJournal)
  .triggers(notesBecomeTaste)
  .grants(editorGrant)
  .metrics(actedOn, acceptance)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
