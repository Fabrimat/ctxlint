// Run with `pnpm build && node evals/run.ts --help`. Dry run by default; see evals/README.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultConfig } from '../dist/config/index.js';
import { Budget, estimateTokens } from '../dist/llm/budget.js';
import { DEFAULT_PRICING, costUsd } from '../dist/llm/pricing.js';
import { createProvider, type LlmProvider } from '../dist/llm/provider.js';
import { buildPrompt, judgeSection, type SectionInput } from '../dist/llm/semantic.js';
import { loadCases, type EvalCase } from './cases.ts';
import { computeMetrics, markdownTable, type JudgedRecord } from './metrics.ts';

// ponytail: keep equal to the output cap judgeSection requests; only the dry-run estimate uses it.
const MAX_TOKENS = 1024;
const CONCURRENCY = 4;

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    provider: { type: 'string', default: 'anthropic' },
    repeats: { type: 'string', default: '3' },
    'max-cost': { type: 'string', default: '5' },
    'dry-run': { type: 'boolean', default: false },
    cases: { type: 'string' },
  },
});

const provider = values.provider === 'openai' ? 'openai' : 'anthropic';
const repeats = Math.max(1, Math.floor(Number(values.repeats)));
const maxCost = Number(values['max-cost']);
if (!Number.isFinite(maxCost) || maxCost < 0 || !Number.isFinite(repeats)) {
  throw new Error('--max-cost and --repeats must be numbers');
}
const models = (
  values.models ?? (provider === 'anthropic' ? 'claude-haiku-5-5,claude-sonnet-5-5' : '')
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
if (models.length === 0) throw new Error('pass --models (OpenAI has no default models)');

const cases = loadCases(undefined, values.cases);
if (cases.length === 0) throw new Error('no case matches --cases');

const hasKey =
  provider === 'openai'
    ? Boolean(process.env['OPENAI_API_KEY'])
    : Boolean(process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN']);
const dryRun = values['dry-run'] || !hasKey;

const toInput = (c: EvalCase): SectionInput => ({
  file: c.section.file,
  path: c.section.path,
  startLine: 1,
  endLine: c.section.body.split('\n').length,
  body: c.section.body,
  files: c.files,
  diff: c.diff,
});

if (dryRun) {
  if (!values['dry-run']) console.log('No API key in the environment: dry run, no calls made.\n');
  const inputTokens = cases.reduce((sum, c) => {
    const { system, prompt } = buildPrompt(toInput(c));
    return sum + estimateTokens(system) + estimateTokens(prompt);
  }, 0);
  console.log(
    `${cases.length} cases x ${repeats} repeats; worst case (max ${MAX_TOKENS} output tokens per call):\n`,
  );
  console.log('| model | calls | input tokens | worst-case cost |\n| --- | --- | --- | --- |');
  let total = 0;
  for (const model of models) {
    const cost = costUsd(DEFAULT_PRICING, model, {
      inputTokens: inputTokens * repeats,
      outputTokens: MAX_TOKENS * cases.length * repeats,
      cacheReadTokens: 0,
    });
    total += cost ?? 0;
    console.log(
      `| ${model} | ${cases.length * repeats} | ${inputTokens * repeats} | ${cost === null ? 'unknown price' : `$${cost.toFixed(4)}`} |`,
    );
  }
  console.log(`\nTotal worst case: $${total.toFixed(4)} (budget ${maxCost} USD)`);
  process.exit(0);
}

interface Job {
  model: string;
  c: EvalCase;
  repeat: number;
}
const jobs: Job[] = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const c of cases) for (const model of models) jobs.push({ model, c, repeat });
}

const llm = { ...defaultConfig.llm, provider } as typeof defaultConfig.llm;
const real = await createProvider(llm, process.env);
const budget = new Budget(maxCost, DEFAULT_PRICING);

interface Done extends JudgedRecord {
  model: string;
  judgement: unknown;
  /** No provider call was made: the budget was reached. */
  skipped: boolean;
}

async function runJob({ model, c, repeat }: Job): Promise<Done> {
  let calls = 0;
  let invalid = false;
  let costSum = 0;
  let latencyMs = 0;
  // Observes every provider call of one judgement (cost, latency, invalid output).
  const spy: LlmProvider = {
    name: real.name,
    async complete(req) {
      const res = await real.complete(req);
      calls++;
      latencyMs += res.latencyMs;
      costSum += (res.usage && costUsd(DEFAULT_PRICING, model, res.usage)) || 0;
      if (!res.ok && res.reason === 'invalid') invalid = true;
      return res;
    },
  } as LlmProvider;
  const judgement = await judgeSection(spy, budget, model, toInput(c));
  return {
    model,
    caseId: c.id,
    repeat,
    label: c.label,
    adversarial: c.adversarial,
    status: judgement.status,
    invalid,
    costUsd: costSum,
    latencyMs,
    judgement,
    skipped: calls === 0 && judgement.status === 'unknown',
  };
}

const done: Done[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) done.push(await runJob(job));
  }),
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(import.meta.dirname, 'results');
mkdirSync(outDir, { recursive: true });
const rows = models.map((model) => {
  const mine = done.filter((d) => d.model === model);
  const metrics = computeMetrics(mine.filter((d) => !d.skipped));
  const skipped = mine.filter((d) => d.skipped).length;
  writeFileSync(
    join(outDir, `${stamp}-${model}.json`),
    JSON.stringify({ model, provider, repeats, maxCost, skipped, metrics, records: mine }, null, 2),
  );
  return { model, metrics, skipped };
});

console.log(markdownTable(rows));
const totals = budget.totals();
console.log(
  `\nSpent ${totals.costUsd === null ? 'unknown' : `$${totals.costUsd.toFixed(4)}`} of ${maxCost} USD in ${totals.calls} calls.`,
);
const skippedTotal = rows.reduce((s, r) => s + r.skipped, 0);
if (skippedTotal > 0) {
  console.log(
    `\nPARTIAL RESULTS: no call was made for ${skippedTotal} of ${jobs.length} judgements (budget reached or input skipped) (excluded from n).`,
  );
}
