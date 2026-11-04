import type { DocumentFacts } from '../../core/facts.ts';
import { attribute, isElement, walk, type HtmlElement } from '../../parse/html.ts';
import { directivesFor, pageDocument, robotsDirectives, summarizeList } from '../helpers.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { mainText } from './main-text.ts';
import { clip } from './support.ts';

const bingPreviewControls: RuleImplementation = {
  id: 'ai-bing-noarchive-nocache',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!);
    const all = robotsDirectives(page!.fetch.headers, doc);
    const applied = directivesFor(all, 'bingbot');
    if (applied.has('noindex')) return { outcome: 'not_applicable', reason: 'noindex' };
    const nocache = applied.has('nocache');
    const noarchive = applied.has('noarchive');
    if (!nocache && !noarchive) return { outcome: 'pass' };
    const wanted = nocache ? 'nocache' : 'noarchive';
    const ids = all
      .filter(entry => (entry.agent === 'all' || entry.agent === 'bingbot') && entry.directives.some(directive => directive === 'nocache' || directive === 'noarchive'))
      .map(entry => evidence.add({
        kind: entry.source === 'header' ? 'header' : 'html', url: page!.fetch.finalUrl,
        label: entry.source === 'header' ? 'X-Robots-Tag header that applies to Bingbot' : 'robots meta element that applies to Bingbot',
        excerpt: entry.raw, ...(entry.line ? { line: entry.line } : {}),
      }));
    // Bing documents noarchive alone as removing the page from Copilot answers, and nocache (alone or with noarchive)
    // as limiting answers to the URL, title and snippet.
    return nocache
      ? { outcome: 'fail', severity: 'low', reason: 'nocache', evidence: ids, params: { directive: wanted } }
      : { outcome: 'fail', severity: 'medium', reason: 'noarchive', evidence: ids, params: { directive: wanted } };
  },
};

/** Lighthouse accessibility audits that decide whether an agent can find and operate a control. */
const agentAudits: readonly string[] = ['button-name', 'link-name', 'label', 'input-button-name', 'select-name', 'aria-command-name', 'target-size'];

const agentReadiness: RuleImplementation = {
  id: 'ai-agent-readiness',
  evaluate({ page, evidence }) {
    const outcome = page!.lighthouse;
    if (!outcome?.ok) return { outcome: 'not_evaluated', reason: 'no-lighthouse' };
    const { audits } = outcome.summary;
    const url = outcome.summary.finalUrl;
    const results: RuleResult[] = [];
    let applicable = 0;
    for (const id of agentAudits) {
      const audit = audits[id];
      if (!audit || audit.score === null || audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'manual') continue;
      applicable++;
      if (audit.score >= 1) continue;
      results.push({
        outcome: 'fail', severity: 'low', reason: id,
        evidence: [evidence.add({ kind: 'lighthouse', url, label: `Lighthouse audit ${id}`, excerpt: `score ${audit.score}${audit.displayValue ? `; ${audit.displayValue}` : ''}` })],
        params: { audit: id, title: audit.title },
      });
    }
    const cls = audits['cumulative-layout-shift'];
    if (cls?.numericValue !== undefined) {
      applicable++;
      if (cls.numericValue > 0.1) {
        results.push({
          outcome: 'fail', severity: 'low', reason: 'layout-shift',
          evidence: [evidence.add({ kind: 'lighthouse', url, label: 'Lighthouse audit cumulative-layout-shift', excerpt: cls.displayValue ?? String(cls.numericValue) })],
          params: { value: Math.round(cls.numericValue * 1000) / 1000 },
        });
      }
    }
    if (applicable === 0) return { outcome: 'not_applicable', reason: 'no-applicable-audits' };
    return results.length > 0 ? results : { outcome: 'pass' };
  },
};

const webmcpScript = /navigator\s*\.\s*modelContext\b|\bmodelContext\s*\.\s*(?:registerTool|provideContext)\b/u;

function webmcpSignals(doc: DocumentFacts): { readonly excerpt: string; readonly line: number; readonly path: string }[] {
  const found: { excerpt: string; line: number; path: string }[] = [];
  for (const script of doc.parsed.scripts) {
    const match = webmcpScript.exec(script.text);
    if (match) found.push({ excerpt: clip(script.text.slice(Math.max(0, match.index - 40), match.index + 120).trim(), 200), line: script.line, path: 'script' });
  }
  walk(doc.parsed.document, node => {
    if (!isElement(node) || node.tagName !== 'form') return undefined;
    const name = attribute(node, 'toolname');
    if (name !== undefined) found.push({ excerpt: `toolname="${name}"`, line: node.sourceCodeLocation?.startLine ?? 0, path: 'form[toolname]' });
    return undefined;
  });
  return found;
}

const webmcpContext: RuleImplementation = {
  id: 'ai-webmcp-context',
  evaluate({ page, evidence }) {
    const docs = [page!.raw!, ...(page!.rendered && page!.rendered.result.error === undefined ? [page!.rendered] : [])];
    const signals = docs.flatMap(webmcpSignals);
    if (signals.length === 0) return { outcome: 'not_applicable', reason: 'no-webmcp' };
    const ids = [...new Map(signals.map(signal => [signal.excerpt, signal])).values()].slice(0, 5).map(signal => evidence.add({
      kind: 'html', url: page!.fetch.finalUrl, label: 'WebMCP tool declaration', excerpt: signal.excerpt, path: signal.path, ...(signal.line ? { line: signal.line } : {}),
    }));
    return { outcome: 'fail', severity: 'info', reason: 'declared', evidence: ids };
  },
};

const embedHosts = /^(?:https?:)?\/\/(?:www\.)?(?:youtube\.com|youtube-nocookie\.com|player\.vimeo\.com|fast\.wistia\.net|player\.twitch\.tv)\//iu;
const textTracks = new Set(['captions', 'subtitles', 'descriptions']);
const transcriptWord = /\b(?:transcript|transcripción|transcripció|transcription|transkript)\b/iu;
/** A page whose own text is this short leans on its media for the facts, so its media becomes a candidate. */
const thinTextWords = 150;

interface MediaCandidate {
  readonly kind: 'canvas' | 'video' | 'embed' | 'pdf';
  readonly excerpt: string;
  readonly line: number;
}

/** The element's start tag exactly as served, or its tag name for an element the parser created. */
function source(element: HtmlElement, html: string): string {
  const tag = element.sourceCodeLocation?.startTag;
  return tag ? html.slice(tag.startOffset, tag.endOffset) : `<${element.tagName}>`;
}

function mediaIn(root: HtmlElement, html: string): { candidates: MediaCandidate[]; media: number } {
  const candidates: MediaCandidate[] = [];
  let media = 0;
  walk(root, node => {
    if (!isElement(node)) return undefined;
    const line = node.sourceCodeLocation?.startLine ?? 0;
    if (node.tagName === 'canvas') {
      media++;
      const fallback = node.childNodes.some(child => child.nodeName === '#text' ? (child as { value: string }).value.trim() !== '' : isElement(child));
      if (!fallback && !attribute(node, 'aria-label') && !attribute(node, 'aria-labelledby')) candidates.push({ kind: 'canvas', excerpt: source(node, html), line });
      return false;
    }
    if (node.tagName === 'video') {
      media++;
      // Muted, looping background video is decoration; only a video meant to be watched can carry the facts.
      const decorative = attribute(node, 'controls') === undefined;
      const tracked = node.childNodes.some(child => isElement(child) && child.tagName === 'track' && textTracks.has((attribute(child, 'kind') ?? 'subtitles').toLowerCase()));
      if (!decorative && !tracked) candidates.push({ kind: 'video', excerpt: source(node, html), line });
      return false;
    }
    if (node.tagName === 'iframe' && embedHosts.test(attribute(node, 'src') ?? '')) {
      media++;
      candidates.push({ kind: 'embed', excerpt: source(node, html), line });
      return false;
    }
    if (node.tagName === 'a' && /\.pdf(?:$|[?#])/iu.test(attribute(node, 'href') ?? '')) {
      media++;
      candidates.push({ kind: 'pdf', excerpt: source(node, html), line });
    }
    return undefined;
  });
  return { candidates, media };
}

const textualContentForMedia: RuleImplementation = {
  id: 'ai-textual-content-for-media',
  evaluate({ page, evidence }) {
    const doc = pageDocument(page!)!;
    const main = mainText(doc);
    if (!main.root) return { outcome: 'not_applicable', reason: 'no-body' };
    const { candidates, media } = mediaIn(main.root, doc.html);
    if (media === 0) return { outcome: 'not_applicable', reason: 'no-media' };
    const thin = main.words < thinTextWords;
    const hasTranscript = transcriptWord.test(main.text);
    // A canvas without fallback text hides its content whatever the page says around it; video, embeds and PDF
    // links only matter when the page's own text is too short to hold the facts and no transcript is offered.
    const kept = candidates.filter(candidate => candidate.kind === 'canvas' || (thin && !hasTranscript && (candidate.kind !== 'pdf' || main.words < 50)));
    if (kept.length === 0) return { outcome: 'pass' };
    const ids = kept.slice(0, 5).map(candidate => evidence.add({
      kind: 'html', url: page!.fetch.finalUrl, label: `${candidate.kind} in the main content without a text equivalent nearby (${main.words} words of main text)`,
      excerpt: clip(candidate.excerpt, 300), ...(candidate.line ? { line: candidate.line } : {}),
    }));
    return {
      outcome: 'fail', severity: 'medium', reason: 'media-only-facts', needsJudgment: true, evidence: ids,
      params: { count: kept.length, kinds: summarizeList([...new Set(kept.map(candidate => candidate.kind))]) },
    };
  },
};

export const pageSignalRules: readonly RuleImplementation[] = [bingPreviewControls, agentReadiness, webmcpContext, textualContentForMedia];
