export { check } from './run.js';
export type { CheckOptions } from './run.js';
export { defineConfig } from './config/index.js';
export type { Config, UserConfig } from './config/index.js';
export { formatReport } from './report/index.js';
export type { Format } from './report/index.js';
export type { Claim, CheckResult, Finding, Report, Severity } from './types.js';
export { blameSchema, historyEpisodeSchema, historySchema, reportSchema } from './schema/index.js';
export { definePlugin } from './plugin/types.js';
export type {
  CtxtruthPlugin,
  PluginCheck,
  PluginClaim,
  PluginContext,
  PluginIndex,
  Verdict,
} from './plugin/types.js';
