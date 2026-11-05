# Spanish glossary

The Spanish (Spain) terms used to translate the rule catalog and report messages, so every translation names the same thing the same way.

## Conventions

- Neutral, professional Spanish as used in Spain. Fixes address the reader with tu imperatives (`Añade`, `Cambia`, `Elimina`), like the report interface in `src/i18n/ui.ts`. A title written as an English imperative (`Assess the multi-regional URL structure`) becomes an infinitive (`Evaluar la estructura de URLs multirregional`).
- A translation says exactly what the English says: the same strength (must: `debe`, should: `debería`, may: `puede`), the same numbers, units and conditions, and no added advice.
- Placeholders such as `{url}` and code spans stay exactly as written. Rule ids, URLs, HTTP status codes and methods, header names, HTML elements and attributes, schema.org types and properties, file names and product or crawler names are not translated. The English words that code fills into placeholders, such as band names, scopes or the end of a shortened list («y 3 más»), are translated in `src/i18n/es/values.json`, and language names come from `Intl.DisplayNames`; data such as URLs, numbers and text from the site stays as it is.
- Decimal numbers in prose take a decimal comma (`0,1`, `2,5 s`); numbers of five or more digits group thousands with a point (`50.000`), four-digit numbers take no separator (`2048`). The numbers that code passes to a template are written this way for you. Versions keep their point (`HTTP/1.1`, `WCAG 2.2`, `Lighthouse 13.6`), and so do literal values a format requires, such as a JSON price.
- Units are separated from the number by a plain space (`20 px`). The percent sign takes a non-breaking space, written `5\u00a0%` in the JSON files; a share that code passes is written with `{share, number, percent}`, which adds it.
- Quoted words, labels and short literal values take angle quotes (`«ca»`, `«Block»`, `«{title}»`); code such as HTML, JSON or a header value keeps its own quotes. Apostrophes are straight (`'`) and spaces are plain, except the one before the percent sign.
- A count that can be 1 picks its form with a plural argument, `{count, plural, one {# valor no es válido} other {# valores no son válidos}}`: `#` is the number, `other` is required, and each branch agrees its own verb and adjectives. A count may instead follow a label (`Enlaces rotos: {count}`), which reads right for any number. Older strings still use `(s)` or `(es)` endings (`valor(es)`, with the verb in the plural); give them a plural argument when you change them.
- The plural of URL is `URLs`, as in Google Search Central and Search Console in Spanish; other acronyms stay invariable (`los CMS`, `las API`).
- Events the audit observed take the present perfect, as in the report interface (`ha respondido`, `se han encontrado`).
- Google's products keep their official Spanish names: `Búsqueda de Google`, `Google Imágenes`, `Vistas creadas con IA`, `Modo IA`, `Aplicaciones de Gemini`, `Perfil de Empresa en Google`, `Inspección de URLs`.

## Terms

### Crawling and indexing

| English | Spanish | Notes |
| --- | --- | --- |
| crawl (verb), crawl (noun) | rastrear, rastreo | |
| crawler | rastreador | AI crawler: `rastreador de IA`; smartphone crawler: `rastreador para smartphones` |
| index (verb), indexing | indexar, indexación | the index: `el índice`; mobile-first indexing: `indexación centrada en los móviles` |
| render (verb), rendering | renderizar, renderizado | render-blocking: `que bloquea el renderizado` |
| raw HTML, server HTML | HTML original, HTML del servidor | rendered DOM: `DOM renderizado` |
| canonical URL, canonicalization | URL canónica, canonicalización | canonical target: `destino canónico`; self-referencing: `autorreferenciada` |
| redirect (noun), redirect (verb) | redirección, redirigir | permanent, temporary: `permanente`, `temporal`; chain: `cadena de redirecciones` |
| sitemap | sitemap | plural `sitemaps`; sitemap index: `índice de sitemaps` |
| robots.txt group, rule | grupo, regla | the * group: `el grupo *` |
| disallow (verb), a disallow | bloquear, una regla disallow | Google writes `bloquear con la regla disallow` |
| noindex | noindex | a noindex rule: `una regla noindex`; a page that is noindex: `lleva noindex` |
| robots meta tag | etiqueta meta robots | |
| HTTP header | cabecera HTTP | Google writes `encabezado`; here `encabezado` is kept for headings |
| soft 404 | soft 404 | as in Search Console |
| user agent | user-agent | user-agent token: `token de user-agent` |
| fetch (verb), fetcher | obtener, fetcher | a fetch a user starts: `una solicitud que inicia un usuario`; prefetch: `obtener por adelantado` |
| request, requests from crawlers | solicitud, solicitudes de rastreadores | not `petición`; HTTP request: `solicitud HTTP` |
| internal link, anchor text | enlace interno, texto del enlace | followed link: `enlace follow` |
| URL fragment | identificador de fragmento | or `fragmento de la URL`; `fragmento` alone means a snippet |
| home page | página de inicio | |
| staging host | host de preproducción | |
| probe | sondeo | |
| edge, challenge (CDN) | perímetro, desafío | |
| URL Inspection, page indexing report | Inspección de URLs, informe Indexación de páginas | status names as in Search Console: `Rastreada: actualmente sin indexar` |

### Content and search appearance

| English | Spanish | Notes |
| --- | --- | --- |
| title, title link | título, enlace de título | |
| snippet | fragmento | code snippet: `fragmento de código` |
| meta description | metadescripción | |
| heading, main heading | encabezado, encabezado principal | |
| main content | contenido principal | |
| boilerplate, template text | texto de plantilla | |
| keyword stuffing | exceso de palabras clave | |
| alt text | texto alternativo | |
| byline | firma | |
| helpful, reliable, people-first content | contenido útil, fiable y centrado en las personas | E-E-A-T: experiencia, conocimientos, autoridad y fiabilidad |
| guidance, guidelines | documentación, directrices | rater guidelines: `directrices para evaluadores` |
| spam policies | políticas de spam | |
| cloaking, doorway pages | encubrimiento, páginas puerta | |
| scaled content abuse | abuso de contenido a gran escala | |
| scraped content, hacked content | contenido extraído, contenido hackeado | |
| thin affiliate pages | páginas de afiliación sin valor | affiliate link: `enlace de afiliado` |
| user-generated content | contenido generado por usuarios | |
| rank, ranking | posicionar, posicionamiento | ranking factor: `factor de posicionamiento` |
| search results, query | resultados de búsqueda, consulta | |
| surfaces | superficies | as in `superficies de Google` |
| eligible, eligibility | apto, posibilidad de aparecer | |
| image preview | vista previa de imagen | |
| above the fold | mitad superior de la página | |
| freshness | actualidad | |
| assistive technology | tecnologías de apoyo | |
| about page | página «Quiénes somos» | contact page: `página de contacto` |

### Structured data

| English | Spanish | Notes |
| --- | --- | --- |
| structured data, markup | datos estructurados, marcado | |
| item | elemento | |
| Microdata | microdatos | |
| rich result | resultado enriquecido | Rich Results Test: `prueba de resultados enriquecidos` |
| required, recommended property | propiedad obligatoria, propiedad recomendada | |
| review, rating, review snippet | reseña, valoración, fragmento de reseña | self-serving reviews: `reseñas en beneficio propio` |
| product snippet, merchant listing | fragmento de producto, ficha de comercio | |
| breadcrumb | ruta de exploración | |
| job posting | oferta de empleo | |
| consumers (of the data) | consumidores | |

### International

| English | Spanish | Notes |
| --- | --- | --- |
| hreflang annotation, hreflang target | anotación hreflang, destino de hreflang | |
| hreflang cluster | grupo | |
| return link | enlace recíproco | |
| language version, localized version | versión de idioma, versión localizada | |
| locale | configuración regional | locale-adaptive pages: `páginas adaptadas a la configuración regional` |
| language code, region code | código de idioma, código de región | ISO 3166-1 alpha-2: `ISO 3166-1 alfa-2` |
| subtag, script (BCP 47) | subetiqueta, sistema de escritura | language-Script-REGION: `idioma-Escritura-REGIÓN` |
| country-code TLD | TLD geográfico, ccTLD | |
| fallback page | página de respaldo | |

### Performance

| English | Spanish | Notes |
| --- | --- | --- |
| field data, lab data | datos de campo, datos de laboratorio | field LCP: `el LCP de campo`; metric abbreviations are masculine |
| 75th percentile | percentil 75 | at p75: `en el p75` |
| form factor, device type | factor de forma, tipo de dispositivo | |
| good, needs improvement, poor | buena, necesita mejorar, deficiente | as in the Search Console report |
| layout shift | cambio de diseño | metric names such as Largest Contentful Paint stay in English |
| main thread, long task | hilo principal, tarea larga | |
| fetch priority | prioridad de recuperación | |
| preload, preconnect hint | precarga, indicación preconnect | |
| lazy loading | carga en diferido | |
| back/forward cache | caché de atrás y adelante (bfcache) | |
| viewport | viewport | |
| desktop, mobile | ordenador, móvil | |
| embed, facade | elemento insertado, fachada | |

### Technical and presentation

| English | Spanish | Notes |
| --- | --- | --- |
| consent banner | banner de consentimiento | |
| interstitial, overlay | intersticial, capa superpuesta | |
| mixed content | contenido mixto | |

### AI search and answer engines

| English | Spanish | Notes |
| --- | --- | --- |
| AI search, answer engine | búsqueda con IA, motor de respuestas | search and answer crawlers: `rastreadores de búsqueda y de respuestas` |
| training, grounding | entrenamiento, fundamentación | |
| opt out | excluirse | |
| AI Overviews, AI Mode | Vistas creadas con IA, Modo IA | |

### Report vocabulary

| English | Spanish | Notes |
| --- | --- | --- |
| owner, owner data | propietario, datos del propietario | |
| candidate, analyst | candidato, analista | to be confirmed by the analyst: `Pendiente de que lo confirme el analista` |
| finding, check, evidence | hallazgo, comprobación, evidencia | |
| severity: critical, high, medium, low, info | severidad: crítica, alta, media, baja, informativa | feminine, agreeing with `severidad` |
| sampled | muestreado | sampled paths: `rutas muestreadas` |
| report (verb) | informar de, indicar | |
| referrer, referring hosts | URL de referencia, sitios de referencia | |

## Sources

Checked on 2026-11-04 against the Spanish versions of Google Search Central (developers.google.com/search/docs?hl=es), web.dev, the Lighthouse documentation and the Search Console Help Center. Google marks most of these pages as machine translations from English, so a term that reads wrongly in Spain was weighed against the Search Console Help Center, whose Spanish pages carry no such mark.
