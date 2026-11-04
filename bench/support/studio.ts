import { createHash } from 'node:crypto';
import { logoSvg, png } from './assets.ts';
import type { Handler, Origins, ScenarioContext, ScenarioSite } from './scenario.ts';
import type { BenchRequest, BenchResponse } from './server.ts';
import { brand, content, founder, founderProfile, githubOrg, legalName, type Locale, type PageKind } from './studio-content.ts';

/** The studio's hosts: the apex serves the site, www and plain http redirect to it. */
export const studioHosts = ['vellora.example', 'www.vellora.example'];

export interface StudioOptions {
  /** Status of the trailing-slash and index-file redirects; the tuned site answers 307. */
  readonly slashRedirect?: 301 | 307 | 308;
  /** A lastmod on every sitemap URL; the tuned site lists none. */
  readonly lastmod?: boolean;
  /** Organization.sameAs with the profiles the pages already link to; the tuned site has none. */
  readonly sameAs?: boolean;
  /** Breadcrumb names: the full SEO title with the brand suffix, as the tuned site has, or the short visible label. */
  readonly breadcrumbNames?: 'title' | 'label';
  /** A script-src that allows the one inline script by hash instead of 'unsafe-inline'. */
  readonly hashedCsp?: boolean;
  readonly twitterSite?: boolean;
}

/** One HTML page of the studio; scenarios edit these fields before the server starts. */
export interface StudioPage {
  readonly path: string;
  readonly locale: Locale;
  readonly kind: PageKind;
  title: string;
  description: string;
  /** The short label of the visible breadcrumb. */
  label: string;
  robots: string;
  /** The hero h1 and lead; the hero section is left out when both are empty. */
  h1: string;
  lead: string;
  /** Markup after the lead inside the hero, such as the service page's hero image. */
  hero: string;
  /** Main content after the hero, as HTML. */
  body: string;
  /** Markup added at the end of the head. */
  head: string;
  /** Markup between the main element and the footer. */
  afterMain: string;
  ogImage: string;
  /** Response headers that replace or add to the defaults; an empty value removes a default header. */
  headers: Record<string, string>;
  /** Compress the response when the client accepts it. */
  compress: boolean;
  /** The JSON-LD @graph nodes of the page. */
  graph: Record<string, unknown>[];
  inSitemap: boolean;
  /** Paths of the same page in each locale, for hreflang; empty for pages without translations. */
  alternates: Partial<Record<Locale, string>>;
  /** Sitemap lastmod when lastmod is on. */
  lastmod: string;
  /** A last edit of the rendered HTML, for changes the fields above cannot express. */
  transform?: (html: string) => string;
}

export interface Studio {
  /** `https://vellora.example:<port>`. */
  readonly origin: string;
  readonly pages: Map<string, StudioPage>;
  /** Routes of the https apex that are not pages: robots.txt, sitemaps, assets and the root redirect. */
  readonly routes: Map<string, Handler>;
  /** Response headers of every HTML page. */
  readonly pageHeaders: Record<string, string>;
  /** The robots.txt body. */
  robots: string;
  /** Answers unknown paths. */
  notFound: Handler;
  url(path: string): string;
  /** The response the server sends for a page. */
  respond(page: StudioPage): BenchResponse;
  /** A static file response with the site's caching and CDN headers. */
  file(type: string, body: string | Buffer, cacheControl?: string): BenchResponse;
  origins(): Origins;
}

const kinds: readonly PageKind[] = ['home', 'about', 'service', 'open-source', 'legal', 'privacy'];
const locales: readonly Locale[] = ['en', 'es'];
const lastmods: Readonly<Record<PageKind, string>> = {
  home: '2026-10-21', about: '2026-06-02', service: '2026-09-15', 'open-source': '2026-08-27', legal: '2026-01-12', privacy: '2026-01-12',
};
const serviceImages = ['custom-software', 'data-platforms', 'automation', 'consulting'];
const colours: Readonly<Record<string, readonly [number, number, number]>> = {
  'custom-software': [38, 84, 124], 'data-platforms': [42, 157, 143], automation: [233, 196, 106], consulting: [231, 111, 81],
};

const inlineScript = "document.documentElement.classList.add('js');";
const criticalCss = 'html{font-family:system-ui,sans-serif;line-height:1.5;color:#14213d;background:#fff}body{margin:0}';

const stylesheet = `*{box-sizing:border-box}
body{max-width:72rem;margin:0 auto;padding:0 1rem 12rem;font-size:1.0625rem}
img{max-width:100%;height:auto;display:block}
a{color:#205fa0}
.skip{position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}
.skip:focus{position:static;width:auto;height:auto}
.site-header{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between;padding:1rem 0}
.site-header nav ul{display:flex;flex-wrap:wrap;gap:.75rem;list-style:none;margin:0;padding:0}
.site-header nav a,.site-footer a{display:inline-block;padding:.75rem .25rem}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:700;text-decoration:none;color:inherit}
.brand img{width:40px;height:40px}
.hero h1{font-size:2.25rem;line-height:1.2;margin:1.5rem 0 1rem}
.hero .tagline{display:block;font-size:1.25rem;font-weight:400;color:#3d5a80;margin-top:.5rem}
.breadcrumbs ol{display:flex;gap:.5rem;list-style:none;padding:0;font-size:.95rem}
.breadcrumbs li+li::before{content:"/";margin-right:.5rem;color:#6b7280}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1.5rem;list-style:none;padding:0}
.cards article,.cases article{border:1px solid #d9e2ec;border-radius:.75rem;padding:1rem}
.steps{padding-left:1.25rem}
form{display:flex;flex-direction:column;gap:.75rem;max-width:32rem}
input,textarea,button{font:inherit;padding:.75rem;min-height:48px}
.site-footer{border-top:1px solid #d9e2ec;margin-top:3rem;padding:1.5rem 0;font-size:.95rem}
.site-footer ul{display:flex;flex-wrap:wrap;gap:1rem;list-style:none;padding:0}
.consent-banner{position:fixed;left:.5rem;right:.5rem;bottom:.5rem;z-index:20;max-width:34rem;background:#fff;border:1px solid #d9e2ec;border-radius:.75rem;padding:.75rem 1rem;box-shadow:0 8px 24px rgba(20,33,61,.15);font-size:.95rem}
.consent-banner h2{font-size:1rem;margin:0 0 .25rem}
.consent-banner p{margin:0 0 .5rem}
.consent-banner button{min-height:44px;margin:.25rem .25rem 0 0}
dialog{max-width:30rem;border:1px solid #d9e2ec;border-radius:.75rem}
html.js [data-reveal]{opacity:0;transform:translateY(1rem);transition:opacity .4s ease,transform .4s ease}
html.js [data-reveal].is-visible,html.js .hero [data-reveal]{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){html.js [data-reveal]{opacity:1;transform:none;transition:none}}
`;

// Sections reveal once they reach the upper 60% of the viewport, so the last ones stay at opacity 0 until the reader scrolls to them.
const script = `const items = document.querySelectorAll('[data-reveal]');
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('is-visible');
    observer.unobserve(entry.target);
  }
}, { rootMargin: '0px 0px -40% 0px' });
items.forEach(item => observer.observe(item));
const root = document.querySelector('[data-consent-root]');
const dialog = document.querySelector('[data-consent-dialog]');
document.querySelector('[data-consent-settings]')?.addEventListener('click', () => dialog?.showModal());
document.querySelector('[data-consent-close]')?.addEventListener('click', () => dialog?.close());
document.querySelector('[data-consent-reject]')?.addEventListener('click', () => {
  document.cookie = 'studio-consent=necessary; path=/; max-age=15552000; samesite=lax';
  root?.remove();
});
`;

const assetCss = '/assets/global.4f9a1c2e.css';
const assetJs = '/assets/site.8b3e2d1f.js';

export function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

export function weakEtag(body: string | Buffer): string {
  return `W/"${createHash('sha256').update(body).digest('hex').slice(0, 20)}"`;
}

/** A service illustration at its declared size, with the 768, 1152 and 1536 pixel candidates. */
function responsiveImage(name: string, sizes: string, alt: string, extra: string): string {
  const base = `/images/services/${name}`;
  return `<img src="${base}.png" srcset="${base}-768.png 768w, ${base}-1152.png 1152w, ${base}.png 1536w" sizes="${sizes}" width="1536" height="1024" alt="${alt}" ${extra}>`;
}

function headersOf(base: Readonly<Record<string, string>>, extra: Readonly<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(extra)) {
    if (value === '') delete merged[name];
    else merged[name] = value;
  }
  return merged;
}

/** Builds the studio site: an English and Spanish engineering studio shaped like the site the rules are tuned on. */
export function studio(context: ScenarioContext, options: StudioOptions = {}): Studio {
  const origin = context.origin('https://vellora.example');
  const url = (path: string) => `${origin}${path}`;
  const slashStatus = options.slashRedirect ?? 307;
  const scriptHash = createHash('sha256').update(inlineScript).digest('base64');
  const csp = [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", "form-action 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    `script-src 'self' ${options.hashedCsp ? `'sha256-${scriptHash}'` : "'unsafe-inline'"} https://www.googletagmanager.com`,
    "style-src 'self' 'unsafe-inline'", 'upgrade-insecure-requests',
  ].join('; ');
  const security: Record<string, string> = {
    server: 'cloudflare',
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
  // Static HTML revalidated at a CDN edge: max-age=0 with a validator, which is caching and not its absence.
  const pageHeaders: Record<string, string> = {
    'content-type': 'text/html',
    'cache-control': 'public, max-age=0, must-revalidate',
    'cf-cache-status': 'HIT',
    'content-security-policy': csp,
    ...security,
  };

  const organization = (): Record<string, unknown> => ({
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: legalName,
    alternateName: brand,
    url: origin,
    logo: `${origin}/logo.svg`,
    image: `${origin}/images/og-default.png`,
    address: { '@type': 'PostalAddress', addressLocality: 'Valencia', addressCountry: 'ES' },
    founder: { '@id': `${origin}/#founder` },
    knowsAbout: ['Custom software development', 'Data engineering', 'Process automation', 'TypeScript', 'PostgreSQL'],
    ...(options.sameAs ? { sameAs: [githubOrg] } : {}),
  });

  const services = (locale: Locale) => {
    const text = content[locale];
    const cards = text.services.map(service => `<li><article>
${responsiveImage(service.image, '(min-width: 64rem) 22rem, 90vw', '', 'loading="lazy" decoding="async"')}
<h3>${service.name}</h3>
<p>${service.text}</p>${service.link ? `
<p><a href="${service.link}">${text.home.serviceLink}</a></p>` : ''}
</article></li>`).join('\n');
    return `<section class="services">
<h2>${text.home.servicesTitle}</h2>
<p>${text.home.servicesIntro}</p>
<ul class="cards">
${cards}
</ul>
</section>`;
  };
  const work = (locale: Locale) => {
    const text = content[locale].home;
    return `<section class="cases" data-reveal>
<h2>${text.workTitle}</h2>
${text.cases.map(entry => `<article>
${responsiveImage(entry.image, '(min-width: 64rem) 30rem, 90vw', '', 'loading="lazy" decoding="async"')}
<h3>${entry.title}</h3>
<p>${entry.text}</p>
</article>`).join('\n')}
</section>`;
  };
  const faq = (locale: Locale) => {
    const text = content[locale];
    return `<section class="faq" data-reveal>
<h2>${text.home.faqTitle}</h2>
${text.faqs.map(entry => `<h3>${entry.question}</h3>
<p>${entry.answer}</p>`).join('\n')}
</section>`;
  };
  const contact = (locale: Locale) => {
    const text = content[locale].home;
    return `<section id="${text.contactId}" data-reveal>
<h2>${text.contactTitle}</h2>
<p>${text.contactText}</p>
<form method="POST" action="/api/contact" data-contact-form novalidate>
<label for="name-${locale}">${text.nameLabel}</label><input id="name-${locale}" name="name" autocomplete="name" required>
<label for="email-${locale}">${text.emailLabel}</label><input id="email-${locale}" name="email" type="email" autocomplete="email" required>
<label for="message-${locale}">${text.messageLabel}</label><textarea id="message-${locale}" name="message" rows="5" required></textarea>
<button type="submit">${text.send}</button>
</form>
</section>`;
  };

  const pages = new Map<string, StudioPage>();
  for (const locale of locales) {
    const text = content[locale];
    for (const kind of kinds) {
      const source = text.pages[kind];
      const canonical = url(source.path);
      const translations = Object.fromEntries(locales.map(other => [other, content[other].pages[kind].path])) as Record<Locale, string>;
      const graph: Record<string, unknown>[] = [
        organization(),
        { '@type': 'Person', '@id': `${origin}/#founder`, name: founder, jobTitle: locale === 'en' ? 'Founder and lead engineer' : 'Fundadora e ingeniera principal',
          worksFor: { '@id': `${origin}/#organization` }, sameAs: [founderProfile] },
        { '@type': 'WebSite', '@id': `${origin}/#website`, url: origin, name: brand, inLanguage: [...locales], publisher: { '@id': `${origin}/#organization` } },
        { '@type': kind === 'about' ? 'AboutPage' : 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: source.title, description: source.description,
          inLanguage: locale, isPartOf: { '@id': `${origin}/#website` }, about: { '@id': `${origin}/#organization` },
          ...(kind === 'home' ? {} : { breadcrumb: { '@id': `${canonical}#breadcrumb` } }) },
      ];
      if (kind === 'home') {
        graph.push({
          '@type': 'OfferCatalog', '@id': `${canonical}#services`, name: text.home.servicesTitle,
          itemListElement: text.services.map(service => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: service.name, description: service.text, provider: { '@id': `${origin}/#organization` } } })),
        });
        graph.push({
          '@type': 'FAQPage', '@id': `${canonical}#faq`,
          mainEntity: text.faqs.map(faq => ({ '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer } })),
        });
      } else {
        graph.push({
          '@type': 'BreadcrumbList', '@id': `${canonical}#breadcrumb`,
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: brand, item: url(text.pages.home.path) },
            { '@type': 'ListItem', position: 2, name: options.breadcrumbNames === 'label' ? source.label : source.title, item: canonical },
          ],
        });
      }
      if (kind === 'service') {
        graph.push({
          '@type': 'Service', '@id': `${canonical}#service`, name: source.label, serviceType: source.label, description: source.description,
          provider: { '@id': `${origin}/#organization` }, areaServed: [{ '@type': 'Country', name: 'Spain' }, { '@type': 'Place', name: 'Europe' }],
          mainEntityOfPage: { '@id': `${canonical}#webpage` },
        });
      }
      const indexable = kind !== 'legal' && kind !== 'privacy';
      const heroAlt = locale === 'en' ? 'Diagram of connected services drawn on a whiteboard' : 'Diagrama de servicios conectados dibujado en una pizarra';
      pages.set(source.path, {
        path: source.path, locale, kind, title: source.title, description: source.description, label: source.label,
        robots: indexable ? 'index, follow' : 'noindex, follow', h1: source.h1, lead: source.lead,
        hero: kind === 'service' ? `\n${responsiveImage('custom-software', '(min-width: 64rem) 60rem, 100vw', heroAlt, 'fetchpriority="high"')}` : '',
        body: kind === 'home' ? [services(locale), source.body, work(locale), faq(locale), contact(locale)].join('\n') : source.body,
        head: '', afterMain: '', ogImage: kind === 'service' ? '/images/social/custom-software.png' : '/images/og-default.png',
        headers: {}, compress: true, graph, inSitemap: indexable, alternates: indexable ? translations : {}, lastmod: lastmods[kind],
      });
    }
  }

  const render = (page: StudioPage): string => {
    const text = content[page.locale];
    const chrome = text.chrome;
    const canonical = url(page.path);
    const other = page.locale === 'en' ? 'es' : 'en';
    const hreflang = Object.keys(page.alternates).length === 0 ? '' : [
      ...locales.filter(locale => page.alternates[locale]).map(locale => `<link rel="alternate" hreflang="${locale}" href="${url(page.alternates[locale]!)}">`),
      `<link rel="alternate" hreflang="x-default" href="${url(page.alternates.en ?? page.path)}">`,
    ].join('\n');
    const switcher = page.alternates[other] ?? content[other].pages.home.path;
    const breadcrumb = page.kind === 'home' ? '' : `<nav class="breadcrumbs" aria-label="${text.home.breadcrumb}"><ol><li><a href="${text.pages.home.path}">${brand}</a></li><li aria-current="page">${page.label}</li></ol></nav>\n`;
    const hero = page.h1 === '' && page.lead === '' ? '' : `<section class="hero"><div data-reveal>
${breadcrumb}<h1>${page.h1}</h1>
<p class="lead">${page.lead}</p>${page.hero}
</div></section>
`;
    const ogTitle = page.kind === 'home' ? brand : page.title.replace(/ \| Vellora Studio$/u, '');
    const html = `<!doctype html>
<html lang="${page.locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<meta name="robots" content="${page.robots}">
<link rel="canonical" href="${canonical}">
${hreflang}
<link rel="sitemap" href="/sitemap-index.xml">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-96.png" sizes="96x96" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${brand}">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${escapeHtml(ogTitle)}">
<meta property="og:description" content="${escapeHtml(page.description)}">
<meta property="og:image" content="${url(page.ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(chrome.ogImageAlt)}">
<meta property="og:locale" content="${chrome.ogLocale}">
<meta property="og:locale:alternate" content="${content[other].chrome.ogLocale}">
<meta name="twitter:card" content="summary_large_image">${options.twitterSite ? '\n<meta name="twitter:site" content="@vellorastudio">' : ''}
<meta name="twitter:title" content="${escapeHtml(ogTitle)}">
<meta name="twitter:description" content="${escapeHtml(page.description)}">
<meta name="twitter:image" content="${url(page.ogImage)}">
<meta name="twitter:image:alt" content="${escapeHtml(chrome.ogImageAlt)}">
<link rel="stylesheet" href="${assetCss}">
<style>${criticalCss}</style>
<script>${inlineScript}</script>
<script type="module" src="${assetJs}"></script>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': page.graph })}</script>${page.head ? `\n${page.head}` : ''}
</head>
<body>
<a class="skip" href="#content">${text.home.skip}</a>
<header class="site-header">
<a class="brand" href="${text.pages.home.path}"><img src="/logo.svg" alt="" width="40" height="40"><span>${brand}</span></a>
<nav><ul>${chrome.nav.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}<li><a href="${switcher}" hreflang="${other}" lang="${other}">${chrome.languageName}</a></li></ul></nav>
</header>
<main id="content">
${hero}${page.body}
</main>${page.afterMain ? `\n${page.afterMain}` : ''}
<footer class="site-footer">
<p>${legalName}. ${chrome.footer}</p>
<ul><li><a href="${text.pages.legal.path}">${chrome.legal}</a></li><li><a href="${text.pages.privacy.path}">${chrome.privacy}</a></li><li><a href="${githubOrg}">GitHub</a></li><li><a href="${founderProfile}">LinkedIn</a></li></ul>
</footer>
<section class="consent-banner" data-consent-root data-gtm="" aria-labelledby="consent-title-${page.locale}">
<h2 id="consent-title-${page.locale}">${chrome.consentTitle}</h2>
<p>${chrome.consentText}</p>
<button type="button" data-consent-accept disabled>${chrome.consentAccept}</button><button type="button" data-consent-reject>${chrome.consentReject}</button><button type="button" data-consent-settings>${chrome.consentSettings}</button>
</section>
<dialog data-consent-dialog>
<h2>${chrome.preferencesTitle}</h2>
<h3>${chrome.necessaryTitle}</h3>
<p>${chrome.necessaryText}</p>
<button type="button" data-consent-close>${chrome.close}</button>
</dialog>
</body>
</html>
`;
    return page.transform ? page.transform(html) : html;
  };

  const respond = (page: StudioPage): BenchResponse => {
    const body = render(page);
    return { status: 200, headers: headersOf({ ...pageHeaders, etag: weakEtag(body) }, page.headers), body, compress: page.compress };
  };

  const sitemap = () => {
    const entries = [...pages.values()].filter(page => page.inSitemap).map(page => {
      const alternates = Object.keys(page.alternates).length === 0 ? [] : [
        ...locales.filter(locale => page.alternates[locale]).map(locale => `<xhtml:link rel="alternate" hreflang="${locale}" href="${url(page.alternates[locale]!)}"/>`),
        `<xhtml:link rel="alternate" hreflang="x-default" href="${url(page.alternates.en ?? page.path)}"/>`,
      ];
      return `<url><loc>${url(page.path)}</loc>${options.lastmod ? `<lastmod>${page.lastmod}</lastmod>` : ''}${alternates.join('')}</url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries.join('')}</urlset>\n`;
  };

  const llms = () => [
    `# ${brand}`,
    '',
    `> Engineering studio in Valencia, Spain. ${brand} builds custom software, data platforms and automation for small and medium companies, in English and Spanish.`,
    '',
    'The root URL sends visitors to /en/ or /es/; every page also exists at its own language URL.',
    '',
    '## Services',
    `- [Custom software development](${url('/en/services/custom-software/')}): internal tools, portals and integrations.`,
    '',
    '## Studio',
    `- [About](${url('/en/about/')}): the founder, the team and how projects work.`,
    `- [Open source](${url('/en/open-source/')}): tools the studio maintains.`,
    '',
  ].join('\n');

  const file = (type: string, body: string | Buffer, cache = 'public, max-age=0, must-revalidate'): BenchResponse =>
    ({ status: 200, headers: { 'content-type': type, 'cache-control': cache, etag: weakEtag(body), server: 'cloudflare', 'cf-cache-status': 'HIT', 'x-content-type-options': 'nosniff' }, body });
  const immutable = 'public, max-age=31536000, immutable';

  const routes = new Map<string, Handler>();
  routes.set('/', (request: BenchRequest) => {
    const chosen = /(?:^|;\s*)studio-language=(en|es)\b/u.exec(String(request.headers.cookie ?? ''))?.[1] ?? 'en';
    const query = request.path.slice(request.pathname.length);
    return { status: 302, headers: { location: `/${chosen}/${query}`, 'cache-control': 'private, no-store', vary: 'Cookie', ...security }, body: '' };
  });
  routes.set('/sitemap-index.xml', () => file('application/xml', `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${url('/sitemap-0.xml')}</loc></sitemap></sitemapindex>\n`));
  routes.set('/sitemap-0.xml', () => file('application/xml', sitemap()));
  routes.set('/llms.txt', () => file('text/plain; charset=utf-8', llms()));
  routes.set('/logo.svg', file('image/svg+xml', logoSvg(brand)));
  routes.set('/favicon.svg', file('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="12" fill="#205fa0"/></svg>'));
  routes.set('/favicon-96.png', file('image/png', png(96, 96)));
  routes.set('/apple-touch-icon.png', file('image/png', png(180, 180)));
  routes.set('/images/og-default.png', file('image/png', png(1200, 630)));
  routes.set('/images/social/custom-software.png', file('image/png', png(1200, 630, colours['custom-software'])));
  routes.set('/images/team/founder.png', file('image/png', png(640, 640, [120, 110, 100])));
  for (const name of serviceImages) {
    routes.set(`/images/services/${name}.png`, file('image/png', png(1536, 1024, colours[name])));
    routes.set(`/images/services/${name}-768.png`, file('image/png', png(768, 512, colours[name])));
    routes.set(`/images/services/${name}-1152.png`, file('image/png', png(1152, 768, colours[name])));
  }
  routes.set(assetCss, file('text/css; charset=utf-8', stylesheet, immutable));
  routes.set(assetJs, file('text/javascript; charset=utf-8', script, immutable));

  const notFoundPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 | ${brand}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="${assetCss}">
</head>
<body>
<main><h1>Page not found</h1><p>The page you asked for does not exist. It may have moved, or the address may contain a typo.</p><p><a href="/en/">Go to the home page</a> or <a href="/es/">ir a la portada</a>.</p></main>
</body>
</html>
`;
  const site: Studio = {
    origin,
    pages,
    routes,
    pageHeaders,
    robots: `User-agent: *\nAllow: /\n\nSitemap: ${url('/sitemap-index.xml')}\n`,
    notFound: { status: 404, headers: { ...pageHeaders, 'content-type': 'text/html' }, body: notFoundPage },
    url,
    respond,
    file,
    origins(): Origins {
      const redirectToApex = (request: BenchRequest): BenchResponse => ({ status: 301, headers: { location: url(request.path), 'content-type': 'text/html' }, body: '' });
      const apex = (request: BenchRequest): BenchResponse => {
        const exact = routes.get(request.path) ?? routes.get(request.pathname);
        if (exact) return typeof exact === 'function' ? exact(request) : exact;
        if (request.pathname === '/robots.txt') return file('text/plain', site.robots);
        const page = pages.get(request.pathname);
        if (page) return respond(page);
        const query = request.path.slice(request.pathname.length);
        const folder = request.pathname.endsWith('/index.html') ? request.pathname.slice(0, -'index.html'.length) : `${request.pathname}/`;
        if (folder !== request.pathname && pages.has(folder)) {
          return { status: slashStatus, headers: { location: url(`${folder}${query}`), 'content-type': 'text/html', ...security }, body: '' };
        }
        return typeof site.notFound === 'function' ? site.notFound(request) : site.notFound;
      };
      return {
        'https://vellora.example': apex,
        'http://vellora.example': redirectToApex,
        'http://www.vellora.example': redirectToApex,
        'https://www.vellora.example': redirectToApex,
      };
    },
  };
  return site;
}

/** The studio after `edit` changed its pages or routes, with the URL to audit. */
export function studioSite(context: ScenarioContext, path: string, options: StudioOptions = {}, edit?: (site: Studio) => void): ScenarioSite {
  const site = studio(context, options);
  edit?.(site);
  return { origins: site.origins(), url: site.url(path) };
}
