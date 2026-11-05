/**
 * Approximate rendered width of text in Arial, from the font's advance widths in units of 1/1000 em.
 * Search result pages use Arial-like sans-serif fonts; the estimate is informational and never a pass/fail limit.
 */
const ascii = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const asciiWidths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];
const table = new Map<string, number>([...ascii].map((char, index) => [char, asciiWidths[index]!]));
for (const [char, width] of [['–', 556], ['—', 1000], ['·', 278], ['•', 350], ['…', 1000], ['’', 222], ['‘', 222], ['“', 333], ['”', 333],
  ['«', 556], ['»', 556], ['¡', 333], ['¿', 611], ['ß', 611], ['æ', 889], ['Æ', 1000], ['ø', 611], ['Ø', 778], ['€', 556], ['©', 737], ['®', 737], ['™', 1000]] as const) {
  table.set(char, width);
}

function charWidth(char: string): number {
  const known = table.get(char);
  if (known !== undefined) return known;
  const base = char.normalize('NFD')[0];
  const fromBase = base === undefined ? undefined : table.get(base);
  if (fromBase !== undefined) return fromBase;
  // Wide scripts (CJK, kana, Hangul) and emoji take a full em; other letters are close to the average lowercase width.
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠\u{1f300}-\u{1faff}]/u.test(char) ? 1000 : 556;
}

/** Width in CSS pixels of `text` set in Arial at `fontSize` pixels. */
export function arialWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) units += charWidth(char);
  return Math.round((units * fontSize) / 1000);
}

/** Desktop title links are set at about 20px; tools commonly assume roughly 600px before truncation. */
export const desktopTitleFontSize = 20;
export const desktopTitleWidth = 600;
