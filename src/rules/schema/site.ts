import type { PageFacts } from '../../core/facts.ts';
import type { RuleContext, RuleImplementation, RuleResult } from '../engine.ts';
import { absoluteUrl, metaProperty } from '../helpers.ts';
import { gs1CheckDigitValid, isSiteOwner } from './commerce.ts';
import { graphOf, has, nodesAt, text, texts, values, type GraphNode, type PageGraph } from './graph.ts';
import { imageInfo } from './image-size.ts';
import {
  blockedForImages, cite, homePage, hostOf, imageUrls, nodesOfType, normalizeName, plainNumber, report, sameHost, sitePages, type Problem,
} from './support.ts';
import { isA } from './vocabulary.ts';

interface Located {
  readonly page: PageFacts;
  readonly graph: PageGraph;
}

function graphs(pages: readonly PageFacts[]): Located[] {
  return pages.flatMap(page => {
    const graph = graphOf(page);
    return graph ? [{ page, graph }] : [];
  });
}

/** The home page and any about page: where Google reads Organization markup. */
function identityPages(context: RuleContext): Located[] | RuleResult {
  const home = homePage(context.site);
  if (!home) return { outcome: 'not_evaluated', reason: 'no-home-page' };
  return graphs([home, ...sitePages(context.site).filter(page => page.pageType === 'about' && page !== home)]);
}

const asResult = (value: Located[] | RuleResult): value is RuleResult => !Array.isArray(value);

const organizations = (graph: PageGraph) => nodesOfType(graph, 'Organization').filter(node => node.parent === undefined
  || ['publisher', 'mainEntity', 'about', 'provider', 'brand', 'author', 'sourceOrganization'].includes(node.parent.property));

export const organization: RuleImplementation = {
  id: 'schema-organization',
  evaluate(context) {
    const located = identityPages(context);
    if (asResult(located)) return located;
    const candidates = located.flatMap(({ graph }) => organizations(graph).map(node => ({ graph, node })));
    const problems: Problem[] = [];
    const home = located[0]!;
    if (candidates.length === 0) {
      return report([{ reason: 'missing', severity: 'low', subject: 'Organization',
        evidence: context.evidence.add({ kind: 'structured-data', url: home.page.fetch.finalUrl, label: 'no Organization markup on the home or about page',
          excerpt: `${home.graph.nodes.length} structured data items` }) }]);
    }
    const siteHost = hostOf(home.page.fetch.finalUrl);
    const owners = candidates.filter(entry => isSiteOwner(entry.graph, entry.node));
    for (const { graph, node } of candidates) {
      const url = text(graph, node, 'url');
      if (url !== undefined && node.parent === undefined && !sameHost(hostOf(url, graph.base), siteHost) && owners.length === 0) {
        problems.push({ reason: 'foreign-url', severity: 'medium', subject: url, evidence: cite(context, graph, node, 'Organization url on another host', 'url', url) });
      }
    }
    const chosen = owners[0] ?? candidates.find(entry => !has(entry.graph, entry.node, 'url'));
    if (chosen) {
      const gaps = ['name', 'url', 'logo', 'sameAs'].filter(property => !has(chosen.graph, chosen.node, property));
      if (gaps.length > 0) problems.push({ reason: 'missing-recommended', severity: 'low', subject: gaps.join(', '), evidence: cite(context, chosen.graph, chosen.node, 'site Organization node') });
    }
    return report(problems, [cite(context, (chosen ?? candidates[0]!).graph, (chosen ?? candidates[0]!).node, 'site Organization node')]);
  },
};

const ownerOrganizations = (graph: PageGraph) => organizations(graph).filter(node => isSiteOwner(graph, node));

export const organizationLogo: RuleImplementation = {
  id: 'schema-organization-logo',
  evaluate(context) {
    const located = identityPages(context);
    if (asResult(located)) return located;
    const logos = located.flatMap(({ graph }) => ownerOrganizations(graph).flatMap(node => imageUrls(graph, node, 'logo').map(url => ({ graph, node, url }))));
    const unique = logos.filter((entry, index) => logos.findIndex(other => other.url === entry.url) === index);
    if (unique.length === 0) return { outcome: 'not_applicable', reason: 'no-logo' };
    const problems: Problem[] = [];
    let unmeasured: string | undefined;
    let fetchedAny = false;
    for (const { graph, node, url } of unique) {
      const blocked = blockedForImages(context.site, url);
      const add = (reason: string, label: string, excerpt: string) => problems.push({ reason, severity: 'medium', subject: url,
        evidence: context.evidence.add({ kind: reason === 'blocked' ? 'robots' : 'http', url, label, excerpt }), also: [cite(context, graph, node, 'Organization logo', 'logo', url)] });
      if (blocked) add('blocked', 'robots.txt rule that disallows the logo for Googlebot-Image', blocked);
      const resource = context.site.resources.find(entry => entry.url === url);
      if (!resource) continue;
      fetchedAny = true;
      const type = resource.fetch.headers['content-type']?.[0] ?? '';
      if (resource.fetch.status !== 200) { add('not-200', 'response for the logo', `${resource.fetch.status ?? resource.fetch.error?.code ?? 'no response'}`); continue; }
      const info = imageInfo(resource.fetch.body);
      if (!info) { add('not-image', 'logo response that is not a supported image', type || 'no content-type'); continue; }
      if (info.width === undefined || info.height === undefined) { unmeasured = info.format; continue; }
      if (info.width < 112 || info.height < 112) add('too-small', 'pixel size of the logo', `${info.width}x${info.height} ${info.format}`);
    }
    if (problems.length > 0) return report(problems);
    if (unmeasured === 'svg') return { outcome: 'not_evaluated', reason: 'svg-size-unmeasurable' };
    if (unmeasured) return { outcome: 'not_evaluated', reason: 'size-unmeasurable' };
    if (!fetchedAny) return { outcome: 'not_evaluated', reason: 'logo-not-fetched' };
    return { outcome: 'pass', evidence: unique.slice(0, 3).map(({ graph, node, url }) => cite(context, graph, node, 'Organization logo', 'logo', url)) };
  },
};

function leiValid(code: string): boolean {
  if (!/^[A-Z0-9]{18}\d{2}$/u.test(code)) return false;
  const digits = [...code].map(char => (/\d/u.test(char) ? char : String(char.charCodeAt(0) - 55))).join('');
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

const identifierFormats: Readonly<Record<string, (value: string) => boolean>> = {
  iso6523Code: value => /^\d{4}:\S+$/u.test(value),
  duns: value => /^\d{9}$/u.test(value.replace(/[-\s]/gu, '')),
  leiCode: value => leiValid(value.toUpperCase()),
  globalLocationNumber: value => /^\d{13}$/u.test(value) && gs1CheckDigitValid(value),
  naics: value => /^\d{2,6}$/u.test(value),
};
const euCountries: Readonly<Record<string, string>> = {
  AT: 'AT', BE: 'BE', BG: 'BG', CY: 'CY', CZ: 'CZ', DE: 'DE', DK: 'DK', EE: 'EE', ES: 'ES', FI: 'FI', FR: 'FR', GR: 'EL', HR: 'HR', HU: 'HU', IE: 'IE',
  IT: 'IT', LT: 'LT', LU: 'LU', LV: 'LV', MT: 'MT', NL: 'NL', PL: 'PL', PT: 'PT', RO: 'RO', SE: 'SE', SI: 'SI', SK: 'SK',
};

/** The shape of an identifier without its value: digits as 9 and letters as A. */
const shape = (value: string) => value.replace(/\d/gu, '9').replace(/[A-Za-z]/gu, 'A');

function countriesOf(graph: PageGraph, node: GraphNode): string[] {
  return nodesAt(graph, node, 'address').flatMap(address => [
    ...texts(graph, address, 'addressCountry'),
    ...nodesAt(graph, address, 'addressCountry').flatMap(country => texts(graph, country, 'name')),
  ]).map(value => value.trim());
}

export const organizationIdentifiers: RuleImplementation = {
  id: 'schema-organization-identifiers',
  evaluate(context) {
    const located = graphs(sitePages(context.site));
    const problems = new Map<string, Problem>();
    let found = false;
    for (const { graph } of located) {
      for (const node of nodesOfType(graph, 'Organization')) {
        found = true;
        const add = (reason: string, property: string, label: string, excerpt: string) => {
          const key = `${reason}|${property}|${excerpt}`;
          if (!problems.has(key)) problems.set(key, { reason, severity: 'low', subject: property, evidence: cite(context, graph, node, label, property, excerpt) });
        };
        for (const [property, valid] of Object.entries(identifierFormats)) {
          for (const value of texts(graph, node, property)) if (!valid(value.trim())) add('malformed-identifier', property, `${property} in an unexpected format (shape shown)`, shape(value));
        }
        const countries = countriesOf(graph, node);
        for (const country of countries) if (!/^[A-Za-z]{2}$/u.test(country)) add('country-not-alpha2', 'addressCountry', 'addressCountry that is not a two-letter code', country);
        for (const value of texts(graph, node, 'telephone')) {
          if (!/^\(?(?:\+|00)/u.test(value.trim())) add('telephone-without-country-code', 'telephone', 'telephone without an international prefix (shape shown)', shape(value));
        }
        for (const value of texts(graph, node, 'email')) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim().replace(/^mailto:/iu, ''))) add('invalid-email', 'email', 'email that is not an address (shape shown)', shape(value));
        }
        const taxIds = [...texts(graph, node, 'vatID'), ...texts(graph, node, 'taxID')];
        if (taxIds.length > 0 && countries.length === 0) add('tax-id-without-country', 'vatID/taxID', 'tax identifier without an address country', shape(taxIds[0]!));
        const prefix = euCountries[countries.find(country => /^[A-Za-z]{2}$/u.test(country))?.toUpperCase() ?? ''];
        for (const vat of texts(graph, node, 'vatID')) {
          const compact = vat.replace(/[\s.-]/gu, '').toUpperCase();
          if (prefix && /^[A-Z]{2}/u.test(compact) && !compact.startsWith(prefix)) add('vat-prefix-mismatch', 'vatID', `EU VAT number whose prefix is not ${prefix}`, shape(vat));
        }
      }
    }
    if (!found) return { outcome: 'not_applicable', reason: 'no-organization' };
    return report([...problems.values()]);
  },
};

const legalSuffix = /[\s,]+(?:s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?\s?u?\.?|s\.?\s?a\.?\s?s\.?|inc\.?|llc|ltd\.?|limited|gmbh|ag|b\.?v\.?|n\.?v\.?|plc|sarl|srl|oy|ab|as|corp\.?|co\.?)$/iu;
const brandOf = (value: string) => normalizeName(value).replace(legalSuffix, '').trim();

export const siteNameWebsite: RuleImplementation = {
  id: 'schema-site-name-website',
  evaluate(context) {
    const home = homePage(context.site);
    const graph = home ? graphOf(home) : undefined;
    if (!home || !graph) return { outcome: 'not_evaluated', reason: 'no-home-page' };
    const websites = nodesOfType(graph, 'WebSite');
    const distinct = websites.filter((node, index) => node.id === undefined || websites.findIndex(other => other.id === node.id) === index);
    const named = distinct.filter(node => has(graph, node, 'name'));
    const problems: Problem[] = [];
    if (named.length === 0) {
      return report([{ reason: 'missing', severity: 'low', subject: 'WebSite',
        evidence: context.evidence.add({ kind: 'structured-data', url: home.fetch.finalUrl, label: 'no WebSite item with a name on the home page Googlebot reaches',
          excerpt: `${websites.length} WebSite items` }) }]);
    }
    if (distinct.length > 1) {
      problems.push({ reason: 'several-websites', severity: 'medium', subject: `${distinct.length} WebSite`, evidence: cite(context, graph, distinct[0]!, 'WebSite item'),
        also: distinct.slice(1, 4).map(node => cite(context, graph, node, 'another WebSite item')) });
    }
    const site = named[0]!;
    const url = text(graph, site, 'url');
    if (url !== undefined && !sameHost(hostOf(url, graph.base), hostOf(home.fetch.finalUrl))) {
      problems.push({ reason: 'url-other-host', severity: 'medium', subject: url, evidence: cite(context, graph, site, 'WebSite url on another host', 'url', url) });
    }
    const names = new Set([...texts(graph, site, 'name'), ...texts(graph, site, 'alternateName')].map(brandOf));
    const compare = (value: string, evidence: () => string) => {
      if (value.trim() === '' || names.has(brandOf(value))) return;
      problems.push({ reason: 'name-conflict', severity: 'medium', subject: value, needsJudgment: true, evidence: cite(context, graph, site, 'WebSite name', 'name'), also: [evidence()] });
    };
    for (const meta of metaProperty(graph.doc, 'og:site_name')) {
      compare(meta.attrs.content ?? '', () => context.evidence.add({ kind: 'html', url: home.fetch.finalUrl, label: 'og:site_name meta element',
        excerpt: meta.attrs.content ?? '', line: meta.line }));
    }
    for (const owner of ownerOrganizations(graph)) {
      const orgNames = [...texts(graph, owner, 'name'), ...texts(graph, owner, 'alternateName'), ...texts(graph, owner, 'legalName')];
      if (orgNames.length > 0 && !orgNames.some(name => names.has(brandOf(name)))) compare(orgNames[0]!, () => cite(context, graph, owner, 'Organization name', 'name'));
    }
    return report(problems, [cite(context, graph, site, 'WebSite item on the home page')]);
  },
};

export const sitelinksSearchboxObsolete: RuleImplementation = {
  id: 'schema-sitelinks-searchbox-obsolete',
  evaluate(context) {
    const problems: Problem[] = [];
    for (const { graph } of graphs(sitePages(context.site))) {
      for (const website of nodesOfType(graph, 'WebSite')) {
        for (const action of nodesAt(graph, website, 'potentialAction').filter(node => isA(node.types, 'SearchAction'))) {
          problems.push({ reason: 'present', severity: 'info', subject: 'SearchAction', evidence: cite(context, graph, action, 'WebSite SearchAction') });
        }
      }
    }
    return report(problems);
  },
};

const bcp47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const primary = (tag: string) => tag.split(/[-_]/u)[0]!.toLowerCase();

export const inLanguage: RuleImplementation = {
  id: 'schema-inlanguage',
  evaluate(context) {
    const problems: Problem[] = [];
    for (const { page, graph } of graphs(sitePages(context.site))) {
      const lang = graph.doc.parsed.htmlLang?.trim();
      for (const node of graph.nodes.filter(entry => entry.schemaOrg && (entry.parent === undefined || entry.parent.property === 'mainEntity')
        && (isA(entry.types, 'WebPage') || isA(entry.types, 'Article') || isA(entry.types, 'Event')))) {
        const tags = texts(graph, node, 'inLanguage').map(tag => tag.trim()).filter(Boolean);
        for (const tag of tags.filter(entry => !bcp47.test(entry))) {
          problems.push({ reason: 'invalid-tag', severity: 'low', subject: tag, evidence: cite(context, graph, node, 'inLanguage that is not a BCP 47 tag', 'inLanguage', tag) });
        }
        const valid = tags.filter(entry => bcp47.test(entry));
        if (lang && bcp47.test(lang) && valid.length > 0 && !valid.some(tag => primary(tag) === primary(lang))) {
          problems.push({ reason: 'contradicts-html-lang', severity: 'low', subject: `${valid.join(', ')} vs ${lang}`,
            evidence: cite(context, graph, node, `inLanguage that differs from html lang="${lang}"`, 'inLanguage'),
            also: [context.evidence.add({ kind: 'html', url: page.fetch.finalUrl, label: 'lang attribute of the html element', excerpt: lang })] });
        }
      }
    }
    return report(problems);
  },
};

const finiteWindow = 'MerchantReturnFiniteReturnWindow';
const term = (value: string | undefined) => value?.trim().replace(/^(?:https?:\/\/schema\.org\/|schema:)/iu, '');

export const returnPolicy: RuleImplementation = {
  id: 'schema-return-policy',
  evaluate(context) {
    const problems: Problem[] = [];
    let found = false;
    for (const { graph } of graphs(sitePages(context.site))) {
      for (const policy of nodesOfType(graph, 'MerchantReturnPolicy')) {
        found = true;
        const add = (reason: string, severity: Problem['severity'], subject: string, label: string, property?: string) =>
          problems.push({ reason, severity, subject, evidence: cite(context, graph, policy, label, property) });
        const category = term(text(graph, policy, 'returnPolicyCategory'));
        const optionA = has(graph, policy, 'applicableCountry') && category !== undefined;
        if (!optionA && !has(graph, policy, 'merchantReturnLink')) add('incomplete', 'medium', 'applicableCountry/returnPolicyCategory', 'return policy with neither applicableCountry and returnPolicyCategory nor merchantReturnLink');
        if (category === finiteWindow && !has(graph, policy, 'merchantReturnDays')) add('finite-without-days', 'medium', 'merchantReturnDays', 'finite return window without merchantReturnDays', 'returnPolicyCategory');
        const fees = term(text(graph, policy, 'returnFees'));
        const amounts = nodesAt(graph, policy, 'returnShippingFeesAmount');
        if (amounts.length > 0 && fees !== 'ReturnShippingFees') add('amount-without-shipping-fees', 'low', 'returnShippingFeesAmount', 'returnShippingFeesAmount without returnFees ReturnShippingFees', 'returnShippingFeesAmount');
        if (fees === 'ReturnShippingFees' && amounts.length === 0) add('shipping-fees-without-amount', 'low', 'returnShippingFeesAmount', 'ReturnShippingFees without returnShippingFeesAmount', 'returnFees');
        for (const amount of amounts) if (plainNumber(text(graph, amount, 'value') ?? '') === 0) add('zero-shipping-fee', 'low', 'returnShippingFeesAmount', 'return shipping fee of zero', 'returnShippingFeesAmount');
      }
      const referenced = new Set(nodesOfType(graph, 'Organization').flatMap(node => values(graph, node, 'hasMemberProgram'))
        .flatMap(value => (value.kind === 'ref' ? [value.id] : value.kind === 'node' && value.node.id ? [value.node.id] : [])));
      for (const program of nodesOfType(graph, 'MemberProgram')) {
        found = true;
        if (program.parent?.property === 'hasMemberProgram' || (program.id !== undefined && referenced.has(program.id))) continue;
        problems.push({ reason: 'member-program-outside-organization', severity: 'low', subject: text(graph, program, 'name') ?? 'MemberProgram',
          evidence: cite(context, graph, program, 'MemberProgram not defined under Organization.hasMemberProgram') });
      }
    }
    if (!found) return { outcome: 'not_applicable', reason: 'no-return-policy' };
    return report(problems);
  },
};

export const courseList: RuleImplementation = {
  id: 'schema-course-list',
  evaluate(context) {
    const problems: Problem[] = [];
    let found = false;
    for (const { graph } of graphs(sitePages(context.site))) {
      for (const course of nodesOfType(graph, 'Course')) {
        found = true;
        const gaps = ['name', 'description'].filter(property => !has(graph, course, property));
        if (gaps.length > 0) problems.push({ reason: 'course-incomplete', severity: 'low', subject: gaps.join(', '), evidence: cite(context, graph, course, `Course without ${gaps.join(', ')}`) });
      }
      for (const list of nodesOfType(graph, 'ItemList').filter(node => !isA(node.types, 'BreadcrumbList'))) {
        const courses = nodesAt(graph, list, 'itemListElement').flatMap(item => [item, ...nodesAt(graph, item, 'item')]).filter(node => isA(node.types, 'Course'));
        if (courses.length > 0 && courses.length < 3) {
          problems.push({ reason: 'too-few-courses', severity: 'low', subject: `${courses.length} courses`, evidence: cite(context, graph, list, 'course list with fewer than three courses') });
        }
      }
    }
    if (!found) return { outcome: 'not_applicable', reason: 'no-course' };
    return report(problems);
  },
};

const rolePrefix = /^(?:posted by|written by|by|por|per|escrito por|escrit per)\s/iu;
const placeholderAuthor = /^(?:admin|administrator|administrador|staff|editor|editorial|redacci[oó]n?|redacció|team|equipo|equip|webmaster|author|autor)$/iu;
const severalNames = /\s(?:and|y|i|et|und|&)\s|[,;]/u;

export const authorEntityQuality: RuleImplementation = {
  id: 'schema-author-entity-quality',
  evaluate(context) {
    const problems: Problem[] = [];
    const namesByIdentity = new Map<string, { name: string; evidence: string }>();
    const known = new Map(sitePages(context.site).map(page => [page.url, page]));
    let found = false;
    for (const { graph } of graphs(sitePages(context.site))) {
      for (const work of nodesOfType(graph, 'CreativeWork').filter(node => has(graph, node, 'author'))) {
        for (const value of values(graph, work, 'author')) {
          found = true;
          const person = value.kind === 'node' ? value.node : value.kind === 'ref' ? graph.byId.get(value.id)?.[0] : undefined;
          const name = value.kind === 'text' ? value.value.trim() : person ? text(graph, person, 'name') : undefined;
          const on = person ?? work;
          const property = person ? 'name' : 'author';
          const candidate = (reason: string, label: string) => problems.push({ reason, severity: 'low', subject: name ?? '', needsJudgment: true,
            evidence: cite(context, graph, on, label, property, name) });
          if (name && rolePrefix.test(name)) candidate('role-in-name', 'author name that starts with a byline word');
          else if (name && placeholderAuthor.test(name)) candidate('placeholder-author', 'author name that reads as a role or placeholder');
          else if (name && (!person || isA(person.types, 'Person')) && severalNames.test(name)) candidate('merged-names', 'several names in one author');
          if (!person || !name) continue;
          const identity = person.id ?? absoluteUrl(text(graph, person, 'url'), graph.base);
          if (identity) {
            const previous = namesByIdentity.get(identity);
            if (previous && normalizeName(previous.name) !== normalizeName(name)) {
              problems.push({ reason: 'inconsistent-names', severity: 'low', subject: `${previous.name} / ${name}`, needsJudgment: true,
                evidence: previous.evidence, also: [cite(context, graph, person, 'same author identity with another name', 'name', name)] });
            } else if (!previous) namesByIdentity.set(identity, { name, evidence: cite(context, graph, person, 'author name', 'name', name) });
          }
          const url = absoluteUrl(text(graph, person, 'url'), graph.base);
          const target = url ? known.get(url) : undefined;
          if (target && (target.fetch.status ?? 0) >= 400) {
            problems.push({ reason: 'broken-author-url', severity: 'low', subject: url!, evidence: cite(context, graph, person, `author url answering HTTP ${target.fetch.status}`, 'url', url) });
          }
        }
      }
    }
    if (!found) return { outcome: 'not_applicable', reason: 'no-authors' };
    return report(problems);
  },
};

export const featureOpportunity: RuleImplementation = {
  id: 'schema-feature-opportunity',
  evaluate(context) {
    const problems: Problem[] = [];
    for (const { page, graph } of graphs([...context.site.pages.values()])) {
      const ogType = metaProperty(graph.doc, 'og:type')[0];
      const kind = ogType?.attrs.content?.trim().toLowerCase();
      const has = (type: string) => nodesOfType(graph, type).length > 0;
      const candidate = (reason: string, subject: string, label: string, excerpt: string, line?: number) => problems.push({ reason, severity: 'low', subject, needsJudgment: true,
        evidence: context.evidence.add({ kind: 'html', url: page.fetch.finalUrl, label, excerpt, ...(line ? { line } : {}) }) });
      if (kind === 'article' && !has('Article')) candidate('article-markup-missing', page.fetch.finalUrl, 'og:type article on a page without Article markup', 'og:type article', ogType!.line);
      if (kind === 'product' && !has('Product')) candidate('product-markup-missing', page.fetch.finalUrl, 'og:type product on a page without Product markup', 'og:type product', ogType!.line);
      const depth = new URL(page.fetch.finalUrl).pathname.split('/').filter(Boolean).length;
      if (page.fetch.status === 200 && page.pageType !== 'home' && page.pageType !== 'legal' && page.pageType !== 'utility' && depth >= 2 && !has('BreadcrumbList')) {
        candidate('breadcrumb-missing', page.fetch.finalUrl, 'page two or more levels deep without BreadcrumbList markup', new URL(page.fetch.finalUrl).pathname);
      }
    }
    return report(problems);
  },
};

const consistencyKeys = ['name', 'legalName', 'logo', 'telephone', 'url'] as const;

function comparable(graph: PageGraph, node: GraphNode, key: (typeof consistencyKeys)[number]): string[] {
  if (key === 'logo') return imageUrls(graph, node, 'logo');
  if (key === 'url') return texts(graph, node, 'url').map(url => absoluteUrl(url, graph.base)).filter((url): url is string => url !== undefined).map(url => new URL(url).origin);
  if (key === 'telephone') return texts(graph, node, 'telephone').map(value => value.replace(/\D/gu, '').replace(/^00/u, ''));
  return texts(graph, node, key).map(brandOf);
}

export const entityConsistencySitewide: RuleImplementation = {
  id: 'schema-entity-consistency-sitewide',
  evaluate(context) {
    const located = graphs(sitePages(context.site));
    if (located.length < 2) return { outcome: 'not_evaluated', reason: 'single-page' };
    const owners = located.flatMap(({ graph }) => ownerOrganizations(graph).map(node => ({ graph, node })));
    if (owners.length === 0) return { outcome: 'not_applicable', reason: 'no-site-organization' };
    // A group with parent or sub-organizations has several legitimate entities.
    if (owners.some(({ graph, node }) => has(graph, node, 'parentOrganization') || has(graph, node, 'subOrganization'))) {
      return { outcome: 'not_applicable', reason: 'multi-brand-group' };
    }
    const problems: Problem[] = [];
    for (const key of consistencyKeys) {
      const seen: Array<{ values: Set<string>; graph: PageGraph; node: GraphNode }> = [];
      for (const owner of owners) {
        const own = new Set(comparable(owner.graph, owner.node, key));
        if (own.size === 0) continue;
        const clash = seen.find(entry => entry.graph !== owner.graph && ![...own].some(value => entry.values.has(value)));
        if (clash) {
          problems.push({ reason: 'conflicting-organization', severity: 'medium', subject: key, evidence: cite(context, clash.graph, clash.node, `Organization ${key}`, key === 'url' ? 'url' : key),
            also: [cite(context, owner.graph, owner.node, `Organization ${key} on another page`, key)] });
          break;
        }
        seen.push({ values: own, graph: owner.graph, node: owner.node });
      }
    }
    const ids = new Set(owners.map(({ graph, node }) => (node.id === undefined ? undefined : absoluteUrl(node.id, graph.base) ?? node.id)).filter(Boolean));
    if (ids.size > 1) {
      problems.push({ reason: 'several-organization-ids', severity: 'low', subject: `${ids.size} @id values`, evidence: cite(context, owners[0]!.graph, owners[0]!.node, 'site Organization @id', undefined, [...ids].join(' | ')) });
    }
    const siteNames = located.flatMap(({ graph }) => nodesOfType(graph, 'WebSite').map(node => ({ graph, node, names: new Set(texts(graph, node, 'name').map(brandOf)) })))
      .filter(entry => entry.names.size > 0);
    const clash = siteNames.find(entry => entry.graph !== siteNames[0]!.graph && ![...entry.names].some(name => siteNames[0]!.names.has(name)));
    if (clash) {
      problems.push({ reason: 'conflicting-website-name', severity: 'medium', subject: 'WebSite name', evidence: cite(context, siteNames[0]!.graph, siteNames[0]!.node, 'WebSite name', 'name'),
        also: [cite(context, clash.graph, clash.node, 'WebSite name on another page', 'name')] });
    }
    return report(problems);
  },
};
