/**
 * Deterministic language identification for page text, without network access or models.
 *
 * Each language has a list of frequent function words and of spelling features (letters, digraphs, word endings).
 * A word or feature listed for several languages is weighted down by how many languages share it, so shared words
 * such as "de" or "la" say little and words like "els", "dins" or "ningún" decide. Scores become probabilities with
 * a softmax, which keeps confidence low when two languages explain the text about equally well.
 */

export const detectableLanguages = ['ca', 'es', 'en', 'fr', 'pt', 'it', 'de', 'oc'] as const;
export type DetectableLanguage = (typeof detectableLanguages)[number];

export const languageNames: Readonly<Record<DetectableLanguage, string>> = {
  ca: 'Catalan', es: 'Spanish', en: 'English', fr: 'French', pt: 'Portuguese', it: 'Italian', de: 'German', oc: 'Occitan',
};

/** Below this many words the result is undetermined: function-word evidence is too thin to tell neighbours apart. */
export const minimumWords = 30;

export interface LanguageGuess {
  /** The detected language, or `und` when the text is too short or matches no known language well enough. */
  readonly language: DetectableLanguage | 'und';
  /** Probability of the detected language against the others, 0 to 1; 0 when undetermined. */
  readonly confidence: number;
  readonly words: number;
  /** The highest-scoring language even when the result is undetermined, for diagnostics. */
  readonly best: DetectableLanguage | undefined;
  readonly runnerUp: DetectableLanguage | undefined;
}

export interface DetectOptions {
  /** Overrides `minimumWords`, for callers that aggregate several short blocks themselves. */
  readonly minWords?: number;
}

const words: Readonly<Record<DetectableLanguage, string>> = {
  ca: `el la els les l' un una uns unes de del dels d' a al als en amb per pel pels què que qui i o però perquè com quan on
    també molt molta molts moltes més menys és són era eren ha han he hem heu hi ho li ens us em et es se s' n' m' t' 'n 'l 'ls
    meu meva teu teva seu seva seus seves nostre nostra nostres vostre vostra aquest aquesta aquests aquestes aquell aquella
    això allò aquí allà ara sempre mai res tot tota tots totes cada altre altra altres fins entre sense sobre sota des cap
    després abans encara només així doncs ja sí no pot poden fer fa fan tenir té tenen ser estar està estan vol volem podem
    any anys dia nou nova servei serveis empresa nosaltres vosaltres ells elles tenim oferim qualsevol mitjançant mentre
    segons durant cal fet feta aleshores llavors gràcies benvinguts benvingut contacte inici idioma català catalana nostres
    vostres seua seues aquesta perquè també feina gent lloc món treball projecte projectes sabem volem ajudar ajudem nosaltres`,
  es: `el la los las lo un una unos unas de del a al en con por para que qué quien quién y e o u pero porque como cuando
    donde dónde también muy mucho mucha muchos muchas más menos es son era eran fue ha han he hemos habéis hay se su sus le
    les nos os me te mi mis tu tus nuestro nuestra nuestros nuestras vuestro vuestra este esta estos estas ese esa eso aquel
    aquella esto aquí allí ahora siempre nunca nada todo toda todos todas cada otro otra otros otras hasta entre sin sobre
    bajo desde después antes todavía aún solo sólo así pues ya sí no puede pueden hacer hace hacen tener tiene tienen ser
    estar está están quiere podemos año años día nuevo nueva servicio servicios empresa nosotros vosotros ellos ellas usted
    ustedes tenemos ofrecemos cualquier mediante mientras según durante hecho entonces gracias bienvenido bienvenidos
    contacto inicio idioma español castellano trabajo proyecto proyectos sabemos queremos ayudar ayudamos gente lugar mundo`,
  en: `the a an of to in and or but for with on at by from as is are was were be been being have has had do does did will
    would can could should may might must this that these those it its we our you your they their them he she his her not
    no yes all any each more most other some such only also very just than then there here when where which who what how
    why about into over after before between under again new services company contact home language english page us it's
    don't we're you're can't i my me get make our out up so if one two work project projects help people place world know`,
  fr: `le la les l' un une des du de d' à au aux en dans et ou mais pour par avec sur sous chez que qu' qui quoi dont où quand
    comme aussi très plus moins est sont était étaient a ont ai avons avez être avoir fait faire peut peuvent ce cet cette ces
    ceci cela ça il ils elle elles nous vous je tu on se s' son sa ses leur leurs notre nos votre vos mon ma mes ne n' pas
    jamais rien tout toute tous toutes chaque autre autres entre sans depuis après avant encore seulement ainsi donc déjà oui
    non nouveau nouvelle service services entreprise accueil contact merci bienvenue langue français française travail projet
    projets savons voulons aider aidons gens lieu monde c' j' y`,
  pt: `o a os as um uma uns umas de do da dos das em no na nos nas ao aos à às com por pelo pela pelos pelas para que quem e
    ou mas porque como quando onde também muito muita muitos muitas mais menos é são era eram foi tem têm há se seu sua seus
    suas lhe me te meu minha nosso nossa nossos nossas este esta estes estas esse essa isso aquele aquela isto aqui ali agora
    sempre nunca nada tudo todo toda todos todas cada outro outra outros outras até entre sem sobre desde depois antes ainda
    só apenas assim pois já sim não pode podem fazer faz fazem ter ser estar está estão quer podemos ano anos dia novo nova
    serviço serviços empresa nós vocês você eles elas temos oferecemos qualquer enquanto segundo durante feito então obrigado
    obrigada contato contacto início idioma português trabalho projeto projetos sabemos queremos ajudar ajudamos pessoas lugar mundo`,
  it: `il lo la i gli le l' un uno una un' di del dello della dei degli delle d' a al allo alla ai agli alle da dal dalla dai
    in nel nello nella nei negli nelle con su sul sulla per tra fra che chi cui e ed o ma perché come quando dove anche molto
    molta molti molte più meno è sono era erano ha hanno ho abbiamo avete essere avere fare può possono questo questa questi
    queste quello quella quelli ciò qui qua ora adesso sempre mai niente nulla tutto tutta tutti tutte ogni altro altra altri
    altre fino senza sopra sotto dopo prima ancora solo così quindi già sì non si suo sua suoi sue loro nostro nostra nostri
    nostre vostro mio mia ci vi ne nuovo nuova servizio servizi azienda contatti grazie benvenuto lingua italiano lavoro
    progetto progetti sappiamo vogliamo aiutare aiutiamo persone luogo mondo`,
  de: `der die das den dem des ein eine einen einem einer eines und oder aber denn für mit von zu zum zur bei nach aus auf in
    im an am um über unter vor durch gegen ohne bis seit dass daß wie wenn als wo was wer warum auch sehr mehr weniger ist
    sind war waren hat haben habe wird werden wurde kann können muss müssen soll sollen will wollen nicht kein keine ja nein
    alle alles jeder jede jedes andere anderen dieser diese dieses sich sie er es wir ihr ich du uns unser unsere ihre ihren
    sein seine noch nur schon immer hier dort jetzt dann neue neuen dienst dienstleistungen unternehmen kontakt startseite
    sprache deutsch arbeit projekt projekte wissen helfen menschen ort welt`,
  oc: `lo la los las l' un una de del dels d' a al als en dins amb e o mas mai que qui ont quand coma tanben fòrça plan mens
    es son èra èran a an ai avèm avètz èsser èstre aver far fa fan pòt pòdon aquel aquela aquò aquí ara totjorn jamai res tot
    tota totes totas cada autre autra autres entre sens sus jos dempuèi aprèp abans encara sonque atal doncas ja òc non pas
    nòstre nòstra nòstres vòstre vòstra sa sos sas lor ieu el ela nosautres vosautres eles elas se s' i ne n' li lors quin
    quina lenga occitan occitana païs vila annada jorn nòu nòva servici empresa contacte mercés benvenguda eth era deth dera
    ena damb ei entà tà aué mès aranés istòria trabalh projècte ajudar gents luòc mond cal pas puèi nos vos`,
};

type FeatureKind = 'sub' | 'end' | 'start';
interface Feature { readonly kind: FeatureKind; readonly value: string }

/** Spelling features, written as `sub:x`, `end:x` or `start:x`; each counts once per word. */
const features: Readonly<Record<DetectableLanguage, string>> = {
  ca: 'sub:l·l sub:ny sub:aix sub:eix sub:oix sub:uix sub:ç sub:à sub:è sub:ò sub:qü sub:gü sub:tg sub:tj end:ció end:cions end:ts end:ig end:eu end:au sub:ix end:ó sub:ss',
  es: 'sub:ñ sub:¿ sub:¡ end:ción end:ciones end:dad end:ión sub:ue sub:ie sub:ll end:mente end:os sub:á sub:í sub:ó sub:ú end:ado end:ada end:ido',
  en: 'sub:th sub:wh sub:sh end:ing sub:ght end:ly sub:ee sub:oo sub:w end:y sub:k end:tion end:ed end:er sub:ea',
  fr: 'sub:eau sub:aux sub:oi sub:ou sub:œ sub:ê sub:â sub:î sub:û sub:ë sub:ï sub:ç end:ent end:ais end:ait end:eux end:tion sub:é sub:è sub:à end:ée sub:qu',
  pt: 'sub:ã sub:õ sub:ç end:ção end:ções sub:lh sub:nh end:ão sub:ê sub:ô end:em end:ou end:ade end:mente sub:á sub:é sub:í sub:ú',
  it: 'sub:zz sub:cch sub:ggi sub:gli end:zione end:zioni sub:ù sub:ì end:tà sub:tt sub:ss sub:pp sub:chi sub:che end:ono end:are end:ere sub:ò sub:è',
  de: 'sub:ß sub:ä sub:ö sub:ü sub:sch sub:cht end:ung sub:ei sub:ie sub:tz sub:pf sub:ck end:chen end:keit end:lich end:en sub:k sub:w',
  oc: 'sub:lh sub:nh sub:ò sub:à sub:è end:tz end:cion end:cions end:ament sub:òc sub:ç sub:ièr sub:uè end:ar end:at end:ada sub:á sub:ó',
};

const wordWeight = new Map<string, Map<DetectableLanguage, number>>();
const featureWeight = new Map<string, { readonly feature: Feature; readonly weights: Map<DetectableLanguage, number> }>();

// Weight 1 / (languages sharing the item): an item every candidate uses carries little evidence.
(() => {
  const owners = new Map<string, Set<DetectableLanguage>>();
  for (const language of detectableLanguages) {
    for (const word of words[language].split(/\s+/u).filter(Boolean)) {
      const set = owners.get(word) ?? new Set<DetectableLanguage>();
      set.add(language);
      owners.set(word, set);
    }
  }
  for (const [word, set] of owners) wordWeight.set(word, new Map([...set].map(language => [language, 1 / set.size])));
  const featureOwners = new Map<string, Set<DetectableLanguage>>();
  for (const language of detectableLanguages) {
    for (const entry of features[language].split(/\s+/u).filter(Boolean)) {
      const set = featureOwners.get(entry) ?? new Set<DetectableLanguage>();
      set.add(language);
      featureOwners.set(entry, set);
    }
  }
  for (const [entry, set] of featureOwners) {
    const [kind, value] = entry.split(':') as [FeatureKind, string];
    featureWeight.set(entry, { feature: { kind, value }, weights: new Map([...set].map(language => [language, 0.35 / set.size])) });
  }
})();

/** Evidence per word that running text in each language typically gathers, measured on the labelled test snippets. */
const density: Readonly<Record<DetectableLanguage, number>> = { ca: 0.26, es: 0.31, en: 0.63, fr: 0.39, pt: 0.26, it: 0.37, de: 0.74, oc: 0.26 };
const sharpness = 0.5;

const englishContraction = /^(?:\p{L}+)'(?:s|t|re|ve|ll|d|m)$/u;

/** Lowercase word tokens; elided articles and clitics keep their apostrophe (l', d', qu', 'ls). */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFC').toLowerCase().replace(/[’ʼ`´]/gu, "'").replace(/l\.l/gu, 'l·l').replace(/ŀl/gu, 'l·l');
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{L}·']+|[¿¡]/gu)) {
    const run = match[0].replace(/^'+|'+$/gu, '');
    if (run === '') continue;
    if (englishContraction.test(run)) {
      tokens.push(run);
      continue;
    }
    const parts = run.split("'").filter(Boolean);
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      if (!last) tokens.push(`${part}'`);
      // A short trailing clitic, as in "dóna'ls", is its own token.
      else if (index > 0 && part.length <= 2 && parts[index - 1]!.length > 2) tokens.push(`'${part}`);
      else tokens.push(part);
    }
  }
  return tokens;
}

function countWords(tokens: readonly string[]): number {
  return tokens.filter(token => /\p{L}{2,}/u.test(token) || /^\p{L}$/u.test(token)).length;
}

function hasFeature(token: string, feature: Feature): boolean {
  const bare = token.replace(/'/gu, '');
  if (feature.kind === 'sub') return bare.includes(feature.value);
  if (bare.length <= feature.value.length + 1) return false;
  return feature.kind === 'end' ? bare.endsWith(feature.value) : bare.startsWith(feature.value);
}

/** Raw evidence per language for a list of tokens. */
export function languageScores(tokens: readonly string[]): Record<DetectableLanguage, number> {
  const scores = Object.fromEntries(detectableLanguages.map(language => [language, 0])) as Record<DetectableLanguage, number>;
  for (const token of tokens) {
    for (const [language, weight] of wordWeight.get(token) ?? []) scores[language] += weight;
    if (token.length < 2 || token.endsWith("'") || token.startsWith("'")) continue;
    for (const { feature, weights } of featureWeight.values()) {
      if (!hasFeature(token, feature)) continue;
      for (const [language, weight] of weights) scores[language] += weight;
    }
  }
  return scores;
}

const undetermined = (wordCount: number, best?: DetectableLanguage, runnerUp?: DetectableLanguage): LanguageGuess =>
  ({ language: 'und', confidence: 0, words: wordCount, best, runnerUp });

/** Identifies the language of `text`; undetermined below `minimumWords` words or when no language fits. */
export function detectLanguage(text: string, options: DetectOptions = {}): LanguageGuess {
  const tokens = tokenize(text);
  const wordCount = countWords(tokens);
  const scores = languageScores(tokens);
  // Languages with many short function words (English, German) gather more evidence per word; dividing by the
  // typical density puts every language on the scale of words explained, so a half-and-half text stays uncertain.
  const explained = (language: DetectableLanguage) => scores[language] / density[language];
  const ranking = [...detectableLanguages].sort((a, b) => explained(b) - explained(a));
  const top = explained(ranking[0]!);
  if (wordCount < (options.minWords ?? minimumWords)) return undetermined(wordCount, top > 0 ? ranking[0] : undefined, ranking[1]);
  // Text in a language outside the set (Dutch, Swedish) explains well under half its words; refuse rather than
  // pick the least bad fit. Running text in a known language explains about all of them.
  if (top < wordCount * 0.5) return undetermined(wordCount, ranking[0], ranking[1]);
  const total = detectableLanguages.reduce((sum, language) => sum + Math.exp(sharpness * (explained(language) - top)), 0);
  const confidence = Math.round((1 / total) * 1000) / 1000;
  return { language: ranking[0]!, confidence, words: wordCount, best: ranking[0]!, runnerUp: ranking[1]! };
}

const related: ReadonlyArray<readonly [DetectableLanguage, DetectableLanguage]> = [
  ['ca', 'es'], ['ca', 'oc'], ['es', 'oc'], ['es', 'pt'], ['es', 'it'], ['pt', 'it'], ['fr', 'oc'], ['ca', 'it'],
];

/** Pairs that share much vocabulary, where a detection should be double-checked before it is acted on. */
export function closelyRelated(a: string, b: string): boolean {
  return related.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function isDetectable(language: string): language is DetectableLanguage {
  return (detectableLanguages as readonly string[]).includes(language);
}
