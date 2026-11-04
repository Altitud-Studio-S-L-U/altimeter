# Catalan glossary

Terms used in the Catalan rule catalog and report messages (`src/i18n/ca`), so that every rule says the same thing with the same word.

The terms follow TERMCAT (Cercaterm) and Softcatalà usage for computing and the web, and the labels the Catalan report already shows (`src/i18n/ui.ts`). When a rule needs a term that is not here, add it here first.

## Conventions

- Register: standard central Catalan (IEC), neutral and professional. Fixes use `tu` imperatives: «Afegeix», «Elimina», «Fes servir».
- Strength: must = «ha de», should = «hauria de», may = «pot» or «pot ser que», recommends = «recomana», requires = «requereix».
- Kept as written: rule ids, URLs, file names (robots.txt, llms.txt, sitemap.xml), HTTP status codes, methods and reason phrases (`HTTP 402 Payment Required`), header names (X-Robots-Tag, Retry-After), robots.txt fields and directives (user-agent, Disallow, Sitemap), robots values (noindex, nofollow, nosnippet), HTML elements and attributes, schema.org types and properties, code spans, `{placeholders}`, and product, feature and crawler names (Google, Search Console, AI Overviews, AI Mode, Discover, Googlebot, OAI-SearchBot, Lighthouse, Chrome UX Report, Core Web Vitals, JSON-LD, Open Graph, Cloudflare). Lighthouse audit ids stay as written (`lcp-discovery-insight`).
- Articles: file names are masculine («el robots.txt»); URL is feminine and invariable («la URL», «les URL», «d'URL»); the metrics take the article their spelling asks for («l'LCP», «l'INP», «el CLS», «el TTFB»); Core Web Vitals is feminine plural («les Core Web Vitals»); AI Overviews is feminine plural and AI Mode masculine.
- Acronyms are invariable in the plural: «els PDF», «les IP», «les API».
- Weak pronouns before a vowel are elided even before an unstressed i or u («l'indexi», «l'inclou»); the feminine article is not («la indexació», «la URL»).
- Numbers in prose take the decimal comma («0,1 s», «2,5 s», «1,91:1»). Thousands take a period from five digits («50.000»), and four-digit numbers have none («2048»); the numbers that code passes to a template are written this way for you. The percent sign takes a non-breaking space, written `5\u00a0%` in the JSON files; a share that code passes is written with `{share, number, percent}`, which adds it. Version numbers keep their dots («Lighthouse 13.6», «HTTP/1.1»), and so do values inside code or JSON examples.
- Quotations in prose use «», straight double quotes stay only inside markup and JSON (rel="canonical"), and apostrophes are always straight (').
- A count that can be 1 picks its form with a plural argument, `{count, plural, one {# valor no és vàlid} other {# valors no són vàlids}}`: `#` is the number, `other` is required, and each branch agrees its own verb and adjectives. Many strings instead put the count after a label («Enllaços trencats: {count}», «línies: {lines}»), which reads right for any number; keep that style where a string uses it. Older strings still use hedges («valor(s)», «element(s)», «anotació(ns)», «pàgina(es)»); give them a plural argument when you change them.
- No «de» right before a host placeholder, which some names would need as «d'»: write «l'amfitrió {host}» or put the host in parentheses («en un altre domini ({host})»).
- Code fills some placeholders with fixed words (`{band}`, `{scope}`, `{where}`, `{problem}`, language names, «i N més»), which `src/i18n/ca/values.json` translates and `Intl.DisplayNames` names; data such as URLs, numbers and text from the site stays as it is. Templates put those values after a colon or in parentheses («(franja: {band})», «(ubicació: {where})»), so that the sentence stays grammatical whatever the value.

## Crawling and indexing

| English | Català | Notes |
| --- | --- | --- |
| crawl (noun, verb) | rastreig, rastrejar | «durant el rastreig» |
| crawler | rastrejador | AI crawler = rastrejador d'IA; AI search and answer crawler = rastrejador de cerca i de respostes amb IA |
| crawlability | rastrejabilitat | as «indexabilitat» in the report |
| crawl budget, crawl rate | pressupost de rastreig, freqüència de rastreig | |
| fetch (verb, noun) | obtenir, obtenció | fetcher = agent d'obtenció; retrieve = recuperar |
| index, indexing | indexar, indexació | indexable, no indexable |
| render, rendering | renderitzar, renderització | rendered DOM = DOM renderitzat; client-side = al client; server-side = al servidor |
| raw HTML, server HTML | HTML en brut, HTML del servidor | as «dades en brut» |
| canonical, canonicalization | canònic, canònica; canonicalització | the canonical = la canònica; canonical URL = URL canònica |
| redirect (noun, verb) | redirecció, redirigir | redirect chain = cadena de redireccions; loop = bucle; hop = salt |
| soft 404 | soft 404 | Google's label, kept |
| sitemap | mapa del lloc | sitemap index = índex de mapes del lloc; the Sitemaps protocol, sitemap.xml and the Sitemap directive keep their names |
| robots.txt group | grup | the * group = el grup * |
| disallow (verb, noun) | prohibir el rastreig; regla Disallow | «El robots.txt prohibeix el rastreig a {agent}» |
| allow (a crawler) | permetre | «Permet OAI-SearchBot»; allowed = permès |
| user agent | agent d'usuari | |
| token (robots.txt product token) | identificador | not «testimoni», which is for authentication |
| robots meta tag | metaetiqueta robots | |
| header (HTTP) | capçalera | |
| request, response | sol·licitud, resposta | |
| host | amfitrió | preferred host = amfitrió preferit; hostname = nom d'amfitrió |
| path | camí | |
| trailing slash | barra final | |
| fully qualified URL, absolute URL | URL completa, URL absoluta | |
| the edge (CDN) | la vora de la xarxa | |
| staging | entorn de proves | |
| internal link, followed link | enllaç intern, enllaç que es pot seguir | not «enllaç seguit», which reads as «consecutive» |
| anchor text | text d'ancoratge | |
| homepage | pàgina d'inici | |
| duplicate, near-duplicate | duplicat, gairebé duplicat | |
| cluster | clúster | |

## Search appearance and content

| English | Català | Notes |
| --- | --- | --- |
| site, website | lloc, lloc web | as in the report |
| search engine | cercador | |
| Google Search, Google Images | la Cerca de Google, Google Imatges | |
| ranking | posicionament | ranking systems = sistemes de classificació |
| snippet | fragment | featured snippet = fragment destacat |
| title link | enllaç de títol | |
| meta description | metadescripció | |
| heading | encapçalament | main heading = encapçalament principal |
| main content, boilerplate | contingut principal, text de plantilla | |
| alt text | text alternatiu | |
| structured data, markup | dades estructurades, marcatge | |
| rich result | resultat enriquit | |
| eligible, eligibility | apte, elegibilitat | «pot optar a» for qualifies for |
| property (schema.org) | propietat | required = obligatòria; recommended = recomanada |
| item (structured data) | element | «element de dades estructurades» when HTML elements are nearby |
| placeholder | marcador de posició | placeholder title or value = títol, valor provisional |
| spam | contingut brossa | spam policies = polítiques contra el contingut brossa; link spam = enllaços brossa |
| keyword stuffing | farciment de paraules clau | |
| cloaking | encobriment | |
| doorway pages, scaled content abuse | pàgines porta, abús de contingut a gran escala | |
| thin (content, pages) | amb poc contingut | |
| people-first, helpful content | contingut centrat en les persones, contingut útil | |
| evergreen content | contingut perenne | |
| byline | signatura | |
| about page | pàgina «Qui som» | |
| breadcrumb | ruta de navegació | BreadcrumbList is kept |
| link preview | previsualització d'enllaç | |
| review, rating | ressenya, valoració | self-serving reviews = ressenyes interessades |
| merchant listing | fitxa de comerciant | |
| FAQ | PMF | FAQPage is kept |

## Performance and presentation

| English | Català | Notes |
| --- | --- | --- |
| field data, lab data | dades de camp, dades de laboratori | lab LCP = LCP de laboratori; at p75 = al p75 |
| form factor | factor de forma | phone = telèfon; desktop = ordinador |
| viewport | àrea de visualització | the viewport meta element = el meta viewport |
| layout, layout shift | disseny, desplaçament de disseny | the metric names (CLS, LCP, INP) are kept |
| render-blocking | que bloqueja la renderització | |
| lazy loading | càrrega diferida | lazy-loaded = carregat de manera diferida |
| preload, preconnect | precàrrega, preconnexió | |
| cache | memòria cau | back/forward cache = memòria cau endavant/enrere (bfcache) |
| first-party, third-party | propi, de tercers | |
| main thread | fil principal | |
| hero image | imatge destacada | |
| embed, facade | element incrustat, façana | |
| consent banner, cookie | bàner de consentiment, galeta | |
| interstitial, overlay, pop-up | intersticial, capa superposada, finestra emergent | |
| plugin, widget | connector, giny | |

## International

| English | Català | Notes |
| --- | --- | --- |
| hreflang annotation | anotació hreflang | hreflang set = conjunt hreflang |
| return link | enllaç de retorn | |
| language | llengua | language version = versió lingüística; language code = codi de llengua |
| locale | configuració regional | |
| subtag, script | subetiqueta, sistema d'escriptura | |
| fallback | alternativa, de reserva | |

## AI search

| English | Català | Notes |
| --- | --- | --- |
| AI, AI features | IA, funcions d'IA | |
| AI search | cerca amb IA | as «Cercadors i respostes amb IA» in the report |
| training | entrenament | training crawler = rastrejador d'entrenament |
| grounding | fonamentació | |
| opt out (of) | excloure (de) | |
| prompt injection | injecció d'indicacions | prompt = indicació |
| challenge (bot check) | desafiament | |

## Report vocabulary

| English | Català | Notes |
| --- | --- | --- |
| check, finding | comprovació, troballa | as in the report |
| evidence | evidència | |
| owner, owner data | propietari, dades del propietari | |
| candidate, analyst | candidat, analista | «l'analista ho hauria de confirmar» |
| sample, sampled | mostra, de la mostra | |
| data window | període | «durant el període», «sol·licituds dins del període»; not «finestra» |
