/**
 * Programmatic API. It is experimental until 1.0: names and shapes may change in minor releases.
 */
export { version } from './version.ts';
export { audit, auditExitCode, type AuditOptions, type AuditResult } from './audit.ts';
export { runAnalysis, type AnalysisOptions } from './ai/run.ts';
export { describeProviders } from './ai/providers.ts';
export { clearCache } from './ai/cache.ts';
export type { ReportAnalysis } from './ai/types.ts';
export { rule, rules, myths } from './catalog/index.ts';
export { mergeAnalysis, type Report } from './report/model.ts';
export { writeReport } from './report/write.ts';
export { compareReports } from './report/compare.ts';
export { verifyTasks, verifyExitCode } from './verify/index.ts';
export { locateFixes } from './source/locate.ts';
export { withBing, fetchBingData, type BingData, type BingRequest } from './owner/bing.ts';
export { collectBotActivity, BotActivityError, type CollectBotActivityOptions } from './owner/bots/collect.ts';
export type { BotActivity } from './owner/bots/activity.ts';
export { botSiteInput } from './owner/bots/site.ts';
