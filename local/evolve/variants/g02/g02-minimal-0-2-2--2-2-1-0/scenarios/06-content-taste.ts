import { z } from 'zod';
import { H, type EntryFilter, type Model, type SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sections = z.enum(['news', 'sports', 'opinion', 'culture']);
const section = H.facet('section', sections);

const submitted = H.state('submitted', 'pending');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const stalled = H.state('stalled', 'terminal', 'failure');

const draft = H.kind('Draft')
  .data(z.object({
    title: z.string(),
    section: sections,
    body: z.string(),
    editorNotes: z.string().optional(),
  }))
  .states(submitted, returned, accepted, stalled);

const tasteMemory = H.memory('editorTaste', 'taste');
const factMemory = H.memory('factCheckLessons', 'experience');
const tasteJournal = H.journal('tasteJournal', tasteMemory, jsonl.memory('memory/taste.jsonl'));
const experienceJournal = H.journal('experienceJournal', factMemory, jsonl.memory('memory/fact-checking.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const spare = anthropic.model('claude-opus-4-5');
const apiAccount = anthropic.account('editorialApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('editorialPool', [{ account: apiAccount, share: 1 }]);

const local = shell.local('local', { slots: 2 });

const editorial = H.halt(
  'editorialDecision',
  z.object({
    verdict: z.enum(['accept', 'return']),
    notes: z.string(),
    actedOnA: z.boolean(),
    actedOnB: z.boolean(),
  })
).about(z.object({ merged: z.string() }));

const reviewerModel = (name: string, incumbent: Model, mine: EntryFilter, theirs: EntryFilter) =>
  H.policy.model(name, [incumbent, spare], choice => {
    const own = choice.metrics
      .rateBy({ among: editorial.resolved(), count: mine, by: { modelOf: choice.seat } })
      .of(incumbent);
    const rival = choice.metrics.rate({ among: editorial.resolved(), count: theirs });
    if (own.samples < 50 || own.value === null || rival.value === null) return incumbent;
    return own.value < rival.value ? spare : incumbent;
  });

const actedOnA = editorial.resolved({ actedOnA: true });
const actedOnB = editorial.resolved({ actedOnB: true });

const critiqueRole = H.role('critique')
  .input(z.object({ title: z.string(), section: sections, body: z.string(), factCheck: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(input => `Critique this ${input.section} draft, "${input.title}".\n\nFact check:\n${input.factCheck}\n\n${input.body}`);

const reviewerA = H.seat('reviewerA', critiqueRole)
  .model(reviewerModel('reviewerAModel', sonnet, actedOnA, actedOnB))
  .recalls(tasteJournal, experienceJournal);
const reviewerB = H.seat('reviewerB', critiqueRole)
  .model(reviewerModel('reviewerBModel', opus, actedOnB, actedOnA))
  .recalls(tasteJournal, experienceJournal);

const factCheck = H.command('factCheck')
  .input(z.object({ body: z.string() }))
  .output(z.object({ findings: z.string(), repeatMistake: z.string().optional() }))
  .argv(input => ['fact-check', input.body])
  .on(local)
  .recovery('rerun');

const mergeCritiques = H.command('mergeCritiques')
  .input(z.object({ first: z.string(), second: z.string() }))
  .argv(input => ['merge-critiques', input.first, input.second])
  .on(local)
  .recovery('rerun');

const reviewDraft = H.flow('reviewDraft')
  .for(draft)
  .does(async ctx => {
    const { title, section: sectionName, body } = ctx.unit.data;
    const checked = await ctx.run(factCheck, { body });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.repeatMistake !== undefined) {
      await ctx.remember(experienceJournal, {
        text: `When reviewing, verify ${checked.value.repeatMistake} before anything else`,
        because: `the fact check found the same mistake again in "${title}"`,
        when: { roles: [critiqueRole] },
      });
    }
    const input = { title, section: sectionName, body, factCheck: checked.value.findings };
    const first = await ctx.run(reviewerA, input);
    if (!first.ok) return ctx.fail(first.error);
    const second = await ctx.run(reviewerB, input);
    if (!second.ok) return ctx.fail(second.error);
    const merged = await ctx.run(mergeCritiques, { first: first.value.critique, second: second.value.critique });
    if (!merged.ok) return ctx.fail(merged.error);
    const decision = await ctx.halt(editorial, `Review "${title}"`, { merged: merged.value });
    if (decision.verdict === 'accept') return 'accepted';
    await ctx.update({ editorNotes: decision.notes });
    return 'returned';
  });

const cmsToken = H.env('CMS_TOKEN');

const cmsPoll = http.poll(draft, {
  url: 'https://cms.example.com/api/drafts?ready=true',
  every: { minutes: 10 },
  headers: { authorization: cmsToken },
  body: z.object({
    drafts: z.array(z.object({
      id: z.string(),
      title: z.string(),
      section: sections,
      body: z.string(),
      revised: z.boolean(),
    })),
  }),
  read: body =>
    body.drafts.map((item): SupplyOf<typeof draft> =>
      item.revised
        ? { update: item.id, patch: { title: item.title, body: item.body }, state: 'submitted' }
        : { create: { title: item.title, section: item.section, body: item.body }, key: item.id }
    ),
});

const cmsStore = http.store(draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: { authorization: cmsToken },
  stateField: 'review_state',
});

const drafts = H.lane('drafts', draft)
  .handler(reviewDraft)
  .retries(1, { backoff: { first: { minutes: 5 } }, exhausted: 'stalled' })
  .suppliers(cmsPoll)
  .store(cmsStore)
  .facet(section, data => data.section);

const returnedNotesBecomeTaste = H.trigger('returnedNotesBecomeTaste', H.on.enters(draft, 'returned'), (event, act) => {
  const notes = event.unit.data.editorNotes;
  if (notes === undefined) return [];
  return act.remember(tasteJournal, {
    text: `When reviewing ${event.unit.data.section} drafts, ${notes}`,
    because: `the editor returned "${event.unit.data.title}" with this note`,
    status: 'candidate',
    when: { facets: [section.of(event.unit.data.section)] },
  });
});

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolve(editorial),
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

export const contentReview = H.harness('contentReview')
  .ledger(sqlite.ledger('.harness/content.db'))
  .lanes(drafts)
  .pools(pool)
  .triggers(returnedNotesBecomeTaste)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = contentReview.start();
