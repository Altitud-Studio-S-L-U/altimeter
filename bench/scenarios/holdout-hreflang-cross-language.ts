import { htmlDocument, htmlResponse, page, replaceOnce, served, transform } from '../support/holdout.ts';
import { defineScenario } from '../support/scenario.ts';
import { studio, studioHosts } from '../support/studio.ts';

const en = '/en/services/custom-software/';
const es = '/es/servicios/software-a-medida/';
const ca = '/ca/serveis/programari-a-mida/';

const catalan = `<main>
<h1>Desenvolupament de programari a mida</h1>
<p>Quan cap producte del mercat no s'adapta a la manera de treballar de la teva empresa, dissenyem i construïm el programari que sí que ho fa, i ens assegurem que el teu equip el pugui mantenir quan acabem.</p>
<h2>Quan té sentit el programari a mida</h2>
<p>El programari a mida val la pena quan un procés dona avantatge a la teva empresa, quan diverses eines han de compartir les mateixes dades o quan les llicències de productes genèrics costen cada any més que construir la part que de debò necessites. Si un producte existent cobreix gairebé tota la feina, t'ho direm i el podem integrar.</p>
<h2>Com és un projecte</h2>
<p>Cada projecte comença amb una fase de descobriment d'una o dues setmanes amb les persones que faran servir el sistema. Després et presentem una proposta escrita amb l'abast, les fites i un preu tancat per a la primera versió.</p>
<p>Publiquem versions cada dues setmanes, amb proves automatitzades i un entorn de demostració, i acabem amb una entrega que inclou la documentació, els scripts de desplegament i formació per al teu equip.</p>
<h2>Tecnologia</h2>
<p>Treballem amb TypeScript, Node.js, Python i PostgreSQL, al proveïdor de núvol que ja fas servir o als servidors de la teva oficina quan les dades s'hi han de quedar.</p>
</main>`;

export default defineScenario({
  name: 'holdout-hreflang-cross-language',
  summary: 'A Spanish service page that canonicalises to the English one, in a cluster of en-GB, es-ES and a Catalan page declared as ca, without x-default; framing limited by CSP frame-ancestors.',
  hosts: studioHosts,
  build: context => {
    const site = studio(context);
    site.pageHeaders['content-security-policy'] = `${site.pageHeaders['content-security-policy']}; frame-ancestors 'self'`;
    delete site.pageHeaders['x-frame-options'];
    const links = [['en-GB', en], ['es-ES', es], ['ca', ca]].map(([lang, target]) => `<link rel="alternate" hreflang="${lang}" href="${site.url(target!)}">`).join('\n');
    for (const path of [en, es]) {
      const target = page(site, path);
      target.alternates = {};
      target.head = links;
    }
    transform(page(site, es), html => replaceOnce(html, `<link rel="canonical" href="${site.url(es)}">`, `<link rel="canonical" href="${site.url(en)}">`));
    const catalanPage = htmlDocument({
      lang: 'ca', title: 'Desenvolupament de programari a mida a València | Vellora Studio',
      head: `<meta name="description" content="Dissenyem i construïm programari a mida per a empreses de València i de tot Catalunya.">\n<link rel="canonical" href="${site.url(ca)}">\n${links}`,
      body: catalan,
    });
    site.routes.set(ca, htmlResponse(catalanPage, 200, { ...site.pageHeaders }));
    return served(site, es);
  },
  mustFail: [
    { rule: 'intl-canonical-cross-language', severity: 'high' },
    { rule: 'intl-hreflang-target-not-canonical' },
    { rule: 'intl-hreflang-no-language-catchall' },
  ],
  mustNotFail: [
    { rule: 'intl-hreflang-region-only-value', page: es },
    'tech-framing-protection',
  ],
});
