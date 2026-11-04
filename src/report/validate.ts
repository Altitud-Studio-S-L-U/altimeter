import { dropReasons, type AiFinding, type CallRecord, type DroppedClaim, type PassId, type ProviderName, type ProviderSummary, type Role } from '../ai/types.ts';
import { rule as catalogRule } from '../catalog/index.ts';
import { categories, fixLocations, inputIds, outcomes, pageTypes, severities, verifications } from '../core/types.ts';
import { languages } from '../i18n/messages.ts';
import type { Finding } from '../rules/engine.ts';
import type { Score } from '../score/score.ts';
import { reportSchemaVersion, type Report } from './model.ts';
import { taskIdPattern, type FileCandidate } from './tasks.ts';

/**
 * A report.json that render, compare and verify read back may have been edited, or written by someone else, and its
 * values become file names, report text and terminal output. Each value must have the shape Altimeter writes: task
 * ids that name a file in tasks/, rules of this catalog, the known values of every enumeration and finite numbers.
 * Fields Altimeter does not write are left alone.
 */

type Check = (value: unknown, at: string) => void;

function fail(at: string, expected: string): never {
  throw new Error(`${at} must be ${expected}`);
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The members of a string union, written as keys so that the compiler checks the list is complete. */
const membersOf = <T extends string>(members: Readonly<Record<T, true>>): readonly string[] => Object.keys(members);

const oneOf = (values: readonly (string | number)[]): Check => (value, at) => {
  if (!values.includes(value as string | number)) fail(at, values.length <= 8 ? `one of ${values.join(', ')}` : 'a value Altimeter writes there');
};

const text: Check = (value, at) => {
  if (typeof value !== 'string') fail(at, 'a string');
};

const matching = (pattern: RegExp, expected: string): Check => (value, at) => {
  if (typeof value !== 'string' || !pattern.test(value)) fail(at, expected);
};

const flag: Check = (value, at) => {
  if (typeof value !== 'boolean') fail(at, 'true or false');
};

const number = (low: number, high: number, whole: boolean, expected: string): Check => (value, at) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (whole && !Number.isInteger(value))) fail(at, expected);
};

const count = number(0, Number.MAX_SAFE_INTEGER, true, 'a whole number of 0 or more');
const positive = number(1, Number.MAX_SAFE_INTEGER, true, 'a whole number of 1 or more');
const amount = number(0, Number.MAX_VALUE, false, 'a finite number of 0 or more');
const percent = number(0, 100, false, 'a number from 0 to 100');
const httpStatus = number(0, 999, true, 'a whole number from 0 to 999');

const nullable = (check: Check): Check => (value, at) => {
  if (value !== null) check(value, at);
};

const list = (item: Check): Check => (value, at) => {
  if (!Array.isArray(value)) fail(at, 'a list');
  value.forEach((entry, index) => item(entry, `${at}[${index}]`));
};

const field = (at: string, name: string) => (at === '' ? name : `${at}.${name}`);

const shape = (required: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): Check => (value, at) => {
  if (!isObject(value)) fail(at === '' ? 'the report' : at, 'an object');
  for (const [name, check] of Object.entries(required)) check(value[name], field(at, name));
  for (const [name, check] of Object.entries(optional)) if (value[name] !== undefined) check(value[name], field(at, name));
};

const entries = (key: Check, item: Check): Check => (value, at) => {
  if (!isObject(value)) fail(at, 'an object');
  for (const [name, entry] of Object.entries(value)) {
    key(name, `each key of ${at}`);
    item(entry, field(at, name));
  }
};

const ruleId: Check = (value, at) => {
  if (typeof value !== 'string' || catalogRule(value) === undefined) fail(at, 'the id of a rule in the catalog of this Altimeter version');
};

function webUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
}

const pageUrl: Check = (value, at) => {
  if (webUrl(value) === undefined) fail(at, 'an http or https URL');
};

const origin: Check = (value, at) => {
  if (webUrl(value)?.origin !== value) fail(at, 'an http or https origin, such as https://example.com');
};

/** Reports write source URLs as autolinks, which end at a space or an angle bracket. */
const sourceUrl: Check = (value, at) => {
  if (webUrl(value) === undefined || !/^https?:\/\/[^\s<>\p{Cc}]+$/u.test(value as string)) fail(at, 'an http or https URL without spaces or angle brackets');
};

const utcTime: Check = (value, at) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(at, 'a UTC time such as 2026-11-04T10:00:00.000Z');
};

const day = matching(/^\d{4}-\d{2}-\d{2}$/u, 'a date such as 2026-11-04');
const version = matching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u, 'a version such as 1.2.3');

const pageScope = shape({ url: pageUrl });
const siteScope = shape({ origin });
const scope: Check = (value, at) => {
  const kind = isObject(value) ? value.kind : undefined;
  if (kind === 'page') pageScope(value, at);
  else if (kind === 'site') siteScope(value, at);
  else fail(at, 'a page or a site scope');
};

const paramValue: Check = (value, at) => {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail(at, 'a string or a finite number');
};
const params = entries(text, paramValue);

const option: Check = (value, at) => {
  if (typeof value !== 'boolean') paramValue(value, at);
};

const confidences = membersOf<Finding['confidence']>({ high: true, medium: true, low: true });
const judgments = membersOf<NonNullable<Finding['judgment']>>({ confirmed: true, dismissed: true });
const verificationStates = membersOf<AiFinding['verification']>({ supported: true, partial: true, unverified: true });
const passIds = membersOf<PassId>({ content: true, serp: true, schema: true, intl: true });
const roles = membersOf<Role>({ analyst: true, verifier: true });
const providerNames = membersOf<ProviderName>({ claude: true, codex: true });

const evidenceItem = shape(
  { id: matching(/^[EA][1-9]\d*$/u, 'an evidence id such as E12'), kind: text, label: text, complete: flag },
  { url: text, labelParts: list(shape({ template: text }, { params })), excerpt: text, line: count, path: text },
);

const findingFields = {
  id: text, ruleId, category: oneOf(categories), title: text, scope, outcome: oneOf(outcomes), evidence: list(text), evidenceSignature: text, confidence: oneOf(confidences),
};
const findingOptions = { severity: oneOf(severities), reason: text, params, needsJudgment: flag, judgment: oneOf(judgments), message: text };

const reportFinding = shape({ ...findingFields, origin: oneOf(membersOf<Finding['origin']>({ deterministic: true, ai: true, 'owner-data': true })) }, findingOptions);

const check = shape({ ruleId, scope });
const task = shape({
  id: matching(taskIdPattern, 'a task id: T- followed by 10 lowercase hexadecimal digits'),
  ruleId, category: oneOf(categories), title: text, severity: oneOf(severities), priority: positive, scopes: list(scope), problem: text, desired: text,
  evidence: list(text), fixLocation: oneOf(fixLocations), verifiableBy: oneOf(verifications), agentReady: flag, acceptance: list(check), mustRemainPassing: list(check),
  sources: list(shape({ url: sourceUrl, verified: day })),
}, {
  reason: text, params, mustNotChange: list(text),
  files: list(shape({ path: text, confidence: oneOf(membersOf<FileCandidate['confidence']>({ high: true, medium: true, low: true })), reason: text })),
});

const score = shape({
  overall: nullable(percent),
  categories: list(shape({ category: oneOf(categories), score: nullable(percent), evaluated: count, failed: count, notEvaluated: count, notApplicable: count })),
  indexability: oneOf(membersOf<Score['indexability']>({ pass: true, fail: true, unknown: true })),
  formula: text,
});

const notes = shape({ en: text, es: text, ca: text });
const provider = shape({ name: oneOf(providerNames), cliVersion: text, verifiedVersion: flag, source: oneOf(membersOf<ProviderSummary['source']>({ env: true, path: true, app: true })) }, { model: text });

const call = shape({
  id: text, role: oneOf(roles), pass: oneOf(passIds), pages: list(text), durationMs: amount, promptChars: count, estimatedTokens: count,
  status: oneOf(membersOf<CallRecord['status']>({ ok: true, cached: true, failed: true, skipped: true, planned: true })),
}, {
  provider: oneOf(providerNames), cliVersion: text, model: text, error: shape({ code: text, message: text }), costUsd: amount,
  usage: shape({}, { inputTokens: amount, outputTokens: amount, cachedInputTokens: amount }),
});

const aiFinding = shape({
  ...findingFields, origin: oneOf(['ai']), pass: oneOf(passIds), verdict: oneOf(membersOf<AiFinding['verdict']>({ confirmed: true, likely: true, not_confirmed: true })),
  quotes: list(shape({ evidenceId: text, text })), notes, verification: oneOf(verificationStates),
}, { ...findingOptions, candidateId: text, adjustments: list(text) });

const serpProposal = shape({ pass: oneOf(['serp']), scope: text, text, language: text, evidenceIds: list(text), notes, placeholders: count }, { current: text });
const jsonLdProposal = shape({ pass: oneOf(['schema']), scope: text, jsonLd: text, evidenceIds: list(text), notes, placeholders: count });
const proposal: Check = (value, at) => {
  const kind = isObject(value) ? value.kind : undefined;
  if (kind === 'json-ld') jsonLdProposal(value, at);
  else if (kind === 'title' || kind === 'meta-description') serpProposal(value, at);
  else fail(at, 'a title, meta-description or json-ld proposal');
};

const analysis = shape({
  schemaVersion: oneOf([1]),
  provider: shape({}, { analyst: provider, verifier: provider }),
  pages: list(text),
  calls: list(call),
  costUsd: amount,
  findings: list(aiFinding),
  unverified: list(aiFinding),
  proposals: list(proposal),
  assessments: list(shape({ page: text })),
  confirmations: list(shape({ candidateId: text, ruleId, scope, decision: oneOf(judgments), findingId: text, verification: oneOf(verificationStates) })),
  dropped: list(shape({
    pass: oneOf(passIds), role: oneOf(roles), reason: oneOf(dropReasons), claim: shape({}),
    kind: oneOf(membersOf<DroppedClaim['kind']>({ answer: true, finding: true, proposal: true, assessment: true })),
  }, { page: text, ruleId: text, detail: text })),
  skipped: list(shape({ pass: oneOf(passIds), page: text, reason: text })),
  injectionCandidates: list(shape({ ruleId: oneOf(['ai-hidden-llm-instructions']), page: text, evidenceId: text, where: text, pattern: text, excerpt: text, visible: flag })),
  evidence: list(evidenceItem),
  warnings: list(text),
});

const reportShape = shape({
  schemaVersion: oneOf([reportSchemaVersion]),
  tool: shape({ name: oneOf(['altimeter']), version }),
  catalog: shape({ hash: matching(/^[0-9a-f]{64}$/u, 'a SHA-256 digest in lowercase hexadecimal'), rules: count, implemented: count }),
  run: shape({
    startedAt: utcTime, durationMs: amount, language: oneOf(languages), versions: shape({ node: version }, { chrome: text, lighthouse: text }),
    options: entries(text, option), warnings: list(text),
  }),
  target: shape({ url: pageUrl, finalUrl: text, origin }),
  pages: list(shape({ url: text, finalUrl: text, pageType: oneOf(pageTypes), pageTypeReason: text, rendered: flag, lighthouse: flag }, { status: httpStatus })),
  coverage: shape({ implemented: count, evaluated: count, notEvaluated: count, notApplicable: count, missingInputs: entries(oneOf(inputIds), count) }),
  score,
  findings: list(reportFinding),
  evidence: list(evidenceItem),
  tasks: list(task),
}, { ai: analysis });

/** A parsed report.json as a Report; the error names the first value without the shape Altimeter writes. */
export function validateReport(value: unknown): Report {
  reportShape(value, '');
  return value as Report;
}
