import {
  categories,
  evidenceLevels,
  inputIds,
  methods,
  pageTypes,
  ruleStatuses,
  severities,
  type Myth,
  type RuleMeta,
} from '../core/types.ts';

const ruleKeys = new Set([
  'id', 'category', 'title', 'why', 'fix', 'maxSeverity', 'method', 'scope', 'inputs', 'appliesTo', 'exemptWhen',
  'fpRisk', 'scored', 'evidenceLevel', 'thresholds', 'sources', 'status', 'notes', 'related',
]);
const mythKeys = new Set(['id', 'claim', 'reality', 'sources', 'patterns']);
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const isoDate = /^\d{4}-\d{2}-\d{2}$/u;

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function sourcesProblems(where: string, sources: unknown): string[] {
  if (!Array.isArray(sources) || sources.length === 0) return [`${where}: needs at least one source`];
  const problems: string[] = [];
  for (const [index, source] of sources.entries()) {
    const entry = source as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => key !== 'url' && key !== 'verified')) {
      problems.push(`${where}: source ${index} must be { url, verified }`);
      continue;
    }
    let url: URL | undefined;
    try { url = new URL(String(entry.url)); } catch { url = undefined; }
    if (!url || url.protocol !== 'https:') problems.push(`${where}: source ${index} needs an https URL`);
    const verified = String(entry.verified);
    if (!isoDate.test(verified) || Number.isNaN(Date.parse(`${verified}T00:00:00Z`))) {
      problems.push(`${where}: source ${index} needs a YYYY-MM-DD verified date`);
    }
  }
  return problems;
}

/** Returns every problem found in one rule entry; an empty list means the entry is valid. */
export function ruleProblems(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['rule must be an object'];
  const rule = entry as Record<string, unknown>;
  const where = typeof rule.id === 'string' ? rule.id : '(rule without id)';
  const problems: string[] = [];
  for (const key of Object.keys(rule)) if (!ruleKeys.has(key)) problems.push(`${where}: unknown field ${key}`);
  if (!oneOf(categories, rule.category)) problems.push(`${where}: invalid category`);
  if (typeof rule.id !== 'string' || !slug.test(rule.id) || !rule.id.startsWith(`${String(rule.category)}-`)) {
    problems.push(`${where}: id must be <category>-<kebab-slug>`);
  }
  if (!text(rule.title, 120)) problems.push(`${where}: title must be 1-120 characters`);
  if (!text(rule.why, 700)) problems.push(`${where}: why must be 1-700 characters`);
  if (!text(rule.fix, 700)) problems.push(`${where}: fix must be 1-700 characters`);
  if (!oneOf(severities, rule.maxSeverity)) problems.push(`${where}: invalid maxSeverity`);
  if (!oneOf(methods, rule.method)) problems.push(`${where}: invalid method`);
  if (rule.scope !== 'page' && rule.scope !== 'site') problems.push(`${where}: scope must be page or site`);
  if (!Array.isArray(rule.inputs) || rule.inputs.length === 0 || !rule.inputs.every(input => oneOf(inputIds, input))) {
    problems.push(`${where}: inputs must be a non-empty list of known input ids`);
  }
  if (rule.appliesTo !== 'all' && (!Array.isArray(rule.appliesTo) || rule.appliesTo.length === 0
    || !rule.appliesTo.every(type => oneOf(pageTypes, type)))) {
    problems.push(`${where}: appliesTo must be "all" or a non-empty list of page types`);
  }
  if (!Array.isArray(rule.exemptWhen) || !rule.exemptWhen.every(condition => text(condition, 300))) {
    problems.push(`${where}: exemptWhen must be a list of 1-300 character conditions`);
  }
  if (rule.fpRisk !== 'low' && rule.fpRisk !== 'medium' && rule.fpRisk !== 'high') problems.push(`${where}: invalid fpRisk`);
  if (typeof rule.scored !== 'boolean') problems.push(`${where}: scored must be a boolean`);
  if (!oneOf(evidenceLevels, rule.evidenceLevel)) problems.push(`${where}: invalid evidenceLevel`);
  if (!text(rule.thresholds, 900)) problems.push(`${where}: thresholds must be 1-900 characters`);
  problems.push(...sourcesProblems(where, rule.sources));
  if (!oneOf(ruleStatuses, rule.status)) problems.push(`${where}: invalid status`);
  if (rule.notes !== undefined && !text(rule.notes, 1500)) problems.push(`${where}: notes must be 1-1500 characters`);
  if (rule.related !== undefined && (!Array.isArray(rule.related) || !rule.related.every(id => typeof id === 'string' && slug.test(id)))) {
    problems.push(`${where}: related must be a list of rule ids`);
  }
  if ((rule.method === 'ai-judgment') && rule.scored === true) problems.push(`${where}: ai-judgment rules cannot be scored`);
  if ((rule.method === 'owner-data' || rule.method === 'external-api') && rule.status === 'v1'
    && Array.isArray(rule.inputs) && rule.inputs.some(input => input === 'gsc' || input === 'bing' || input === 'bot-activity')) {
    problems.push(`${where}: rules that read owner data use status requires-owner-data`);
  }
  if (rule.maxSeverity === 'info' && rule.scored === true) problems.push(`${where}: info rules cannot be scored`);
  return problems;
}

export function mythProblems(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return ['myth must be an object'];
  const myth = entry as Record<string, unknown>;
  const where = typeof myth.id === 'string' ? `myth ${myth.id}` : '(myth without id)';
  const problems: string[] = [];
  for (const key of Object.keys(myth)) if (!mythKeys.has(key)) problems.push(`${where}: unknown field ${key}`);
  if (typeof myth.id !== 'string' || !slug.test(myth.id)) problems.push(`${where}: id must be a kebab-case slug`);
  if (!text(myth.claim, 300)) problems.push(`${where}: claim must be 1-300 characters`);
  if (!text(myth.reality, 700)) problems.push(`${where}: reality must be 1-700 characters`);
  problems.push(...sourcesProblems(where, myth.sources));
  if (!Array.isArray(myth.patterns) || !myth.patterns.every(pattern => typeof pattern === 'string'
    && pattern === pattern.toLowerCase() && pattern.trim().length >= 3)) {
    problems.push(`${where}: patterns must be lowercase phrases of at least 3 characters`);
  }
  return problems;
}

/** Validates a whole catalog: entry shapes, unique ids and references between rules. */
export function catalogProblems(rules: readonly unknown[], myths: readonly unknown[]): string[] {
  const problems = [...rules.flatMap(ruleProblems), ...myths.flatMap(mythProblems)];
  const ids = new Set<string>();
  for (const rule of rules as Partial<RuleMeta>[]) {
    if (typeof rule.id !== 'string') continue;
    if (ids.has(rule.id)) problems.push(`${rule.id}: duplicate rule id`);
    ids.add(rule.id);
  }
  for (const rule of rules as Partial<RuleMeta>[]) {
    for (const related of rule.related ?? []) if (!ids.has(related)) problems.push(`${rule.id}: related rule ${related} does not exist`);
  }
  const mythIds = new Set<string>();
  for (const myth of myths as Partial<Myth>[]) {
    if (typeof myth.id !== 'string') continue;
    if (mythIds.has(myth.id)) problems.push(`myth ${myth.id}: duplicate myth id`);
    mythIds.add(myth.id);
  }
  return problems;
}
