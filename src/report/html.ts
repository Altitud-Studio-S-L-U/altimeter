import { createHash } from 'node:crypto';
import type { AiFinding, ReportAnalysis } from '../ai/types.ts';
import { rule as catalogRule, myths } from '../catalog/index.ts';
import { categories } from '../core/types.ts';
import { evidenceLabelText } from '../i18n/evidence.ts';
import { findingMessage, format, ruleTexts, type Language } from '../i18n/messages.ts';
import { ui } from '../i18n/ui.ts';
import { localizeValue } from '../i18n/values.ts';
import { aiFindingMessage, analysisSummary, evidenceWhere, formulaText, listedFailures, mythsListUrl, notEvaluatedText, pageTypeText, providerLabel, ruleTitle } from './markdown.ts';
import type { Report, ReportFinding } from './model.ts';
import { escapeHtml } from './sanitize.ts';

const style = `
:root { color-scheme: light dark; --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #5f5f5a; --line: #e2e1dc;
  --good: #1f7a3a; --warn: #9a6a00; --bad: #b3261e; --info: #3b5b8a; --chip: #efeee9; --accent: #2b4c7e; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --panel: #1b1b1b; --text: #ecebe6; --muted: #a6a59f; --line: #2c2c2a;
  --good: #5fc27e; --warn: #e3b341; --bad: #f2867c; --info: #8fb2e8; --chip: #262624; --accent: #8fb2e8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 40px 0 12px; } h3 { font-size: 16px; margin: 28px 0 8px; }
.meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
.summary { display: grid; grid-template-columns: 180px 1fr; gap: 24px; align-items: center; }
.overall { text-align: center; } .overall b { display: block; font-size: 52px; line-height: 1; } .overall span { color: var(--muted); font-size: 13px; }
.bars { display: grid; gap: 8px; } .bar { display: grid; grid-template-columns: 220px 1fr 44px; gap: 10px; align-items: center; font-size: 14px; }
.track { height: 8px; background: var(--chip); border-radius: 4px; overflow: hidden; } .fill { height: 100%; background: var(--accent); }
.fill.good { background: var(--good); } .fill.warn { background: var(--warn); } .fill.bad { background: var(--bad); }
.gate { margin-top: 14px; font-size: 14px; } .pill { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--chip); }
.sev-critical, .sev-high { color: var(--bad); } .sev-medium { color: var(--warn); } .sev-low, .sev-info { color: var(--info); }
ol.tasks { padding-left: 22px; } ol.tasks li { margin: 6px 0; } code { font: 13px ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--chip); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
details.finding { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
details.finding > summary { cursor: pointer; padding: 10px 14px; list-style: none; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
details.finding > summary::-webkit-details-marker { display: none; } details.finding[open] > summary { border-bottom: 1px solid var(--line); }
details.finding .body { padding: 10px 14px 14px; } details.finding .body ul { margin: 6px 0; padding-left: 20px; }
.where { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; } .filters button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; } .filters button[aria-pressed="true"] { background: var(--accent); color: var(--bg); border-color: var(--accent); }
[hidden] { display: none !important; }
table { border-collapse: collapse; width: 100%; font-size: 14px; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
a { color: var(--accent); }
@media (max-width: 720px) { .summary { grid-template-columns: 1fr; } .bar { grid-template-columns: 1fr 1fr 40px; } }
`;

const script = `(() => {
  const state = { category: 'all', severity: 'all' };
  const apply = () => {
    for (const item of document.querySelectorAll('[data-finding]')) {
      const visible = (state.category === 'all' || item.dataset.category === state.category) && (state.severity === 'all' || item.dataset.severity === state.severity);
      item.hidden = !visible;
    }
    for (const section of document.querySelectorAll('[data-category-section]')) {
      section.hidden = state.category !== 'all' && section.dataset.categorySection !== state.category;
    }
  };
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.filter;
      state[kind] = button.dataset.value;
      for (const peer of document.querySelectorAll('[data-filter="' + kind + '"]')) peer.setAttribute('aria-pressed', String(peer === button));
      apply();
    });
  }
})();`;

function scoreClass(score: number | null): string {
  if (score === null) return '';
  return score >= 90 ? 'good' : score >= 50 ? 'warn' : 'bad';
}

function safeHttpsLink(url: string, label: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return escapeHtml(label);
    return `<a href="${escapeHtml(parsed.href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(label);
  }
}

function findingHtml(finding: ReportFinding, language: Language, evidence: Map<string, Report['evidence'][number]>): string {
  const t = ui(language);
  const rule = catalogRule(finding.ruleId);
  const texts = rule ? ruleTexts(language, rule) : { title: finding.title, why: '', fix: '' };
  const severity = finding.severity ?? 'info';
  const where = finding.scope.kind === 'page' ? finding.scope.url : finding.scope.origin;
  const message = findingMessage(language, finding.ruleId, 'fail', finding.reason, finding.params) ?? finding.message ?? texts.title;
  const items = finding.evidence.slice(0, 6).map(id => evidence.get(id)).filter(Boolean).map(item => {
    const location = evidenceWhere(item!, language);
    return `<li>${escapeHtml(evidenceLabelText(language, item!))}${location ? ` <span class="where">(${escapeHtml(location)})</span>` : ''}${item!.excerpt !== undefined ? `<br><code>${escapeHtml(item!.excerpt.slice(0, 400))}</code>` : ''}</li>`;
  }).join('');
  const sources = (rule?.sources ?? []).slice(0, 3).map(source => `<li>${safeHttpsLink(source.url, source.url)} <span class="where">(${escapeHtml(format(t.verified, { date: source.verified }, language))})</span></li>`).join('');
  return `<details class="finding" data-finding data-category="${escapeHtml(finding.category)}" data-severity="${escapeHtml(severity)}">
<summary><b class="sev-${escapeHtml(severity)}">${escapeHtml(t.severities[severity])}</b><span>${escapeHtml(texts.title)}</span><span class="where">${escapeHtml(where)}${finding.judgment === 'confirmed' ? ` · ${escapeHtml(t.analysis.confirmedMark)}` : ''}</span></summary>
<div class="body"><p>${escapeHtml(message)}</p>${items ? `<p><b>${escapeHtml(t.evidence)}</b></p><ul>${items}</ul>` : ''}
${texts.fix ? `<p><b>${escapeHtml(t.fix)}:</b> ${escapeHtml(texts.fix)}</p>` : ''}${texts.why ? `<p class="where">${escapeHtml(texts.why)}</p>` : ''}
${sources ? `<p><b>${escapeHtml(t.source)}</b></p><ul>${sources}</ul>` : ''}<p class="where"><code>${escapeHtml(finding.ruleId)}</code></p></div></details>`;
}

function aiFindingHtml(finding: AiFinding, language: Language, findings: readonly ReportFinding[]): string {
  const t = ui(language);
  const rule = catalogRule(finding.ruleId);
  const title = rule ? ruleTexts(language, rule).title : finding.title;
  const severity = finding.severity ?? 'info';
  const where = finding.scope.kind === 'page' ? finding.scope.url : finding.scope.origin;
  const text = aiFindingMessage(finding, findings, language);
  const quotes = finding.quotes.slice(0, 3).map(quote => `<li>${escapeHtml(t.analysis.quote)} (${escapeHtml(quote.evidenceId)}): <code>${escapeHtml(quote.text.slice(0, 400))}</code></li>`).join('');
  const note = finding.notes[language] ? `<p class="where">${escapeHtml(t.analysis.notes)}: ${escapeHtml(finding.notes[language])}</p>` : '';
  return `<details class="finding"><summary><b class="sev-${escapeHtml(severity)}">${escapeHtml(t.severities[severity])}</b><span>${escapeHtml(title)}</span><span class="where">${escapeHtml(where)} · ${escapeHtml(t.analysis.verification[finding.verification])}</span></summary>
<div class="body">${text ? `<p>${escapeHtml(text)}</p>` : ''}${quotes ? `<ul>${quotes}</ul>` : ''}${note}<p class="where"><code>${escapeHtml(finding.ruleId)}</code></p></div></details>`;
}

/** The model analysis, rendered like the markdown report: model text and site text are escaped like any untrusted value. */
function analysisHtml(analysis: ReportAnalysis, language: Language, findings: readonly ReportFinding[]): string {
  const t = ui(language);
  const a = t.analysis;
  const parts = [`<h2>${escapeHtml(a.title)}</h2><p>${escapeHtml(a.intro)}</p>`];
  parts.push(`<p class="where">${escapeHtml(format(a.by, { analyst: providerLabel(analysis.provider.analyst, a.nobody), verifier: providerLabel(analysis.provider.verifier, a.nobody), pages: analysis.pages.join(', ') || '-' }, language))}<br>${escapeHtml(analysisSummary(analysis, language))}</p>`);
  const failures = analysis.findings.filter(finding => finding.outcome === 'fail');
  parts.push(`<h3>${escapeHtml(a.verified)}</h3>${failures.length === 0 ? `<p class="where">${escapeHtml(a.none)}</p>` : failures.map(finding => aiFindingHtml(finding, language, findings)).join('')}`);
  if (analysis.confirmations.length > 0) {
    parts.push(`<h3>${escapeHtml(a.decisions)}</h3><ul>${analysis.confirmations.map(decision => {
      const rule = catalogRule(decision.ruleId);
      const where = decision.scope.kind === 'page' ? decision.scope.url : decision.scope.origin;
      return `<li>${escapeHtml(rule ? ruleTexts(language, rule).title : decision.ruleId)} <span class="where">${escapeHtml(where)}</span>: ${escapeHtml(a.decision[decision.decision])}, ${escapeHtml(a.verification[decision.verification])}</li>`;
    }).join('')}</ul>`);
  }
  if (analysis.proposals.length > 0) {
    const items = analysis.proposals.map(proposal => {
      const body = proposal.kind === 'json-ld'
        ? `<pre><code>${escapeHtml(proposal.jsonLd.slice(0, 6000))}</code></pre>`
        : `<br><code>${escapeHtml(proposal.text)}</code>${proposal.current ? `<br><span class="where">${escapeHtml(a.current)}: ${escapeHtml(proposal.current)}</span>` : ''}`;
      const note = proposal.notes[language] ? `<br><span class="where">${escapeHtml(a.notes)}: ${escapeHtml(proposal.notes[language])}</span>` : '';
      return `<li><b>${escapeHtml(a.proposalKinds[proposal.kind])}</b> <span class="where">${escapeHtml(proposal.scope)}</span>${body}${note}</li>`;
    }).join('');
    parts.push(`<h3>${escapeHtml(a.proposals)}</h3><ul>${items}</ul>${analysis.proposals.some(proposal => proposal.placeholders > 0) ? `<p class="where">${escapeHtml(a.ownerToSupply)}</p>` : ''}`);
  }
  if (analysis.injectionCandidates.length > 0) {
    parts.push(`<h3>${escapeHtml(a.injection)}</h3><p class="where">${escapeHtml(a.injectionIntro)}</p><ul>${analysis.injectionCandidates.map(candidate => `<li><span class="where">${escapeHtml(candidate.page)} · ${escapeHtml(localizeValue(language, 'aiItem', candidate.where))}</span><br><code>${escapeHtml(candidate.excerpt.slice(0, 400))}</code></li>`).join('')}</ul>`);
  }
  const unverified = analysis.unverified.filter(finding => finding.outcome === 'fail');
  if (unverified.length > 0) parts.push(`<h3>${escapeHtml(a.unverified)}</h3><p class="where">${escapeHtml(a.unverifiedIntro)}</p>${unverified.map(finding => aiFindingHtml(finding, language, findings)).join('')}`);
  if (analysis.dropped.length > 0) {
    const byReason = new Map<string, number>();
    for (const claim of analysis.dropped) byReason.set(claim.reason, (byReason.get(claim.reason) ?? 0) + 1);
    parts.push(`<h3>${escapeHtml(a.dropped)}</h3><ul>${[...byReason].sort((x, y) => y[1] - x[1]).map(([reason, count]) => `<li><code>${escapeHtml(reason)}</code>: ${count}</li>`).join('')}</ul>`);
  }
  if (analysis.skipped.length > 0) parts.push(`<h3>${escapeHtml(a.skipped)}</h3><ul>${analysis.skipped.map(entry => `<li>${escapeHtml(entry.pass)} <span class="where">${escapeHtml(entry.page)}</span>: <code>${escapeHtml(entry.reason)}</code></li>`).join('')}</ul>`);
  if (analysis.warnings.length > 0) parts.push(`<p class="where">${analysis.warnings.map(warning => escapeHtml(localizeValue(language, 'warning', warning))).join('<br>')}</p>`);
  return parts.join('\n');
}

/** A self-contained report: no external requests, a strict CSP, and every value from the site escaped. */
export function renderHtml(report: Report, language: Language): string {
  const t = ui(language);
  const evidence = new Map(report.evidence.map(item => [item.id, item]));
  const host = new URL(report.target.origin).host;
  const failures = listedFailures(report.findings);
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; img-src data:; base-uri 'none'; form-action 'none'`;
  const bars = report.score.categories.map(entry => `<div class="bar"><span>${escapeHtml(t.categories[entry.category])}</span><div class="track"><div class="fill ${scoreClass(entry.score)}" style="width:${escapeHtml(String(entry.score ?? 0))}%"></div></div><b>${escapeHtml(String(entry.score ?? '–'))}</b></div>`).join('');
  const tasks = report.tasks.slice(0, 10).map(task => {
    const rule = catalogRule(task.ruleId);
    const title = rule ? ruleTexts(language, rule).title : task.title;
    return `<li><b class="sev-${escapeHtml(task.severity)}">${escapeHtml(t.severities[task.severity])}</b> ${escapeHtml(title)} <span class="where">· ${escapeHtml(String(task.scopes.length))} · ${escapeHtml(t.fixLocations[task.fixLocation])} · <code>${escapeHtml(task.id)}</code></span></li>`;
  }).join('');
  const filterButtons = [
    `<button type="button" data-filter="category" data-value="all" aria-pressed="true">${escapeHtml(t.all)}</button>`,
    ...categories.map(category => `<button type="button" data-filter="category" data-value="${category}" aria-pressed="false">${escapeHtml(t.categories[category])}</button>`),
  ].join('');
  const severityButtons = [`<button type="button" data-filter="severity" data-value="all" aria-pressed="true">${escapeHtml(t.all)}</button>`,
    ...(['critical', 'high', 'medium', 'low', 'info'] as const).map(severity => `<button type="button" data-filter="severity" data-value="${severity}" aria-pressed="false">${escapeHtml(t.severities[severity])}</button>`)].join('');
  const sections = categories.map(category => {
    const inCategory = failures.filter(finding => finding.category === category);
    return `<section data-category-section="${category}"><h3>${escapeHtml(t.categories[category])}</h3>${inCategory.length === 0 ? `<p class="where">${escapeHtml(t.noFindings)}</p>` : inCategory.map(finding => findingHtml(finding, language, evidence)).join('')}</section>`;
  }).join('');
  const pending = report.findings.filter(finding => finding.needsJudgment && finding.judgment === undefined);
  const notEvaluated = new Map<string, number>();
  for (const finding of report.findings.filter(entry => entry.outcome === 'not_evaluated')) notEvaluated.set(finding.reason ?? 'unknown', (notEvaluated.get(finding.reason ?? 'unknown') ?? 0) + 1);
  const pages = report.pages.map(page => `<tr><td>${escapeHtml(page.finalUrl)}</td><td>${escapeHtml(String(page.status ?? '–'))}</td><td>${escapeHtml(pageTypeText(page.pageType, language))}</td><td>${page.rendered ? escapeHtml(t.yes) : escapeHtml(t.no)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(format(t.reportTitle, { site: host }, language))}</title>
<style>${style}</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(format(t.reportTitle, { site: host }, language))}</h1>
<p class="meta">${escapeHtml(t.audited)}: ${escapeHtml(report.target.url)} · ${escapeHtml(format(t.generated, { version: report.tool.version, date: report.run.startedAt.slice(0, 10) }, language))}</p></header>
<h2>${escapeHtml(t.summary)}</h2>
<div class="panel"><div class="summary"><div class="overall"><b>${escapeHtml(String(report.score.overall ?? '–'))}</b><span>${escapeHtml(t.overall)}</span></div><div class="bars">${bars}</div></div>
<p class="gate"><span class="pill">${escapeHtml(t.indexability)}</span> ${escapeHtml(t.indexabilityStates[report.score.indexability])}</p>
<p class="where">${escapeHtml(format(t.coverageLine, { evaluated: report.coverage.evaluated, notEvaluated: report.coverage.notEvaluated, notApplicable: report.coverage.notApplicable }, language))}</p>
${report.run.warnings.length > 0 ? `<p class="where">${report.run.warnings.map(warning => escapeHtml(localizeValue(language, 'warning', warning))).join('<br>')}</p>` : ''}</div>
<h2>${escapeHtml(t.topActions)}</h2>
${tasks ? `<ol class="tasks">${tasks}</ol>` : `<p>${escapeHtml(t.noActions)}</p>`}
<h2>${escapeHtml(t.findings)}</h2>
<div class="filters" role="group" aria-label="${escapeHtml(t.findings)}">${filterButtons}</div>
<div class="filters" role="group" aria-label="${escapeHtml(t.severity)}">${severityButtons}</div>
${sections}
${pending.length > 0 ? `<h2>${escapeHtml(t.pendingReview)}</h2><p class="where">${escapeHtml(t.pendingReviewIntro)}</p><ul>${pending.map(finding => `<li>${escapeHtml(ruleTitle(language, finding.ruleId, finding.title))} <span class="where">${escapeHtml(finding.scope.kind === 'page' ? finding.scope.url : finding.scope.origin)}</span></li>`).join('')}</ul>` : ''}
${report.ai ? analysisHtml(report.ai, language, report.findings) : ''}
${notEvaluated.size > 0 ? `<h2>${escapeHtml(t.notEvaluated)}</h2><ul>${[...notEvaluated].sort((a, b) => b[1] - a[1]).map(([reason, count]) => { const text = notEvaluatedText(reason, language); return `<li>${text === undefined ? `<code>${escapeHtml(reason)}</code>` : escapeHtml(text)}: ${count}</li>`; }).join('')}</ul>` : ''}
<h2>${escapeHtml(t.pages)}</h2>
<div class="panel"><table><thead><tr><th>${escapeHtml(t.page)}</th><th>${escapeHtml(t.status)}</th><th>${escapeHtml(t.type)}</th><th>${escapeHtml(t.rendered)}</th></tr></thead><tbody>${pages}</tbody></table></div>
<h2>${escapeHtml(t.method)}</h2>
<p>${escapeHtml(t.methodIntro)}</p><p class="where">${escapeHtml(formulaText(report, language))}</p>
<p class="where">${escapeHtml(format(t.mythsLine, { count: myths.length }, language))} ${safeHttpsLink(mythsListUrl, mythsListUrl)}</p>
<p class="where">${escapeHtml(format(t.catalogLine, { implemented: report.catalog.implemented, rules: report.catalog.rules }, language)).replace('{hash}', () => `<code>${escapeHtml(report.catalog.hash.slice(0, 12))}</code>`)} · Node ${escapeHtml(report.run.versions.node)}${report.run.versions.chrome ? ` · ${escapeHtml(report.run.versions.chrome)}` : ''}${report.run.versions.lighthouse ? ` · Lighthouse ${escapeHtml(report.run.versions.lighthouse)}` : ''}</p>
</main>
<script>${script}</script>
</body>
</html>
`;
}
