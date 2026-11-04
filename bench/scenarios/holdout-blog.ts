import { addPage, htmlResponse, replaceOnce, served, siteNodes, transform, webPage } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts, type Studio, type StudioPage } from '../support/studio.ts';

const index = '/en/blog/';
const older = '/en/blog/page/2/';
const estimating = '/en/blog/estimating-software-projects/';
const checklist = '/en/blog/data-platform-checklist/';
const pricing = '/en/blog/automation-pricing-guide/';
const handbook = '/en/blog/team-handbook/';
const draft = '/en/blog/team-handbook-draft/';
const broken = '/en/blog/failed-release-lessons/';

/** An English blog post: BlogPosting markup, og:type article and a breadcrumb through the blog. */
function post(site: Studio, path: string, fields: Partial<StudioPage> & Pick<StudioPage, 'title' | 'h1'>, posting: Record<string, unknown>): StudioPage {
  const url = site.url(path);
  const created = addPage(site, path, {
    ...fields,
    graph: [
      ...siteNodes(site), webPage(site, path, fields.title, { breadcrumb: { '@id': `${url}#breadcrumb` } }),
      { '@type': 'BlogPosting', '@id': `${url}#article`, headline: fields.h1, inLanguage: 'en', mainEntityOfPage: { '@id': `${url}#webpage` }, publisher: { '@id': `${site.origin}/#organization` }, ...posting },
      { '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`, itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: site.url('/en/') },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: site.url(index) },
        { '@type': 'ListItem', position: 3, name: fields.h1, item: url },
      ] },
    ],
  });
  transform(created, html => replaceOnce(html, '<meta property="og:type" content="website">', '<meta property="og:type" content="article">'));
  return created;
}

const card = (path: string, title: string, date: string, label: string, text: string) =>
  `<article><h3><a href="${path}">${title}</a></h3><p>${text}</p><p><time datetime="${date}">${label}</time></p></article>`;

export default defineScenario({
  name: 'holdout-blog',
  summary: 'A blog crawled from its index: posts with and without bylines, dates, images and qualified links, a stale year in a title, two canonicals that point at each other, page 2 canonicalised to page 1, hash routes, a tracking link and a post that answers 500.',
  hosts: studioHosts,
  options: { crawl: true, maxPages: 40 },
  build: context => {
    const site = studio(context);
    const sitemap = site.routes.get('/sitemap-0.xml');
    if (typeof sitemap !== 'function') throw new Error('holdout: the studio sitemap is not a handler');
    site.routes.set('/sitemap-0.xml', request => {
      const answer = sitemap(request);
      return { ...answer, body: String(answer.body).replaceAll('</loc>', '</loc><changefreq>weekly</changefreq><priority>0.8</priority>') };
    });
    site.routes.set(broken, htmlResponse('<!doctype html><title>Error</title><h1>Internal server error</h1>', 500));

    addPage(site, index, {
      title: 'Engineering notes | Vellora Studio',
      description: 'Notes from the Vellora Studio team on estimating, building and running custom software, data platforms and automation.',
      h1: 'Engineering notes', label: 'Blog',
      lead: 'What we learn on client projects, written up for the teams who will run the software after us.',
      body: `<section class="posts">
<h2>Latest notes</h2>
${card(estimating, 'How we estimate software projects', '2026-03-03', '3 March 2026', 'The three steps we follow before we put a price on a first version.')}
${card(checklist, 'A checklist for your first data platform', '2026-05-10', '10 May 2026', 'Eight questions to answer with the people who will read the reports.')}
${card(pricing, 'Process automation pricing guide 2026', '2026-02-01', '1 February 2026', 'What an automation project costs, from one workflow to a whole back office.')}
${card(handbook, 'Our team handbook', '2026-01-20', '20 January 2026', 'How we plan, review and hand over work.')}
${card(broken, 'What we learned from a failed release', '2026-01-08', '8 January 2026', 'A release that went wrong, and the checks we added afterwards.')}
</section>
<nav aria-label="Topics"><ul><li><a href="/en/blog/#/tag/data">Data</a></li><li><a href="/en/blog/#/tag/automation">Automation</a></li><li><a href="/en/blog/?tag=data&amp;tag=automation">Data and automation</a></li></ul></nav>
<p>Most read this month: <a href="${estimating}?utm_source=newsletter&amp;utm_medium=email">how we estimate software projects</a>.</p>
<p><a href="${older}">Older posts</a></p>`,
      graph: [...siteNodes(site), webPage(site, index, 'Engineering notes | Vellora Studio', { '@type': 'CollectionPage' })],
    });
    const second = addPage(site, older, {
      title: 'Engineering notes, page 2 | Vellora Studio',
      description: 'Older notes from the Vellora Studio team.',
      h1: 'Engineering notes, page 2', label: 'Blog, page 2',
      head: `<link rel="prev" href="${index}">`,
      body: `<section class="posts">
<h2>Older notes</h2>
${card(draft, 'Our team handbook (draft)', '2025-12-02', '2 December 2025', 'The first version of the handbook, kept for reference.')}
</section>
<p><a href="${index}">Newer posts</a></p>`,
      graph: [...siteNodes(site), webPage(site, older, 'Engineering notes, page 2 | Vellora Studio', { '@type': 'CollectionPage' })],
    });
    transform(second, html => replaceOnce(html, `<link rel="canonical" href="${site.url(older)}">`, `<link rel="canonical" href="${site.url(index)}">`));

    post(site, estimating, {
      title: 'How we estimate software projects | Vellora Studio',
      description: 'The three steps we follow to estimate a custom software project, and why a fixed price for the first version protects both sides.',
      h1: 'How we estimate software projects',
      lead: 'A good estimate is a short document that both sides can check later. This is how we write ours.',
      hero: '\n<p class="meta">Published <time datetime="2026-03-03">3 March 2026</time></p>',
      body: `<section>
<h2>Start from the work people repeat</h2>
<p>We begin every estimate by listing the tasks that the new system must take over, who does them today and how often. A task that happens forty times a day deserves more care than a report that someone opens once a quarter.</p>
<p>As an AI language model, I cannot give you a fixed price, but most estimates follow three steps: list the work, size each part, and add the risks that nobody can size yet.</p>
</section>
<section>
<h2>Size each part, then add the risks</h2>
<p>Each part gets a range rather than a single number. We add the integrations last, because they carry most of the uncertainty, and we write down every assumption so that a change of scope is easy to see.</p>
<p>If you want to go deeper, Steve McConnell's <a href="https://www.amazon.es/dp/0735605351?tag=vellorastudio-21">Software Estimation</a> is still the best book on the subject.</p>
</section>
<section class="comments" id="comments">
<h2>Comments</h2>
<article class="comment">
<p class="comment-name">Pau Ribes</p>
<p>We use a very similar method for our warehouse projects. I wrote it up in <a href="https://pau-ribes-consulting.example/notes/estimates">my notes on estimates</a>.</p>
</article>
</section>`,
    }, { datePublished: '2026-05-10', dateModified: '04/11/2026', author: { '@type': 'Person', name: 'Jordi Puig' } });

    const sound = post(site, checklist, {
      title: 'A checklist for your first data platform | Vellora Studio',
      description: 'Eight questions to answer before you choose any data tool, written for the people who will read the reports every week.',
      h1: 'A checklist for your first data platform',
      robots: 'index, follow, max-image-preview:large',
      lead: 'Before you choose any tool, answer these questions with the people who will use the reports.',
      hero: '\n<p class="byline">By <a rel="author" href="/en/about/">Marta Ferrer</a>, <time datetime="2026-05-10">10 May 2026</time></p>',
      body: `<img src="/images/services/data-platforms.png" alt="Sketch of data flowing from three systems into one report" width="1536" height="1024">
<section>
<h2>Questions to answer first</h2>
<p>Which decisions will the reports support? Who owns each source system? How fresh does each number need to be? Which figures do people argue about today, and why?</p>
<p>Some of the first drafts we review for clients come from a chat assistant and still carry its phrasing, for example:</p>
<blockquote><p>As an AI language model, I cannot access your systems, but a data platform usually has three layers.</p></blockquote>
<p>Delete that kind of sentence and write down what your own team knows instead.</p>
</section>
<section>
<h2>Further reading</h2>
<p><a href="https://www.amazon.es/dp/1098108302?tag=vellorastudio-21" rel="sponsored">Fundamentals of Data Engineering</a> explains the layers in more depth.</p>
</section>
<section class="comments" id="comments">
<h2>Comments</h2>
<article class="comment">
<p class="comment-name">Laia Vidal</p>
<p>Question four saved us months. Our version of the checklist is on <a href="https://laia-vidal-data.example/checklist" rel="ugc nofollow">my blog</a>.</p>
</article>
</section>`,
    }, {
      image: [site.url('/images/services/data-platforms.png')], datePublished: '2026-05-10', dateModified: '2026-06-01',
      author: { '@type': 'Person', name: 'Marta Ferrer', url: site.url('/en/about/') },
    });
    transform(sound, html => replaceOnce(html, '"@context":"https://schema.org"', '"@context":"http://schema.org/"'));

    post(site, pricing, {
      title: 'Process automation pricing guide 2024 | Vellora Studio',
      description: 'What a process automation project costs this year, from a single workflow to a full back office, and what drives the price.',
      h1: 'Process automation pricing guide 2026',
      lead: 'What an automation project costs this year, from a single workflow to a full back office.',
      hero: '\n<p class="meta">Updated <time datetime="2026-02-01">1 February 2026</time></p>',
      body: `<section>
<h2>One workflow</h2>
<p>Automating a single workflow, such as matching supplier invoices to orders, usually takes three to six weeks and costs between eight and fifteen thousand euros, including the logs and the manual fallback.</p>
</section>
<section>
<h2>A whole back office</h2>
<p>Larger projects connect invoicing, stock and onboarding. They run in phases of six to eight weeks, and each phase is priced on its own once the previous one is live.</p>
</section>`,
      afterMain: '<main><section><h2>Related services</h2><p><a href="/en/services/custom-software/">Custom software development</a></p></section></main>',
    }, {
      image: [site.url('/images/services/automation.png')], datePublished: '2026-02-01', dateModified: '2026-01-15',
      author: { '@type': 'Organization', name: 'Vellora Studio SL', url: site.origin },
    });

    const handbookPage = post(site, handbook, {
      title: 'Our team handbook | Vellora Studio', description: 'How the Vellora Studio team plans, reviews and hands over work.', h1: 'Our team handbook',
      lead: 'The handbook every new engineer reads in their first week.',
      body: '<section><h2>Planning</h2><p>Every project has a written plan that the client can read, with the decisions still open listed at the top.</p></section>',
    }, { image: [site.url('/images/og-default.png')], datePublished: '2026-01-20', author: { '@type': 'Person', name: 'Marta Ferrer' } });
    const draftPage = post(site, draft, {
      title: 'Our team handbook (draft) | Vellora Studio', description: 'The first draft of the Vellora Studio team handbook.', h1: 'Our team handbook (draft)',
      lead: 'The first draft of the handbook, kept for reference.', inSitemap: false,
      body: '<section><h2>Planning</h2><p>Every project has a written plan, reviewed with the client at the start of each phase.</p></section>',
    }, { image: [site.url('/images/og-default.png')], datePublished: '2025-12-02', author: { '@type': 'Person', name: 'Marta Ferrer' } });
    transform(handbookPage, html => replaceOnce(html, `<link rel="canonical" href="${site.url(handbook)}">`, `<link rel="canonical" href="${site.url(draft)}">`));
    transform(draftPage, html => replaceOnce(html, `<link rel="canonical" href="${site.url(draft)}">`, `<link rel="canonical" href="${site.url(handbook)}">`));
    return served(site, index);
  },
  mustFail: [
    { rule: 'schema-article', severity: 'medium', page: estimating },
    { rule: 'content-byline-author', severity: 'medium', page: estimating },
    { rule: 'content-image-preview-large', severity: 'low', page: estimating },
    { rule: 'content-date-consistency', severity: 'medium', page: estimating },
    { rule: 'schema-iso8601-values', page: estimating },
    { rule: 'content-ai-artifacts', severity: 'medium', page: estimating },
    { rule: 'content-paid-links-unqualified', severity: 'medium', page: estimating },
    { rule: 'content-ugc-link-qualifiers', severity: 'medium', page: estimating },
    { rule: 'content-title-obsolete-year', severity: 'medium', page: pricing },
    { rule: 'schema-date-logic', severity: 'medium', page: pricing },
    { rule: 'content-main-landmark', severity: 'low', page: pricing },
    { rule: 'crawl-js-fragment-routing', severity: 'high' },
    { rule: 'crawl-url-hygiene', severity: 'low' },
    { rule: 'crawl-parameter-urls', severity: 'medium' },
    { rule: 'crawl-server-errors-rate', severity: 'high' },
    { rule: 'crawl-canonical-pagination', severity: 'medium' },
    { rule: 'crawl-canonical-chains', severity: 'medium' },
    { rule: 'crawl-sitemap-ignored-tags', severity: 'info' },
  ],
  mustNotFail: [
    { rule: 'content-byline-author', page: checklist },
    { rule: 'content-image-preview-large', page: checklist },
    { rule: 'content-date-consistency', page: checklist },
    { rule: 'schema-iso8601-values', page: checklist },
    { rule: 'content-ai-artifacts', page: checklist },
    { rule: 'content-paid-links-unqualified', page: checklist },
    { rule: 'content-ugc-link-qualifiers', page: checklist },
    { rule: 'schema-jsonld-context', page: checklist },
    { rule: 'content-byline-author', page: pricing },
  ],
});
