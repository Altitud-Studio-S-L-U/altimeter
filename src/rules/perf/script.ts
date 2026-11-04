import type { RuleImplementation, RuleResult } from '../engine.ts';
import { summarizeList } from '../helpers.ts';
import {
  auditEvidence, auditOf, auditRan, consentEntity, elements, firstParty, formatKib, formatMs, hostOf, isRecord, kib, labEvidence, labOf,
  networkRequests, notApplicable, notEvaluated, num, rows, str,
} from './shared.ts';

const longTaskMs = 50;
/** Blocking time beyond 50 ms per task that Lighthouse's mobile TBT scoring treats as the median (600 ms). */
const blockingLimitMs = 600;

export const longTasks: RuleImplementation = {
  id: 'perf-long-tasks',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'long-tasks');
    if (!auditRan(audit)) return notEvaluated('no-long-tasks-audit');
    const tasks = rows(audit.details).filter(row => (num(row.duration) ?? 0) > longTaskMs);
    const blocking = tasks.reduce((sum, row) => sum + num(row.duration)! - longTaskMs, 0);
    const cited = labEvidence(evidence, page!, summary, 'long-tasks', 'lab long tasks on the main thread', `${tasks.length} tasks over ${longTaskMs} ms; blocking portion ${Math.round(blocking)} ms`);
    if (blocking <= blockingLimitMs) return { outcome: 'pass', evidence: [cited] };
    const scripts = rows(auditOf(summary, 'bootup-time')?.details).filter(row => str(row.url) && (num(row.total) ?? 0) > 0)
      .sort((a, b) => num(b.total)! - num(a.total)!).slice(0, 3);
    const top = scripts.map(row => `${str(row.url)} (${firstParty(str(row.url)!, page!) ? 'first party' : 'third party'}, ${formatMs(num(row.total)!)})`);
    const extra = scripts.length > 0 ? [labEvidence(evidence, page!, summary, 'bootup-time', 'scripts with the most lab execution time', top.join('; '))] : [];
    return { outcome: 'fail', severity: 'medium', evidence: [cited, ...extra], params: { count: tasks.length, blocking: formatMs(blocking), scripts: top.length > 0 ? top.join('; ') : 'not attributed' } };
  },
};

export const forcedReflow: RuleImplementation = {
  id: 'perf-forced-reflow',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'forced-reflow-insight');
    if (!auditRan(audit) || audit.score === null) return notEvaluated('no-forced-reflow-insight');
    const cited = auditEvidence(evidence, page!, summary, 'forced-reflow-insight', 'Lighthouse forced reflow insight');
    if (audit.score !== 0) return { outcome: 'pass', evidence: [cited] };
    const sources = rows(audit.details).map(row => (isRecord(row.source) ? str(row.source.url) : undefined) ?? str(row.url)).filter((url): url is string => Boolean(url));
    const unique = [...new Set(sources)];
    const extra = unique.length > 0 ? [labEvidence(evidence, page!, summary, 'forced-reflow-insight', 'scripts that forced a synchronous layout', unique.slice(0, 5).join('; '))] : [];
    return { outcome: 'fail', severity: 'low', evidence: [cited, ...extra], params: { sources: unique.length > 0 ? summarizeList(unique) : 'not attributed' } };
  },
};

/** Element counts from the legacy dom-size audit that web.dev cites: a warning from 800, a problem above 1400. */
const domWarn = 800;
const domLimit = 1400;

export const domSize: RuleImplementation = {
  id: 'perf-dom-size',
  evaluate({ page, evidence }) {
    const count = elements(page!.rendered).length;
    const cited = evidence.add({ kind: 'render', url: page!.url, label: 'elements in the rendered DOM', excerpt: String(count) });
    const summary = labOf(page);
    const insight = auditOf(summary, 'dom-size-insight');
    const costly = summary !== undefined && insight?.scoreDisplayMode === 'informative';
    const lab = costly ? [auditEvidence(evidence, page!, summary, 'dom-size-insight', 'Lighthouse DOM size insight')] : [];
    if (count > domLimit) return { outcome: 'fail', severity: 'low', evidence: [cited, ...lab], params: { count } };
    if (count > domWarn) return { outcome: 'fail', severity: 'info', reason: 'warn', evidence: [cited, ...lab], params: { count } };
    // Lighthouse shows an informative insight without failing it: one slow layout on a small DOM is context, not a defect.
    if (costly) return { outcome: 'fail', severity: 'info', reason: 'costly-rendering', evidence: [cited, ...lab], params: { count } };
    return { outcome: 'pass', evidence: [cited] };
  },
};

const entityMainThreadMs = 250;
const entityBytes = 100 * kib;

export const thirdPartyCost: RuleImplementation = {
  id: 'perf-third-party-cost',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audit = auditOf(summary, 'third-parties-insight');
    if (!auditRan(audit)) return notEvaluated('no-third-parties-insight');
    const entities = rows(audit.details).filter(row => str(row.entity) !== undefined);
    if (entities.length === 0) return notApplicable('no-third-parties');
    const heavy = entities.filter(row => (num(row.mainThreadTime) ?? 0) >= entityMainThreadMs || (num(row.transferSize) ?? 0) >= entityBytes);
    if (heavy.length === 0) return { outcome: 'pass', evidence: [auditEvidence(evidence, page!, summary, 'third-parties-insight', 'Lighthouse third parties insight')] };
    const describe = (row: (typeof heavy)[number]) => `${str(row.entity)}: main thread ${formatMs(num(row.mainThreadTime) ?? 0)}, transfer ${formatKib(num(row.transferSize) ?? 0)}`;
    const cited = heavy.slice(0, 5).map(row => labEvidence(evidence, page!, summary, 'third-parties-insight', 'third-party entity cost in the lab load', describe(row)));
    const busy = heavy.some(row => (num(row.mainThreadTime) ?? 0) >= entityMainThreadMs);
    const onlyConsent = heavy.every(row => consentEntity.test(str(row.entity)!));
    const params = { entities: heavy.map(describe).join('; ') };
    // A consent manager may be legally required: the finding asks for optimisation, not removal.
    if (onlyConsent) return { outcome: 'fail', severity: 'low', reason: 'consent-manager', evidence: cited, params };
    return { outcome: 'fail', severity: busy ? 'medium' : 'low', ...(busy ? {} : { reason: 'bytes' }), evidence: cited, params };
  },
};

interface EmbedKind {
  readonly name: string;
  readonly host: RegExp;
  readonly entity: RegExp;
}

const embedKinds: readonly EmbedKind[] = [
  { name: 'YouTube player', host: /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)$/u, entity: /^YouTube$/u },
  { name: 'Vimeo player', host: /(^|\.)(vimeo\.com|vimeocdn\.com)$/u, entity: /^Vimeo$/u },
  { name: 'Intercom', host: /(^|\.)(intercom\.io|intercomcdn\.com|intercomassets\.com)$/u, entity: /^Intercom$/u },
  { name: 'Drift', host: /(^|\.)(drift\.com|driftt\.com)$/u, entity: /^Drift$/u },
  { name: 'HubSpot chat', host: /(^|\.)(usemessages\.com|hubspot\.com|hs-scripts\.com)$/u, entity: /^HubSpot$/u },
  { name: 'Tawk.to', host: /(^|\.)tawk\.to$/u, entity: /^Tawk\.to$/u },
  { name: 'Crisp', host: /(^|\.)crisp\.chat$/u, entity: /^Crisp$/u },
  { name: 'Zendesk chat', host: /(^|\.)(zdassets\.com|zopim\.com)$/u, entity: /^Zendesk$/u },
  { name: 'Tidio', host: /(^|\.)tidio\.co$/u, entity: /^Tidio$/u },
  { name: 'LiveChat', host: /(^|\.)livechatinc\.com$/u, entity: /^LiveChat$/u },
];

const facadeBytes = 100 * kib;
const facadeMainThreadMs = 100;

export const thirdPartyFacades: RuleImplementation = {
  id: 'perf-third-party-facades',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const requests = networkRequests(summary);
    const entities = rows(auditOf(summary, 'third-parties-insight')?.details);
    const present = embedKinds.map(kind => {
      const own = requests.filter(request => kind.host.test(hostOf(request.url)));
      const entity = entities.find(row => kind.entity.test(str(row.entity) ?? ''));
      return { kind, requests: own, bytes: own.reduce((sum, request) => sum + (request.transferSize ?? 0), 0), mainThread: num(entity?.mainThreadTime) ?? 0 };
    }).filter(entry => entry.requests.length > 0);
    if (present.length === 0) return notApplicable('no-embeds');
    const describe = (entry: (typeof present)[number]) => `${entry.kind.name}: ${entry.requests.length} requests, ${formatKib(entry.bytes)}, main thread ${formatMs(entry.mainThread)}`;
    const costly = present.filter(entry => entry.bytes >= facadeBytes || entry.mainThread >= facadeMainThreadMs);
    const cited = (costly.length > 0 ? costly : present).map(entry => labEvidence(evidence, page!, summary, 'network-requests', 'embed loaded before any interaction in the lab load', describe(entry)));
    if (costly.length === 0) return { outcome: 'pass', evidence: cited };
    return { outcome: 'fail', severity: 'low', evidence: cited, params: { embeds: costly.map(describe).join('; ') } };
  },
};

function savingsBytes(details: unknown): number | undefined {
  return isRecord(details) ? num(details.overallSavingsBytes) : undefined;
}

const unusedJsBytes = 150 * kib;
const unusedCssBytes = 50 * kib;

export const unusedCode: RuleImplementation = {
  id: 'perf-unused-code',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const results: RuleResult[] = [];
    const checks = [['unused-javascript', unusedJsBytes, 'javascript'], ['unused-css-rules', unusedCssBytes, 'css']] as const;
    let measured = false;
    for (const [id, limit, reason] of checks) {
      const audit = auditOf(summary, id);
      const bytes = savingsBytes(audit?.details);
      if (bytes === undefined) continue;
      measured = true;
      if (bytes < limit) continue;
      const top = rows(audit!.details).filter(row => str(row.url)).slice(0, 3).map(row => `${str(row.url)} (${formatKib(num(row.wastedBytes) ?? 0)})`);
      results.push({ outcome: 'fail', severity: 'low', reason, params: { size: formatKib(bytes), files: top.length > 0 ? top.join('; ') : 'not listed' },
        evidence: [labEvidence(evidence, page!, summary, id, `lab ${reason === 'css' ? 'CSS' : 'JavaScript'} not used during the page load`, `overallSavingsBytes=${bytes}${top.length > 0 ? `; ${top.join('; ')}` : ''}`)] });
    }
    if (!measured) return notEvaluated('no-coverage-audits');
    return results.length > 0 ? results : [{ outcome: 'pass' }];
  },
};

export const legacyDuplicatedJs: RuleImplementation = {
  id: 'perf-legacy-duplicated-js',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const results: RuleResult[] = [];
    const checks = [['legacy-javascript-insight', 'legacy', 'polyfills and transforms for features every target browser supports'], ['duplicated-javascript-insight', 'duplicated', 'modules bundled more than once']] as const;
    let measured = false;
    for (const [id, reason, label] of checks) {
      const audit = auditOf(summary, id);
      if (!auditRan(audit) || audit.score === null) continue;
      measured = true;
      if (audit.score !== 0) continue;
      const files = rows(audit.details).map(row => str(row.url) ?? str(row.source)).filter((value): value is string => Boolean(value));
      results.push({ outcome: 'fail', severity: 'low', reason, params: { size: formatKib(audit.numericValue ?? 0), files: files.length > 0 ? summarizeList(files) : 'not listed' },
        evidence: [auditEvidence(evidence, page!, summary, id, `Lighthouse ${label}`)] });
    }
    if (!measured) return notEvaluated('no-javascript-insights');
    return results.length > 0 ? results : [{ outcome: 'pass' }];
  },
};

const minificationBytes = 10 * kib;

export const minification: RuleImplementation = {
  id: 'perf-minification',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const audits = ['unminified-css', 'unminified-javascript'].map(id => ({ id, bytes: savingsBytes(auditOf(summary, id)?.details) }));
    if (audits.every(entry => entry.bytes === undefined)) return notEvaluated('no-minification-audits');
    const total = audits.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    const cited = audits.filter(entry => entry.bytes !== undefined).map(entry => labEvidence(evidence, page!, summary, entry.id, 'lab bytes saved by minification', `overallSavingsBytes=${entry.bytes}`));
    if (total < minificationBytes) return { outcome: 'pass', evidence: cited };
    return { outcome: 'fail', severity: 'low', evidence: cited, params: { size: formatKib(total) } };
  },
};

/** Lighthouse scoring control points for total byte weight: p10 2667 KiB, median 4000 KiB. */
const byteNote = 2667 * kib;
const byteLimit = 4000 * kib;

export const totalByteWeight: RuleImplementation = {
  id: 'perf-total-byte-weight',
  evaluate({ page, evidence }) {
    const summary = labOf(page)!;
    const bytes = auditOf(summary, 'total-byte-weight')?.numericValue;
    if (bytes === undefined) return notEvaluated('no-lab-value');
    const cited = auditEvidence(evidence, page!, summary, 'total-byte-weight', 'Lighthouse lab total byte weight');
    if (bytes <= byteNote) return { outcome: 'pass', evidence: [cited] };
    const params = { size: formatKib(bytes), requests: networkRequests(summary).length };
    if (bytes > byteLimit) return { outcome: 'fail', severity: 'low', evidence: [cited], params };
    return { outcome: 'fail', severity: 'info', reason: 'note', evidence: [cited], params };
  },
};

export const scriptImplementations: readonly RuleImplementation[] = [
  longTasks, forcedReflow, domSize, thirdPartyCost, thirdPartyFacades, unusedCode, legacyDuplicatedJs, minification, totalByteWeight,
];
