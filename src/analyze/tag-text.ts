/**
 * Unicode tag characters (U+E0000 to U+E007F) display as nothing, but each one stands for an ASCII character that
 * models read, so a page can write words in them that no reader sees. Their only use in text is the tag sequence
 * that turns the black flag emoji into the flag of a region, such as Scotland's.
 */

const tagRun = /(\u{1F3F4})?([\u{E0000}-\u{E007F}]+)/gu;
const flagSequence = /^[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,7}\u{E007F}$/u;

/** The ASCII each run of tag characters in `value` stands for, leaving out the tag sequences of emoji flags. */
export function tagText(value: string): string[] {
  const runs: string[] = [];
  for (const [, flag, tags] of value.matchAll(tagRun)) {
    if (flag !== undefined && flagSequence.test(tags!)) continue;
    let text = '';
    for (const character of tags!) {
      const point = character.codePointAt(0)! - 0xe0000;
      if (point >= 0x20 && point <= 0x7e) text += String.fromCharCode(point);
    }
    if (/[A-Za-z0-9]/u.test(text)) runs.push(text.replace(/\s+/gu, ' ').trim());
  }
  return runs;
}
