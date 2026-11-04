/**
 * Text of the synthetic studio the bench audits: an invented engineering studio on vellora.example, written for the
 * bench in English and Spanish. It mirrors the structure of a real small multilingual site, not its words.
 */

export type Locale = 'en' | 'es';
export type PageKind = 'home' | 'about' | 'service' | 'open-source' | 'legal' | 'privacy';

export const brand = 'Vellora Studio';
export const legalName = 'Vellora Studio SL';
export const founder = 'Marta Ferrer';
export const githubOrg = 'https://github.com/vellora-studio-bench';
export const founderProfile = 'https://www.linkedin.com/in/marta-ferrer-bench';

export interface PageText {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** The short label a breadcrumb trail shows. */
  readonly label: string;
  readonly h1: string;
  readonly lead: string;
  /** Main content after the hero, as HTML. */
  readonly body: string;
}

export interface Chrome {
  readonly nav: readonly (readonly [string, string])[];
  readonly languageName: string;
  readonly footer: string;
  readonly legal: string;
  readonly privacy: string;
  readonly consentTitle: string;
  readonly consentText: string;
  readonly consentAccept: string;
  readonly consentReject: string;
  readonly consentSettings: string;
  readonly preferencesTitle: string;
  readonly necessaryTitle: string;
  readonly necessaryText: string;
  readonly close: string;
  readonly ogLocale: string;
  readonly ogImageAlt: string;
}

export interface Faq {
  readonly question: string;
  readonly answer: string;
}

export interface Service {
  readonly name: string;
  readonly text: string;
  readonly image: string;
  readonly link?: string;
}

export interface HomeText {
  readonly servicesTitle: string;
  readonly servicesIntro: string;
  readonly serviceLink: string;
  readonly workTitle: string;
  readonly cases: readonly { readonly title: string; readonly text: string; readonly image: string }[];
  readonly faqTitle: string;
  readonly contactId: string;
  readonly contactTitle: string;
  readonly contactText: string;
  readonly nameLabel: string;
  readonly emailLabel: string;
  readonly messageLabel: string;
  readonly send: string;
  readonly skip: string;
  readonly breadcrumb: string;
}

export interface LocaleText {
  readonly chrome: Chrome;
  readonly home: HomeText;
  readonly services: readonly Service[];
  readonly faqs: readonly Faq[];
  readonly pages: Readonly<Record<PageKind, PageText>>;
}

const en: LocaleText = {
  chrome: {
    nav: [['/en/', 'Home'], ['/en/services/custom-software/', 'Services'], ['/en/open-source/', 'Open source'], ['/en/about/', 'About'], ['/en/#contact', 'Contact']],
    languageName: 'Espa\u00f1ol',
    footer: 'Engineering studio in Valencia, Spain.',
    legal: 'Legal notice',
    privacy: 'Privacy',
    consentTitle: 'Cookies and privacy',
    consentText: 'We only use the cookies this site needs to work. Analytics would load only after you accept them.',
    consentAccept: 'Accept analytics',
    consentReject: 'Necessary only',
    consentSettings: 'Preferences',
    preferencesTitle: 'Cookie preferences',
    necessaryTitle: 'Necessary',
    necessaryText: 'These cookies remember your language and your cookie choice. They cannot be turned off.',
    close: 'Close',
    ogLocale: 'en_US',
    ogImageAlt: 'Vellora Studio wordmark on a blue background',
  },
  home: {
    servicesTitle: 'What we build',
    servicesIntro: 'Four kinds of projects make up most of our work. Each one starts with a short discovery phase and ends with documentation, tests and a handover.',
    serviceLink: 'Read more about custom software',
    workTitle: 'Selected work',
    cases: [
      { title: 'Booking portal for a network of dental clinics', image: 'custom-software',
        text: 'Patients book and move appointments online, and each clinic sees its own calendar. Phone calls to the front desk fell by a third in the first quarter.' },
      { title: 'Stock dashboard for a wine distributor', image: 'data-platforms',
        text: 'Sales, warehouse and supplier data now meet in one daily report, so the team orders from real figures instead of last year\'s spreadsheet.' },
    ],
    faqTitle: 'Frequently asked questions',
    contactId: 'contact',
    contactTitle: 'Tell us about your project',
    contactText: 'Write a few lines about what you need. We answer every message within two working days.',
    nameLabel: 'Name',
    emailLabel: 'Email',
    messageLabel: 'Message',
    send: 'Send message',
    skip: 'Skip to content',
    breadcrumb: 'Breadcrumb',
  },
  services: [
    { name: 'Custom software development', image: 'custom-software', link: '/en/services/custom-software/',
      text: 'Internal tools, customer portals and integrations designed around the way your company already works, written in well-tested TypeScript and Python.' },
    { name: 'Data platforms', image: 'data-platforms',
      text: 'Pipelines that collect data from your systems, clean it and publish it in dashboards and reports that people actually open.' },
    { name: 'Process automation', image: 'automation',
      text: 'Repetitive steps such as invoicing, stock updates or customer onboarding, automated with clear logs and a manual fallback.' },
    { name: 'Technical consulting', image: 'consulting',
      text: 'Architecture reviews, code audits and hiring support for teams that need an experienced second opinion.' },
  ],
  faqs: [
    { question: 'How long does a typical project take?', answer: 'Most first versions are ready in six to twelve weeks. We agree on scope and budget before writing code and review progress with you every two weeks.' },
    { question: 'Do you work with existing code?', answer: 'Yes. Many projects start with an audit of an existing system, after which we tell you what to keep, what to rewrite and what each option costs.' },
    { question: 'Who owns the code?', answer: 'You do. The repository, the documentation and the deployment scripts belong to your company from the first commit.' },
    { question: 'Can you support the software after launch?', answer: 'We offer monthly support plans that cover updates, monitoring and small improvements, or we train your team to take over.' },
  ],
  pages: {
    home: {
      path: '/en/',
      title: 'Vellora Studio | Software engineering and data in Valencia',
      description: 'Engineering studio in Valencia. We help companies build custom software, data platforms and automation that their own teams can maintain.',
      label: 'Home',
      h1: 'Custom software, data and automation in Valencia <span class="tagline">Built to be shipped, built to last.</span>',
      lead: 'Vellora Studio is a small engineering team that designs, builds and maintains software for companies that have outgrown spreadsheets and off-the-shelf tools. We work in short iterations, explain every decision and hand over code your own team can run.',
      body: `<section class="how" data-reveal>
<h2>How we work</h2>
<ol class="steps">
<li><h3>Discovery</h3><p>Two or three workshops to understand your processes, your data and the people who will use the system every day.</p></li>
<li><h3>Prototype</h3><p>A clickable prototype or a thin working slice, so you can see the result before committing to the full budget.</p></li>
<li><h3>Delivery</h3><p>Releases every two weeks, each one tested, documented and deployed to an environment you can try.</p></li>
<li><h3>Support</h3><p>Monitoring, updates and small improvements once the system is live, for as long as you need them.</p></li>
</ol>
</section>`,
    },
    about: {
      path: '/en/about/',
      title: 'About Vellora Studio and founder Marta Ferrer',
      description: 'Vellora Studio is an engineering studio founded in Valencia by Marta Ferrer. Learn how we work, what we value and who you will work with.',
      label: 'About',
      h1: 'About Vellora Studio',
      lead: 'Vellora Studio was founded in 2019 by Marta Ferrer after ten years of building software for logistics and healthcare companies. The studio has stayed small on purpose: every client works directly with the engineers who write their code.',
      body: `<section>
<h2>Our founder</h2>
<img src="/images/team/founder.png" alt="Marta Ferrer at the studio in Valencia" width="640" height="640" loading="lazy">
<p>Marta studied computer engineering in Valencia and led development teams at two software companies before starting the studio. She still writes code every week and reviews every project before it goes live.</p>
</section>
<section>
<h2>How we started</h2>
<p>The first client was a family logistics company that needed a way to plan deliveries without retyping orders into three different systems. That project taught us to listen first, to automate only what people really repeat, and to leave every system documented well enough for someone else to run it.</p>
</section>
<section>
<h2>What we value</h2>
<ul>
<li>Clear estimates before any work starts.</li>
<li>Small, frequent releases that you can test yourself.</li>
<li>Documentation written for the people who will maintain the system.</li>
<li>Honest advice, including when the best answer is not to build anything.</li>
</ul>
<p>We work in English and Spanish with clients in Spain and the rest of Europe, mostly in logistics, retail and health services. Most of our projects last between three months and two years.</p>
</section>`,
    },
    service: {
      path: '/en/services/custom-software/',
      title: 'Custom software development in Valencia | Vellora Studio',
      description: 'We design and build custom software for companies in Valencia and across Spain: internal tools, portals and integrations, delivered in small steps.',
      label: 'Custom software development',
      h1: 'Custom software development',
      lead: 'When no product on the market fits the way your company works, we design and build the software that does, and we make sure your team can keep it running after we leave.',
      body: `<section>
<h2>When custom software makes sense</h2>
<p>Custom software is worth it when a process gives your company an edge, when several tools have to share the same data, or when licences for generic products cost more every year than building the part you really need. If an existing product covers most of the job, we will tell you, and we can integrate it instead.</p>
</section>
<section>
<h2>What a project looks like</h2>
<ol>
<li>A discovery phase of one or two weeks with the people who will use the system.</li>
<li>A written proposal with scope, milestones and a fixed price for the first version.</li>
<li>Releases every two weeks, with automated tests and a demo environment.</li>
<li>A handover with documentation, deployment scripts and training for your team.</li>
</ol>
</section>
<section>
<h2>Technology</h2>
<p>We build web applications with TypeScript, back ends with Node.js or Python, and we store data in PostgreSQL. Systems run on the cloud provider you already use, or on servers in your own office when the data has to stay there.</p>
</section>
<section>
<h2>Pricing</h2>
<p>First versions usually cost between fifteen and sixty thousand euros, depending on the number of integrations and users. Support plans start at a few hundred euros a month. <a href="/en/#contact">Tell us about your project</a> and we will reply within two working days.</p>
</section>`,
    },
    'open-source': {
      path: '/en/open-source/',
      title: 'Open source engineering tools | Vellora Studio',
      description: 'Small, well-documented open source tools we maintain for data imports, background jobs and testing, published under permissive licences.',
      label: 'Open source',
      h1: 'Open source',
      lead: 'We publish the small tools we write for our own projects when they can help other teams. Each one is documented, tested and released under a permissive licence.',
      body: `<section>
<h2>Projects</h2>
<h3>sheet-import</h3>
<p>Reads spreadsheets uploaded by users, checks every row against a schema and reports errors in plain language before anything reaches the database. <a href="${githubOrg}/sheet-import">sheet-import on GitHub</a></p>
<h3>queue-lite</h3>
<p>A background job queue on top of PostgreSQL for applications that do not need a separate message broker. <a href="${githubOrg}/queue-lite">queue-lite on GitHub</a></p>
<h3>fixture-kit</h3>
<p>Builders for realistic test data, so that tests describe the case they cover in a few lines instead of pages of setup. <a href="${githubOrg}/fixture-kit">fixture-kit on GitHub</a></p>
</section>
<section>
<h2>Contributing</h2>
<p>Issues and pull requests are welcome. Every repository explains how to run its tests, and we answer new issues within a week.</p>
</section>`,
    },
    legal: {
      path: '/en/legal/',
      title: 'Legal notice | Vellora Studio',
      description: 'Company details and terms of use of the Vellora Studio website.',
      label: 'Legal notice',
      h1: 'Legal notice',
      lead: 'This website belongs to Vellora Studio SL, a limited company registered in Valencia, Spain. You can reach us through the contact form on the home page.',
      body: `<section>
<h2>Terms of use</h2>
<p>The content of this website is provided for general information. We review it regularly, but it does not replace a written proposal for a specific project. The texts and images belong to Vellora Studio SL unless stated otherwise.</p>
</section>`,
    },
    privacy: {
      path: '/en/privacy/',
      title: 'Privacy policy | Vellora Studio',
      description: 'How Vellora Studio handles the personal data you send through the contact form.',
      label: 'Privacy',
      h1: 'Privacy policy',
      lead: 'We only collect the data you send through the contact form, and we use it only to answer your message.',
      body: `<section>
<h2>Your data</h2>
<p>Messages are kept for twelve months and then deleted. We never sell or share them. You can ask us to see, correct or delete your data at any time through the contact form.</p>
</section>`,
    },
  },
};

const es: LocaleText = {
  chrome: {
    nav: [['/es/', 'Inicio'], ['/es/servicios/software-a-medida/', 'Servicios'], ['/es/codigo-abierto/', 'C\u00f3digo abierto'], ['/es/sobre-nosotros/', 'Estudio'], ['/es/#contacto', 'Contacto']],
    languageName: 'English',
    footer: 'Estudio de ingenier\u00eda en Valencia, Espa\u00f1a.',
    legal: 'Aviso legal',
    privacy: 'Privacidad',
    consentTitle: 'Cookies y privacidad',
    consentText: 'Solo usamos las cookies que este sitio necesita para funcionar. La anal\u00edtica solo se cargar\u00eda despu\u00e9s de que la aceptes.',
    consentAccept: 'Aceptar anal\u00edtica',
    consentReject: 'Solo necesarias',
    consentSettings: 'Preferencias',
    preferencesTitle: 'Preferencias de cookies',
    necessaryTitle: 'Necesarias',
    necessaryText: 'Estas cookies recuerdan tu idioma y tu elecci\u00f3n sobre las cookies. No se pueden desactivar.',
    close: 'Cerrar',
    ogLocale: 'es_ES',
    ogImageAlt: 'Logotipo de Vellora Studio sobre fondo azul',
  },
  home: {
    servicesTitle: 'Qu\u00e9 construimos',
    servicesIntro: 'Cuatro tipos de proyectos forman la mayor parte de nuestro trabajo. Todos empiezan con una fase corta de descubrimiento y terminan con documentaci\u00f3n, pruebas y una entrega ordenada.',
    serviceLink: 'M\u00e1s sobre el software a medida',
    workTitle: 'Proyectos destacados',
    cases: [
      { title: 'Portal de citas para una red de cl\u00ednicas dentales', image: 'custom-software',
        text: 'Los pacientes reservan y cambian sus citas por internet, y cada cl\u00ednica ve su propia agenda. Las llamadas a recepci\u00f3n bajaron un tercio en el primer trimestre.' },
      { title: 'Panel de existencias para una distribuidora de vino', image: 'data-platforms',
        text: 'Los datos de ventas, del almac\u00e9n y de los proveedores se re\u00fanen ahora en un informe diario, y el equipo hace los pedidos con cifras reales en lugar de la hoja del a\u00f1o pasado.' },
    ],
    faqTitle: 'Preguntas frecuentes',
    contactId: 'contacto',
    contactTitle: 'Cu\u00e9ntanos tu proyecto',
    contactText: 'Escr\u00edbenos unas l\u00edneas sobre lo que necesitas. Respondemos a todos los mensajes en dos d\u00edas laborables.',
    nameLabel: 'Nombre',
    emailLabel: 'Correo electr\u00f3nico',
    messageLabel: 'Mensaje',
    send: 'Enviar mensaje',
    skip: 'Ir al contenido',
    breadcrumb: 'Ruta de navegaci\u00f3n',
  },
  services: [
    { name: 'Desarrollo de software a medida', image: 'custom-software', link: '/es/servicios/software-a-medida/',
      text: 'Herramientas internas, portales para clientes e integraciones dise\u00f1adas seg\u00fan la forma de trabajar de tu empresa, escritas en TypeScript y Python con pruebas.' },
    { name: 'Plataformas de datos', image: 'data-platforms',
      text: 'Procesos que recogen los datos de tus sistemas, los limpian y los publican en paneles e informes que la gente consulta de verdad.' },
    { name: 'Automatizaci\u00f3n de procesos', image: 'automation',
      text: 'Tareas repetitivas como la facturaci\u00f3n, el control de existencias o el alta de clientes, automatizadas con registros claros y una alternativa manual.' },
    { name: 'Consultor\u00eda t\u00e9cnica', image: 'consulting',
      text: 'Revisiones de arquitectura, auditor\u00edas de c\u00f3digo y apoyo en la contrataci\u00f3n para equipos que necesitan una segunda opini\u00f3n con experiencia.' },
  ],
  faqs: [
    { question: '\u00bfCu\u00e1nto dura un proyecto habitual?', answer: 'La mayor\u00eda de las primeras versiones est\u00e1n listas en un plazo de seis a doce semanas. Acordamos el alcance y el presupuesto antes de escribir c\u00f3digo y revisamos el avance contigo cada dos semanas.' },
    { question: '\u00bfTrabaj\u00e1is con c\u00f3digo existente?', answer: 'S\u00ed. Muchos proyectos empiezan con una auditor\u00eda del sistema actual, y despu\u00e9s te explicamos qu\u00e9 conservar, qu\u00e9 reescribir y cu\u00e1nto cuesta cada opci\u00f3n.' },
    { question: '\u00bfDe qui\u00e9n es el c\u00f3digo?', answer: 'Tuyo. El repositorio, la documentaci\u00f3n y los scripts de despliegue pertenecen a tu empresa desde el primer d\u00eda.' },
    { question: '\u00bfDais soporte despu\u00e9s del lanzamiento?', answer: 'Ofrecemos planes mensuales de soporte que incluyen actualizaciones, monitorizaci\u00f3n y peque\u00f1as mejoras, o formamos a tu equipo para que se encargue.' },
  ],
  pages: {
    home: {
      path: '/es/',
      title: 'Vellora Studio | Ingenier\u00eda de software y datos en Valencia',
      description: 'Estudio de ingenier\u00eda en Valencia. Ayudamos a las empresas a crear software a medida, plataformas de datos y automatizaciones que su equipo pueda mantener.',
      label: 'Inicio',
      h1: 'Software a medida, datos y automatizaci\u00f3n en Valencia <span class="tagline">Hecho para usarse, hecho para durar.</span>',
      lead: 'Vellora Studio es un equipo peque\u00f1o de ingenier\u00eda que dise\u00f1a, construye y mantiene software para empresas que ya no caben en una hoja de c\u00e1lculo ni en las herramientas gen\u00e9ricas. Trabajamos en iteraciones cortas, explicamos cada decisi\u00f3n y entregamos un c\u00f3digo que tu propio equipo puede gestionar.',
      body: `<section class="how" data-reveal>
<h2>C\u00f3mo trabajamos</h2>
<ol class="steps">
<li><h3>Descubrimiento</h3><p>Dos o tres talleres para entender tus procesos, tus datos y a las personas que usar\u00e1n el sistema cada d\u00eda.</p></li>
<li><h3>Prototipo</h3><p>Un prototipo navegable o una primera parte que ya funciona, para que veas el resultado antes de comprometer todo el presupuesto.</p></li>
<li><h3>Entrega</h3><p>Versiones cada dos semanas, cada una probada, documentada y publicada en un entorno que puedes usar.</p></li>
<li><h3>Soporte</h3><p>Monitorizaci\u00f3n, actualizaciones y peque\u00f1as mejoras cuando el sistema ya est\u00e1 en marcha, durante el tiempo que lo necesites.</p></li>
</ol>
</section>`,
    },
    about: {
      path: '/es/sobre-nosotros/',
      title: 'Sobre Vellora Studio y su fundadora, Marta Ferrer',
      description: 'Vellora Studio es un estudio de ingenier\u00eda fundado en Valencia por Marta Ferrer. Descubre c\u00f3mo trabajamos, qu\u00e9 valoramos y con qui\u00e9n trabajar\u00e1s.',
      label: 'Estudio',
      h1: 'Sobre Vellora Studio',
      lead: 'Marta Ferrer fund\u00f3 Vellora Studio en 2019, despu\u00e9s de diez a\u00f1os desarrollando software para empresas de log\u00edstica y de salud. El estudio sigue siendo peque\u00f1o a prop\u00f3sito: cada cliente trabaja directamente con las personas que escriben su c\u00f3digo.',
      body: `<section>
<h2>Nuestra fundadora</h2>
<img src="/images/team/founder.png" alt="Marta Ferrer en el estudio de Valencia" width="640" height="640" loading="lazy">
<p>Marta estudi\u00f3 ingenier\u00eda inform\u00e1tica en Valencia y dirigi\u00f3 equipos de desarrollo en dos empresas de software antes de crear el estudio. Todav\u00eda programa cada semana y revisa todos los proyectos antes de que se publiquen.</p>
</section>
<section>
<h2>C\u00f3mo empezamos</h2>
<p>El primer cliente fue una empresa familiar de log\u00edstica que necesitaba planificar los repartos sin copiar los pedidos en tres sistemas distintos. Aquel proyecto nos ense\u00f1\u00f3 a escuchar primero, a automatizar solo lo que de verdad se repite y a dejar cada sistema bien documentado para que otra persona pueda gestionarlo.</p>
</section>
<section>
<h2>Lo que valoramos</h2>
<ul>
<li>Presupuestos claros antes de empezar cualquier trabajo.</li>
<li>Versiones peque\u00f1as y frecuentes que puedes probar t\u00fa mismo.</li>
<li>Documentaci\u00f3n escrita para quienes mantendr\u00e1n el sistema.</li>
<li>Consejos sinceros, tambi\u00e9n cuando la mejor respuesta es no construir nada.</li>
</ul>
<p>Trabajamos en ingl\u00e9s y en espa\u00f1ol con clientes de Espa\u00f1a y del resto de Europa, sobre todo en log\u00edstica, comercio y servicios de salud. La mayor\u00eda de nuestros proyectos duran entre tres meses y dos a\u00f1os.</p>
</section>`,
    },
    service: {
      path: '/es/servicios/software-a-medida/',
      title: 'Desarrollo de software a medida en Valencia | Vellora Studio',
      description: 'Dise\u00f1amos y desarrollamos software a medida para empresas de Valencia y de toda Espa\u00f1a: herramientas internas, portales e integraciones, por fases.',
      label: 'Desarrollo de software a medida',
      h1: 'Desarrollo de software a medida',
      lead: 'Cuando ning\u00fan producto del mercado encaja con la forma de trabajar de tu empresa, dise\u00f1amos y construimos el software que s\u00ed lo hace, y nos aseguramos de que tu equipo pueda mantenerlo cuando terminemos.',
      body: `<section>
<h2>Cu\u00e1ndo tiene sentido el software a medida</h2>
<p>El software a medida compensa cuando un proceso da ventaja a tu empresa, cuando varias herramientas tienen que compartir los mismos datos o cuando las licencias de productos gen\u00e9ricos cuestan cada a\u00f1o m\u00e1s que construir la parte que de verdad necesitas. Si un producto existente cubre casi todo, te lo diremos y podemos integrarlo.</p>
</section>
<section>
<h2>C\u00f3mo es un proyecto</h2>
<ol>
<li>Una fase de descubrimiento de una o dos semanas con las personas que usar\u00e1n el sistema.</li>
<li>Una propuesta escrita con el alcance, los hitos y un precio cerrado para la primera versi\u00f3n.</li>
<li>Versiones cada dos semanas, con pruebas automatizadas y un entorno de demostraci\u00f3n.</li>
<li>Una entrega con documentaci\u00f3n, scripts de despliegue y formaci\u00f3n para tu equipo.</li>
</ol>
</section>
<section>
<h2>Tecnolog\u00eda</h2>
<p>Creamos aplicaciones web con TypeScript, servidores con Node.js o Python, y guardamos los datos en PostgreSQL. Los sistemas funcionan en el proveedor de nube que ya usas o en servidores de tu oficina cuando los datos deben quedarse all\u00ed.</p>
</section>
<section>
<h2>Precios</h2>
<p>Las primeras versiones suelen costar entre quince mil y sesenta mil euros, seg\u00fan el n\u00famero de integraciones y de usuarios. Los planes de soporte empiezan en unos cientos de euros al mes. <a href="/es/#contacto">Cu\u00e9ntanos tu proyecto</a> y te responderemos en dos d\u00edas laborables.</p>
</section>`,
    },
    'open-source': {
      path: '/es/codigo-abierto/',
      title: 'Herramientas de c\u00f3digo abierto | Vellora Studio',
      description: 'Herramientas de c\u00f3digo abierto peque\u00f1as y bien documentadas que mantenemos para importar datos, ejecutar tareas en segundo plano y probar software.',
      label: 'C\u00f3digo abierto',
      h1: 'C\u00f3digo abierto',
      lead: 'Publicamos las herramientas peque\u00f1as que escribimos para nuestros proyectos cuando pueden ayudar a otros equipos. Todas est\u00e1n documentadas, probadas y publicadas con una licencia permisiva.',
      body: `<section>
<h2>Proyectos</h2>
<h3>sheet-import</h3>
<p>Lee las hojas de c\u00e1lculo que suben los usuarios, comprueba cada fila con un esquema y explica los errores con palabras claras antes de que nada llegue a la base de datos. <a href="${githubOrg}/sheet-import">sheet-import en GitHub</a></p>
<h3>queue-lite</h3>
<p>Una cola de tareas en segundo plano sobre PostgreSQL para aplicaciones que no necesitan un sistema de mensajer\u00eda aparte. <a href="${githubOrg}/queue-lite">queue-lite en GitHub</a></p>
<h3>fixture-kit</h3>
<p>Funciones para crear datos de prueba realistas, de modo que cada prueba describa su caso en pocas l\u00edneas y no en p\u00e1ginas de preparaci\u00f3n. <a href="${githubOrg}/fixture-kit">fixture-kit en GitHub</a></p>
</section>
<section>
<h2>C\u00f3mo colaborar</h2>
<p>Las incidencias y las propuestas de cambios son bienvenidas. Cada repositorio explica c\u00f3mo ejecutar sus pruebas, y respondemos a las incidencias nuevas en menos de una semana.</p>
</section>`,
    },
    legal: {
      path: '/es/aviso-legal/',
      title: 'Aviso legal | Vellora Studio',
      description: 'Datos de la empresa y condiciones de uso del sitio web de Vellora Studio.',
      label: 'Aviso legal',
      h1: 'Aviso legal',
      lead: 'Este sitio web pertenece a Vellora Studio SL, una sociedad limitada inscrita en Valencia, Espa\u00f1a. Puedes escribirnos desde el formulario de contacto de la portada.',
      body: `<section>
<h2>Condiciones de uso</h2>
<p>El contenido de este sitio web es informativo. Lo revisamos con frecuencia, pero no sustituye a una propuesta escrita para un proyecto concreto. Los textos y las im\u00e1genes pertenecen a Vellora Studio SL salvo que se indique lo contrario.</p>
</section>`,
    },
    privacy: {
      path: '/es/privacidad/',
      title: 'Pol\u00edtica de privacidad | Vellora Studio',
      description: 'C\u00f3mo trata Vellora Studio los datos personales que env\u00edas con el formulario de contacto.',
      label: 'Privacidad',
      h1: 'Pol\u00edtica de privacidad',
      lead: 'Solo recogemos los datos que env\u00edas con el formulario de contacto y solo los usamos para responder a tu mensaje.',
      body: `<section>
<h2>Tus datos</h2>
<p>Los mensajes se guardan durante doce meses y despu\u00e9s se borran. Nunca los vendemos ni los compartimos. Puedes pedirnos que los consultemos, corrijamos o borremos en cualquier momento desde el formulario de contacto.</p>
</section>`,
    },
  },
};

export const content: Readonly<Record<Locale, LocaleText>> = { en, es };
