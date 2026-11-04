import { attribute, isElement, type HtmlNode } from '../../parse/html.ts';
import type { RuleImplementation } from '../engine.ts';
import { absoluteUrl, directivesFor, robotsDirectives } from '../helpers.ts';
import { has, hasPath, nodesAt, text, texts, values, type GraphNode, type PageGraph } from './graph.ts';
import { cite, fetchTime, imageUrls, nodesOfType, parseIsoDate, perNode, sitePages, type Problem } from './support.ts';
import { isA } from './vocabulary.ts';

type Add = (reason: string, severity: Problem['severity'], subject: string, label: string, node?: GraphNode, property?: string, excerpt?: string) => void;

/** Collects problems for one node with a compact `add` helper bound to it. */
function collector(context: Parameters<RuleImplementation['evaluate']>[0], graph: PageGraph, owner: GraphNode): { problems: Problem[]; add: Add } {
  const problems: Problem[] = [];
  const add: Add = (reason, severity, subject, label, node = owner, property, excerpt) =>
    problems.push({ reason, severity, subject, evidence: cite(context, graph, node, label, property, excerpt) });
  return { problems, add };
}

const titleSeparator = /^[|\-–—·:•»]$/u;

/** Whether a name is a page title joined to the site name, as in "Fractional CTO | Altitud Studio". */
function withSiteName(name: string, siteNames: readonly string[]): boolean {
  const folded = name.normalize('NFKC').toLowerCase().trim();
  return siteNames.some(site => {
    const brand = site.normalize('NFKC').toLowerCase().trim();
    if (folded === brand) return false;
    const before = folded.endsWith(brand) ? folded.slice(0, -brand.length).trimEnd() : undefined;
    const after = folded.startsWith(brand) ? folded.slice(brand.length).trimStart() : undefined;
    return (before !== undefined && before.length > 1 && titleSeparator.test(before.at(-1)!))
      || (after !== undefined && after.length > 1 && titleSeparator.test(after[0]!));
  });
}

function missing(graph: PageGraph, node: GraphNode, properties: readonly string[]): string[] {
  return properties.filter(property => !hasPath(graph, node, property));
}

function decimalsOf(graph: PageGraph, node: GraphNode, property: string): number | undefined {
  const value = values(graph, node, property)[0];
  if (!value) return undefined;
  if (value.kind === 'text') return /\.(\d+)/u.exec(value.value.trim())?.[1]?.length ?? 0;
  if (value.kind !== 'number') return undefined;
  // JSON.parse drops trailing zeros, so the literal in the block decides.
  const literals = [...(node.blockText ?? '').matchAll(new RegExp(`"(?:https?://schema\\.org/)?${property}"\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)`, 'gu'))].map(match => match[1]!);
  const literal = literals.find(entry => Number(entry) === value.value) ?? String(value.value);
  return /\.(\d+)/u.exec(literal)?.[1]?.length ?? 0;
}

export const localBusiness: RuleImplementation = {
  id: 'schema-localbusiness',
  evaluate: context => perNode(context, 'LocalBusiness', 'no-local-business', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    const name = text(graph, node, 'name') ?? node.types.join('+');
    if (!has(graph, node, 'name')) add('missing-required', 'medium', 'name', 'LocalBusiness without name');
    const addresses = values(graph, node, 'address');
    // A service-area business may have no public address; Google offers Organization markup for that case.
    if (addresses.length === 0 && !has(graph, node, 'areaServed')) add('missing-required', 'medium', 'address', 'LocalBusiness without address');
    if (addresses.length > 0 && addresses.every(value => value.kind === 'text')) add('address-not-structured', 'low', name, 'address written as text instead of PostalAddress', node, 'address');
    for (const geo of nodesAt(graph, node, 'geo')) {
      for (const property of ['latitude', 'longitude']) {
        const decimals = decimalsOf(graph, geo, property);
        if (decimals !== undefined && decimals < 5) add('geo-precision', 'low', `${property} (${decimals} decimals)`, `${property} with fewer than 5 decimal places`, geo, property);
      }
    }
    const priceRange = text(graph, node, 'priceRange');
    if (priceRange !== undefined && priceRange.length >= 100) add('price-range-too-long', 'low', name, 'priceRange of 100 characters or more', node, 'priceRange');
    return problems;
  }),
};

const mainNode = (node: GraphNode) => node.parent === undefined || node.parent.property === 'mainEntity' || node.parent.property === 'mainEntityOfPage';

export const article: RuleImplementation = {
  id: 'schema-article',
  evaluate: context => perNode(context, 'Article', 'no-article', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    const label = node.types.join('+');
    const images = imageUrls(graph, node, 'image');
    if (images.length === 0) add('missing-image', 'medium', label, `${label} without image`);
    if ((isA(node.types, 'NewsArticle') || isA(node.types, 'BlogPosting')) && !has(graph, node, 'datePublished')) add('missing-date', 'medium', label, `${label} without datePublished`);
    for (const value of values(graph, node, 'author')) {
      if (value.kind === 'text') { add('author-not-entity', 'low', value.value, 'author written as text instead of Person or Organization', node, 'author', value.value); continue; }
      const author = value.kind === 'node' ? value.node : undefined;
      if (!author || author.types.length === 0) continue;
      if (!isA(author.types, 'Person') && !isA(author.types, 'Organization')) add('author-type', 'low', author.types.join('+'), 'author that is not a Person or Organization', author);
      const name = text(graph, author, 'name');
      if (name && isA(author.types, 'Person') && /\s(?:and|y|i|et|und|&)\s|,|;/u.test(name)) add('merged-authors', 'low', name, 'several names in one Person author', author, 'name', name);
    }
    return problems;
  }, { select: (_graph, node) => mainNode(node) }),
};

function topLevelPath(url: string): boolean {
  return new URL(url).pathname.split('/').filter(Boolean).length <= 1;
}

export const breadcrumb: RuleImplementation = {
  id: 'schema-breadcrumb',
  evaluate(context) {
    const knownPages = new Map(sitePages(context.site).map(page => [page.url, page]));
    for (const page of context.site.pages.values()) knownPages.set(page.url, page);
    return perNode(context, 'BreadcrumbList', 'no-breadcrumb', (graph, list) => {
      const { problems, add } = collector(context, graph, list);
      const items = nodesAt(graph, list, 'itemListElement');
      const shallow = context.page!.pageType === 'home' || topLevelPath(graph.base);
      if (items.length < 2 && !shallow) add('too-few-items', 'low', `${items.length} item(s)`, 'BreadcrumbList with fewer than two items');
      const siteNames = [...nodesOfType(graph, 'WebSite'), ...nodesOfType(graph, 'Organization'), ...items.slice(0, 1)]
        .map(node => text(graph, node, 'name')).filter((name): name is string => name !== undefined && name.trim() !== '');
      const positions = new Set<number>();
      items.forEach((item, index) => {
        const position = text(graph, item, 'position');
        if (position === undefined || !/^\d+$/u.test(position) || positions.has(Number(position))) {
          add('invalid-position', 'low', position ?? 'none', 'ListItem without a unique whole-number position', item, 'position');
        } else positions.add(Number(position));
        const target = nodesAt(graph, item, 'item')[0];
        const named = has(graph, item, 'name') || (target !== undefined && has(graph, target, 'name'));
        if (!named) add('missing-name', 'low', position ?? String(index + 1), 'ListItem without name', item);
        // Google shows each name as one step of the trail, so a page title with the site name repeats the brand there.
        const name = text(graph, item, 'name') ?? (target ? text(graph, target, 'name') : undefined);
        if (name !== undefined && index > 0 && withSiteName(name, siteNames)) add('name-with-site-name', 'low', name, 'breadcrumb name that carries the site name', item, 'name');
        const url = text(graph, item, 'item') ?? (target ? target.id ?? text(graph, target, 'url') : undefined);
        if (url === undefined && index < items.length - 1) add('missing-item', 'low', position ?? String(index + 1), 'ListItem other than the last without item', item);
        const absolute = absoluteUrl(url, graph.base);
        const known = absolute ? knownPages.get(absolute) : undefined;
        if (known && (known.fetch.status ?? 0) >= 400) add('broken-item-url', 'low', absolute!, `breadcrumb item answering HTTP ${known.fetch.status}`, item, 'item', url);
        else if (known && known.fetch.finalUrl !== absolute) add('redirecting-item-url', 'low', absolute!, `breadcrumb item that redirects to ${known.fetch.finalUrl}`, item, 'item', url);
      });
      return problems;
    });
  },
};

export const profilePage: RuleImplementation = {
  id: 'schema-profile-page',
  evaluate: context => perNode(context, 'ProfilePage', 'no-profile-page', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    const entities = nodesAt(graph, node, 'mainEntity');
    if (entities.length === 0) add('missing-main-entity', 'medium', 'mainEntity', 'ProfilePage without mainEntity');
    for (const entity of entities) {
      if (!isA(entity.types, 'Person') && !isA(entity.types, 'Organization')) add('main-entity-type', 'medium', entity.types.join('+') || 'untyped', 'ProfilePage mainEntity that is not a Person or Organization', entity);
      if (!has(graph, entity, 'name') && !has(graph, entity, 'alternateName')) add('main-entity-without-name', 'medium', 'name', 'ProfilePage mainEntity without name', entity);
    }
    const people = nodesOfType(graph, 'Person').filter(person => person.parent === undefined || person.parent.property === 'mainEntity');
    if (entities.length > 1 || people.length >= 3) {
      problems.push({ reason: 'several-people', severity: 'medium', subject: `${Math.max(entities.length, people.length)} people`, needsJudgment: true,
        evidence: cite(context, graph, node, 'ProfilePage on a page that describes several people') });
    }
    return problems;
  }),
};

export const video: RuleImplementation = {
  id: 'schema-video',
  evaluate: context => perNode(context, 'VideoObject', 'no-video', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    const name = text(graph, node, 'name') ?? 'VideoObject';
    for (const property of missing(graph, node, ['name', 'thumbnailUrl', 'uploadDate'])) add('missing-required', 'medium', property, `VideoObject without ${property}`);
    if (!has(graph, node, 'contentUrl') && !has(graph, node, 'embedUrl')) add('missing-content-url', 'low', name, 'VideoObject without contentUrl or embedUrl');
    if (has(graph, node, 'ineligibleRegion') && has(graph, node, 'regionsAllowed')) add('both-region-lists', 'low', name, 'VideoObject with both ineligibleRegion and regionsAllowed');
    for (const clip of nodesAt(graph, node, 'hasPart').filter(part => isA(part.types, 'Clip'))) {
      const gaps = missing(graph, clip, ['name', 'startOffset', 'url']);
      if (gaps.length > 0) add('clip-incomplete', 'low', gaps.join(', '), `Clip without ${gaps.join(', ')}`, clip);
    }
    return problems;
  }),
};

const licensing = ['license', 'acquireLicensePage', 'creditText', 'copyrightNotice', 'creator'];

export const imageMetadata: RuleImplementation = {
  id: 'schema-image-metadata',
  // ImageObjects without any licensing property are logos and photos that this feature does not concern.
  evaluate: context => perNode(context, 'ImageObject', 'no-image-licensing-markup', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    if (!has(graph, node, 'contentUrl') && !has(graph, node, 'url')) add('missing-content-url', 'low', 'contentUrl', 'ImageObject with licensing details but no contentUrl');
    if (!['creator', 'creditText', 'copyrightNotice', 'license'].some(property => has(graph, node, property))) {
      add('missing-license-info', 'low', 'license', 'ImageObject without creator, creditText, copyrightNotice or license');
    }
    return problems;
  }, { select: (graph, node) => licensing.some(property => has(graph, node, property)) }),
};

export const event: RuleImplementation = {
  id: 'schema-event',
  evaluate: context => perNode(context, 'Event', 'no-event', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    const name = text(graph, node, 'name') ?? 'Event';
    for (const property of missing(graph, node, ['name', 'startDate', 'location'])) add('missing-required', 'high', property, `Event without ${property}`);
    const locations = values(graph, node, 'location');
    const places = nodesAt(graph, node, 'location');
    if (locations.length > 0 && places.length > 0 && places.every(place => isA(place.types, 'VirtualLocation'))) {
      add('virtual-only', 'medium', name, 'Event whose only location is virtual', node, 'location');
    } else if (locations.length > 0) {
      const physical = places.filter(place => !isA(place.types, 'VirtualLocation'));
      if (physical.length === 0 || physical.every(place => !has(graph, place, 'address'))) add('location-without-address', 'high', name, 'Event location without address', node, 'location');
    }
    return problems;
  }),
};

export const jobPosting: RuleImplementation = {
  id: 'schema-jobposting',
  evaluate(context) {
    const page = context.page!;
    const now = fetchTime(page);
    return perNode(context, 'JobPosting', 'no-job-posting', (graph, node) => {
      const { problems, add } = collector(context, graph, node);
      const title = text(graph, node, 'title') ?? 'JobPosting';
      for (const property of missing(graph, node, ['title', 'description', 'datePosted', 'hiringOrganization'])) add('missing-required', 'high', property, `JobPosting without ${property}`);
      const remote = texts(graph, node, 'jobLocationType').some(value => value.trim().toUpperCase() === 'TELECOMMUTE');
      if (!has(graph, node, 'jobLocation')) {
        if (!remote) add('missing-required', 'high', 'jobLocation', 'JobPosting without jobLocation');
        else if (!has(graph, node, 'applicantLocationRequirements')) add('remote-without-applicant-location', 'high', title, 'remote JobPosting without applicantLocationRequirements');
      }
      const others = nodesOfType(graph, 'JobPosting').filter(entry => entry !== node && mainNode(entry));
      if (others.length > 0 && graph.nodes.indexOf(node) < Math.min(...others.map(entry => graph.nodes.indexOf(entry)))) {
        add('several-jobs', 'high', `${others.length + 1} JobPosting`, 'several JobPosting items on one page');
      }
      const through = text(graph, node, 'validThrough');
      const parsed = through === undefined ? undefined : parseIsoDate(through);
      const indexable = page.fetch.status === 200 && !directivesFor(robotsDirectives(page.fetch.headers, graph.doc)).has('noindex');
      if (parsed && now !== undefined && indexable) {
        const latest = parsed.time + (parsed.precision === 'time' ? (parsed.offset ? 0 : 14 * 3_600_000) : 38 * 3_600_000);
        if (latest < now) add('expired', 'high', title, 'validThrough before the fetch date on a live, indexable page', node, 'validThrough', through);
      }
      return problems;
    }, { select: (_graph, node) => mainNode(node) });
  },
};

export const dataset: RuleImplementation = {
  id: 'schema-dataset',
  evaluate: context => perNode(context, 'Dataset', 'no-dataset', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    for (const property of missing(graph, node, ['name', 'description'])) add('missing-required', 'low', property, `Dataset without ${property}`);
    const description = text(graph, node, 'description');
    if (description !== undefined && (description.length < 50 || description.length > 5000)) {
      add('description-length', 'low', `${description.length} characters`, 'Dataset description outside 50 to 5000 characters', node, 'description');
    }
    return problems;
  }),
};

export const qaPage: RuleImplementation = {
  id: 'schema-qapage',
  evaluate: context => perNode(context, 'QAPage', 'no-qapage', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    const questions = nodesAt(graph, node, 'mainEntity').filter(entry => isA(entry.types, 'Question'));
    if (questions.length === 0) add('missing-question', 'high', 'mainEntity', 'QAPage without a Question as mainEntity');
    if (questions.length > 1) add('several-questions', 'high', `${questions.length} questions`, 'QAPage with more than one question', node, 'mainEntity');
    for (const question of questions) {
      for (const property of missing(graph, question, ['name', 'answerCount'])) add('missing-required', 'high', property, `Question without ${property}`, question);
      const answers = [...nodesAt(graph, question, 'acceptedAnswer'), ...nodesAt(graph, question, 'suggestedAnswer')];
      if (answers.length === 0) add('missing-answer', 'high', 'acceptedAnswer/suggestedAnswer', 'Question without acceptedAnswer or suggestedAnswer', question);
      for (const answer of answers) if (!has(graph, answer, 'text')) add('answer-without-text', 'high', 'text', 'Answer without text', answer);
      if (answers.length > 0 && !has(graph, question, 'author') && answers.every(answer => !has(graph, answer, 'author'))) {
        problems.push({ reason: 'site-authored-candidate', severity: 'medium', subject: text(graph, question, 'name') ?? 'Question', needsJudgment: true,
          evidence: cite(context, graph, question, 'question and answers with no author, as on a site-written FAQ') });
      }
    }
    return problems;
  }),
};

const sameDocument = (a: string, b: string) => a.replace(/#.*$/u, '') === b.replace(/#.*$/u, '');

export const discussionForum: RuleImplementation = {
  id: 'schema-discussion-forum',
  evaluate: context => perNode(context, ['DiscussionForumPosting', 'SocialMediaPosting'], 'no-forum-posting', (graph, post) => {
    const { problems, add } = collector(context, graph, post);
    const items = [post, ...graph.nodes.filter(node => isA(node.types, 'Comment') && node.path.startsWith(`${post.path}.`))];
    for (const item of items) {
      const kind = item === post ? post.types.join('+') : 'Comment';
      const authors = values(graph, item, 'author');
      if (authors.length === 0) add('missing-author', 'medium', kind, `${kind} without author`, item);
      else if (authors.every(value => value.kind !== 'text') && nodesAt(graph, item, 'author').every(author => !has(graph, author, 'name'))) {
        add('author-without-name', 'medium', kind, `${kind} author without name`, item, 'author');
      }
      if (!has(graph, item, 'datePublished')) add('missing-date', 'medium', kind, `${kind} without datePublished`, item);
      const url = absoluteUrl(text(graph, item, 'url'), graph.base);
      const elsewhere = url !== undefined && !sameDocument(url, graph.base);
      if (!elsewhere && !['text', 'image', 'video'].some(property => has(graph, item, property))) add('missing-content', 'medium', kind, `${kind} without text, image or video`, item);
    }
    return problems;
  }),
};

const classSelector = /^\.[A-Za-z_-][\w-]*(?:\.[A-Za-z_-][\w-]*)*$/u;

function childNodes(node: HtmlNode): readonly HtmlNode[] {
  return 'childNodes' in node ? (node as { childNodes: HtmlNode[] }).childNodes : [];
}

/** For each class selector, how many elements match and how many sit inside another selector's match. */
function selectorMatches(root: HtmlNode, selectors: readonly string[]): Map<string, { matches: number; nested: number }> {
  const parsed = selectors.map(selector => ({ selector, classes: selector.slice(1).split('.') }));
  const result = new Map(selectors.map(selector => [selector, { matches: 0, nested: 0 }]));
  const visit = (node: HtmlNode, inside: number) => {
    let depth = inside;
    if (isElement(node)) {
      const classes = new Set((attribute(node, 'class') ?? '').split(/\s+/u).filter(Boolean));
      for (const { selector, classes: wanted } of parsed) {
        if (!wanted.every(name => classes.has(name))) continue;
        const entry = result.get(selector)!;
        entry.matches += 1;
        if (inside > 0) entry.nested += 1;
        depth = inside + 1;
      }
    }
    for (const child of childNodes(node)) visit(child, depth);
  };
  visit(root, 0);
  return result;
}

const notFree = (graph: PageGraph, node: GraphNode) => values(graph, node, 'isAccessibleForFree')
  .some(value => (value.kind === 'boolean' && !value.value) || (value.kind === 'text' && /^(false|https?:\/\/schema\.org\/False)$/iu.test(value.value.trim())));

export const paywalledContent: RuleImplementation = {
  id: 'schema-paywalled-content',
  evaluate: context => perNode(context, 'CreativeWork', 'no-paywall-markup', (graph, work) => {
      const { problems, add } = collector(context, graph, work);
      const parts = nodesAt(graph, work, 'hasPart').filter(part => notFree(graph, part));
      const selectors = parts.flatMap(part => texts(graph, part, 'cssSelector').map(selector => ({ part, selector: selector.trim() })));
      for (const { part, selector } of selectors) {
        if (!classSelector.test(selector)) add('non-class-selector', 'medium', selector, 'cssSelector that is not a class selector', part, 'cssSelector', selector);
      }
      const valid = selectors.filter(entry => classSelector.test(entry.selector));
      const matches = selectorMatches(graph.doc.parsed.document, valid.map(entry => entry.selector));
      for (const { part, selector } of valid) {
        const found = matches.get(selector)!;
        if (found.matches === 0) add('selector-unmatched', 'medium', selector, 'cssSelector that matches no element', part, 'cssSelector', selector);
        else if (found.nested > 0) add('nested-sections', 'medium', selector, 'paywalled section nested inside another one', part, 'cssSelector', selector);
      }
      return problems;
    }, { select: (graph, work) => notFree(graph, work) && !isA(work.types, 'WebPageElement') }),
};

export const recipe: RuleImplementation = {
  id: 'schema-recipe',
  evaluate: context => perNode(context, 'Recipe', 'no-recipe', (graph, node) => {
    const { problems, add } = collector(context, graph, node);
    for (const property of missing(graph, node, ['name', 'image'])) add('missing-required', 'medium', property, `Recipe without ${property}`);
    if (hasPath(graph, node, 'nutrition.calories') && !has(graph, node, 'recipeYield')) add('calories-without-yield', 'medium', text(graph, node, 'name') ?? 'Recipe', 'nutrition.calories without recipeYield');
    return problems;
  }),
};

const betaTypes = ['LocalBusiness', 'Product', 'Event'];

export const carouselItemList: RuleImplementation = {
  id: 'schema-carousel-itemlist',
  evaluate: context => perNode(context, 'ItemList', 'no-carousel-markup', (graph, list) => {
    const { problems, add } = collector(context, graph, list);
    const items = nodesAt(graph, list, 'itemListElement').filter(item => isA(item.types, 'ListItem'));
    const full = items.map(item => nodesAt(graph, item, 'item').find(entry => entry.types.length > 0));
    const positions = items.map(item => text(graph, item, 'position'));
    if (positions.some(position => position === undefined || !/^\d+$/u.test(position) || Number(position) < 1)) add('invalid-position', 'low', 'position', 'ListItem without a whole-number position from 1');
    if (full.some(Boolean) && full.some(entry => !entry)) add('mixed-item-forms', 'low', 'itemListElement', 'list mixing url-only items with full items');
    if (full.every(entry => !entry)) {
      const urls = items.map(item => absoluteUrl(text(graph, item, 'url') ?? text(graph, item, 'item'), graph.base)).filter((url): url is string => url !== undefined);
      if (new Set(urls).size < urls.length) add('duplicate-urls', 'low', 'url', 'summary list with repeated URLs');
      const host = new URL(graph.base).host;
      const foreign = urls.filter(url => new URL(url).host !== host);
      if (foreign.length > 0) add('other-site-urls', 'low', foreign[0]!, 'summary list with URLs on another host', list, 'itemListElement', foreign[0]);
      return problems;
    }
    const typed = full.filter((entry): entry is GraphNode => entry !== undefined);
    if (typed.some(entry => betaTypes.some(type => isA(entry.types, type)))) {
      if (typed.length < 3) add('too-few-items', 'low', `${typed.length} items`, 'carousel list with fewer than three items');
      for (const entry of typed) {
        const gaps = missing(graph, entry, ['image', 'name', 'url']);
        if (gaps.length > 0) add('item-incomplete', 'low', gaps.join(', '), `carousel item without ${gaps.join(', ')}`, entry);
        const url = absoluteUrl(text(graph, entry, 'url'), graph.base);
        if (url && sameDocument(url, graph.base)) add('anchor-urls', 'low', url, 'carousel item pointing to an anchor on the list page', entry, 'url', url);
      }
    }
    return problems;
  }, { select: (graph, list) => !isA(list.types, 'BreadcrumbList') && list.parent === undefined
    && nodesAt(graph, list, 'itemListElement').some(item => isA(item.types, 'ListItem')) }),
};

