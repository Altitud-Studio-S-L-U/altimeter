/**
 * Code lists for hreflang and lang values, and the grammar Google documents for hreflang:
 * an ISO 639-1 language, an optional ISO 15924 script and an optional ISO 3166-1 alpha-2 region, or x-default.
 */

const set = (codes: string) => new Set(codes.split(/\s+/u).filter(Boolean));

/** ISO 639-1 two-letter language codes in current use. */
export const iso639_1 = set(`
  aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es
  et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj
  kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv
  ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti
  tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`);

/** Two-letter codes withdrawn from ISO 639-1, with their replacement. */
export const withdrawn639: Readonly<Record<string, string>> = { iw: 'he', in: 'id', ji: 'yi', jw: 'jv', mo: 'ro', sh: 'sr, hr or bs' };

/** Officially assigned ISO 3166-1 alpha-2 country codes. */
export const iso3166 = set(`
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD
  CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF
  GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN
  KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA
  NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI
  SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI
  VN VU WF WS YE YT ZA ZM ZW`);

/** ISO 15924 script codes, title case. Qaaa-Qabx (private use) are accepted by pattern. */
export const iso15924 = set(`
  Adlm Afak Aghb Ahom Arab Aran Armi Armn Avst Bali Bamu Bass Batk Beng Bhks Blis Bopo Brah Brai Bugi Buhd Cakm Cans Cari
  Cham Cher Chis Chrs Cirt Copt Cpmn Cprt Cyrl Cyrs Deva Diak Dogr Dsrt Dupl Egyd Egyh Egyp Elba Elym Ethi Gara Geok Geor
  Glag Gong Gonm Goth Gran Grek Gujr Gukh Guru Hanb Hang Hani Hano Hans Hant Hatr Hebr Hira Hluw Hmng Hmnp Hrkt Hung Inds
  Ital Jamo Java Jpan Jurc Kali Kana Kawi Khar Khmr Khoj Kitl Kits Knda Kore Kpel Krai Kthi Lana Laoo Latf Latg Latn Leke
  Lepc Limb Lina Linb Lisu Loma Lyci Lydi Mahj Maka Mand Mani Marc Maya Medf Mend Merc Mero Mlym Modi Mong Moon Mroo Mtei
  Mult Mymr Nagm Nand Narb Nbat Newa Nkdb Nkgb Nkoo Nshu Ogam Olck Onao Orkh Orya Osge Osma Ougr Palm Pauc Pcun Pelm Perm
  Phag Phli Phlp Phlv Phnx Piqd Plrd Prti Psin Ranj Rjng Rohg Roro Runr Samr Sara Sarb Saur Sgnw Shaw Shrd Shui Sidd Sidt
  Sind Sinh Sogd Sogo Sora Soyo Sund Sunu Sylo Syrc Syre Syrj Syrn Tagb Takr Tale Talu Taml Tang Tavt Tayo Telu Teng Tfng
  Tglg Thaa Thai Tibt Tirh Tnsa Todr Tols Toto Tutg Ugar Vaii Visp Vith Wara Wcho Wole Xpeo Xsux Yezi Yiii Zanb Zinh Zmth
  Zsye Zsym Zxxx Zyyy Zzzz`);

export function isScript(code: string): boolean {
  const title = `${code[0]!.toUpperCase()}${code.slice(1).toLowerCase()}`;
  return iso15924.has(title) || /^Qa(?:a[a-z]|b[a-x])$/u.test(title);
}

/** Region codes that are reserved, not assigned: Google ignores them as regions. */
export const reservedRegions: Readonly<Record<string, string>> = {
  UK: 'GB', EU: 'no single country', UN: 'no single country', EZ: 'no single country', FX: 'FR', SU: 'no single country',
  YU: 'no single country', TP: 'TL', ZR: 'CD', AN: 'no single country', CS: 'no single country',
};

/** Language codes that are also country codes, with the language most spoken in that country, when it differs. */
export const countryLanguage: Readonly<Record<string, readonly string[]>> = {
  ca: ['en', 'fr'], be: ['nl', 'fr', 'de'], se: ['sv'], uk: ['en'], by: ['be', 'ru'], no: ['no', 'nb', 'nn'],
};

export type HreflangProblem =
  | 'empty'
  | 'whitespace'
  | 'underscore'
  | 'empty-subtag'
  | 'language-not-two-letters'
  | 'unknown-language'
  | 'withdrawn-language'
  | 'private-use'
  | 'country-as-language'
  | 'unknown-script'
  | 'script-after-region'
  | 'unassigned-region'
  | 'reserved-region'
  | 'numeric-region'
  | 'three-letter-region'
  | 'variant'
  | 'extension'
  | 'too-many-subtags'
  | 'malformed';

export interface ParsedHreflang {
  readonly value: string;
  readonly xDefault: boolean;
  /** Lowercase language subtag as written, when the value has one. */
  readonly language: string | undefined;
  readonly script: string | undefined;
  /** Uppercase region subtag, when the value has one. */
  readonly region: string | undefined;
  readonly problems: readonly HreflangProblem[];
}

/** Which rule reports each problem, so a value is never counted twice. */
export const problemOwner: Readonly<Record<HreflangProblem, 'language' | 'region-only' | 'region' | 'syntax'>> = {
  empty: 'language',
  'language-not-two-letters': 'language',
  'unknown-language': 'language',
  'withdrawn-language': 'language',
  'private-use': 'language',
  'country-as-language': 'region-only',
  'unassigned-region': 'region',
  'reserved-region': 'region',
  'numeric-region': 'region',
  'three-letter-region': 'region',
  whitespace: 'syntax',
  underscore: 'syntax',
  'empty-subtag': 'syntax',
  'unknown-script': 'syntax',
  'script-after-region': 'syntax',
  variant: 'syntax',
  extension: 'syntax',
  'too-many-subtags': 'syntax',
  malformed: 'syntax',
};

/** Parses a hreflang value against Google's documented format. Matching is case-insensitive. */
export function parseHreflang(input: string): ParsedHreflang {
  const value = input.trim();
  const problems: HreflangProblem[] = [];
  if (value.toLowerCase() === 'x-default') return { value, xDefault: true, language: undefined, script: undefined, region: undefined, problems };
  if (value === '') return { value, xDefault: false, language: undefined, script: undefined, region: undefined, problems: ['empty'] };
  if (/\s/u.test(value)) problems.push('whitespace');
  if (value.includes('_')) problems.push('underscore');
  const subtags = value.split(/[-_\s]+/u);
  if (/[-_]$|^[-_]|[-_]{2}/u.test(value)) problems.push('empty-subtag');
  const parts = subtags.filter(Boolean);
  if (parts.some(part => !/^[a-z0-9]+$/iu.test(part))) problems.push('malformed');
  const first = (parts[0] ?? '').toLowerCase();
  const language: string | undefined = first || undefined;
  // Subtags after a private-use or grandfathered prefix have no grammar to check.
  if (first === 'x' || first === 'i') return { value, xDefault: false, language: undefined, script: undefined, region: undefined, problems: [...problems, 'private-use'] };
  if (/^[a-z]{2}$/u.test(first)) {
    if (withdrawn639[first]) problems.push('withdrawn-language');
    else if (!iso639_1.has(first)) problems.push(parts.length === 1 && iso3166.has(first.toUpperCase()) ? 'country-as-language' : 'unknown-language');
  } else if (first !== '') problems.push('language-not-two-letters');

  let script: string | undefined;
  let region: string | undefined;
  const rest = parts.slice(1);
  for (const [index, part] of rest.entries()) {
    if (/^[a-z]{4}$/iu.test(part)) {
      if (region !== undefined) problems.push('script-after-region');
      else if (script !== undefined) problems.push('malformed');
      else {
        script = part;
        if (!isScript(part)) problems.push('unknown-script');
      }
    } else if (/^[a-z]{2}$/iu.test(part) && region === undefined) {
      region = part.toUpperCase();
      if (reservedRegions[region]) problems.push('reserved-region');
      else if (!iso3166.has(region)) problems.push('unassigned-region');
    } else if (/^\d{3}$/u.test(part) && region === undefined) {
      region = part;
      problems.push('numeric-region');
    } else if (/^[a-z]{3}$/iu.test(part) && region === undefined && index === rest.length - 1) {
      region = part.toUpperCase();
      problems.push('three-letter-region');
    } else if (/^[a-z0-9]$/iu.test(part)) {
      problems.push('extension');
      break;
    } else if (/^(?:[a-z0-9]{5,8}|\d[a-z0-9]{3})$/iu.test(part)) problems.push('variant');
    else problems.push('malformed');
  }
  if (parts.length > 3 && !problems.includes('variant') && !problems.includes('extension')) problems.push('too-many-subtags');
  return { value, xDefault: false, language, script, region, problems: [...new Set(problems)] };
}

/** Primary language subtag of any language tag, lowercased; `undefined` for x-default or an empty value. */
export function primaryLanguage(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const first = tag.trim().split(/[-_]/u)[0]!.toLowerCase();
  if (first === '' || first === 'x' || first === 'i' || tag.trim().toLowerCase() === 'x-default') return undefined;
  return first;
}

/** Norwegian is written under three subtags that name one language for this purpose. */
export function sameLanguage(a: string, b: string): boolean {
  const norm = (code: string) => (code === 'nb' || code === 'nn' || code === 'no' ? 'no' : code);
  return norm(a) === norm(b);
}

/**
 * Well-formedness of a BCP 47 tag (RFC 5646 section 2.1) for the lang attribute, which, unlike hreflang, allows
 * three-letter languages, numeric regions and variants. Two-letter languages are checked against ISO 639-1,
 * including withdrawn codes that the IANA registry still lists as deprecated.
 */
export function bcp47Problem(input: string): 'empty' | 'malformed' | 'unknown-language' | undefined {
  const value = input.trim();
  if (value === '') return 'empty';
  if (/^(?:x|i)-[a-z0-9-]+$/iu.test(value)) return undefined;
  const grammar = /^([a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$/iu;
  const match = grammar.exec(value);
  if (!match) return 'malformed';
  const language = match[1]!.split('-')[0]!.toLowerCase();
  if (language.length === 2 && !iso639_1.has(language) && !withdrawn639[language]) return 'unknown-language';
  return undefined;
}
