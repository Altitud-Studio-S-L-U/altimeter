import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import { isAllowed, parseRobots } from '../src/fetch/robots.ts';
import { format, templateProblems } from '../src/i18n/format.ts';
import { baseUrl, parseHtml } from '../src/parse/html.ts';
import { cleanText, escapeHtml, jsonForScript, markdownText, untrustedBlock } from '../src/report/sanitize.ts';
import { normalizeUrl } from '../src/rules/crawl/shared.ts';

// Property tests: each runs on generated inputs, any text a site, a robots.txt or an edited report.json could carry.
const text = fc.string({ unit: 'binary', maxLength: 400 });
const webUrl = fc.webUrl({ withQueryParameters: true, withFragments: true }).filter(url => URL.canParse(url));
const params = fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(text, fc.double({ noNaN: true })), { maxKeys: 4 });

/** C0 and C1 controls other than tab and line feed, and format or default-ignorable characters. */
function unsafe(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0)!;
    return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) || /\p{Cf}|\p{Default_Ignorable_Code_Point}/u.test(character);
  });
}

const lineSeparators = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

describe('message templates', () => {
  test('format and check any text without throwing', () => {
    fc.assert(fc.property(text, params, fc.constantFrom('en' as const, 'es' as const, 'ca' as const), (template, values, language) => {
      assert.equal(typeof format(template, values, language), 'string');
      assert.ok(Array.isArray(templateProblems(template, language)));
    }));
  });

  test('leave text without an opening brace as it is', () => {
    fc.assert(fc.property(text.filter(value => !value.includes('{')), params, (template, values) => format(template, values) === template));
  });
});

describe('document base URL', () => {
  test('is always an http or https URL, whatever the base element says', () => {
    fc.assert(fc.property(webUrl, text, (page, href) => {
      const html = `<!doctype html><html><head><base href="${href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></head><body></body></html>`;
      assert.match(new URL(baseUrl(parseHtml(html), page)).protocol, /^https?:$/u);
    }));
  });
});

describe('URL normalization', () => {
  test('is idempotent and drops the fragment', () => {
    fc.assert(fc.property(webUrl, url => {
      const once = normalizeUrl(url)!;
      assert.equal(normalizeUrl(once), once);
      assert.equal(new URL(once).hash, '');
    }));
  });
});

describe('robots.txt', () => {
  test('parses any bytes and answers for any path', () => {
    fc.assert(fc.property(fc.oneof(text, fc.uint8Array({ maxLength: 400 })), text, (input, path) => {
      const decision = isAllowed(parseRobots(input), ['googlebot'], `/${path}`);
      assert.equal(typeof decision.allowed, 'boolean');
    }));
  });

  test('disallows every path but /robots.txt under Disallow: /, and allows every path under an empty Disallow', () => {
    const closed = parseRobots('User-agent: *\nDisallow: /\n');
    const open = parseRobots('User-agent: *\nDisallow:\n');
    fc.assert(fc.property(text, path => {
      const target = `/${path}`;
      assert.equal(isAllowed(open, ['googlebot'], target).allowed, true);
      if (target !== '/robots.txt') assert.equal(isAllowed(closed, ['googlebot'], target).allowed, false);
    }));
  });

  test('lets the longer of two matching rules decide', () => {
    const segment = fc.stringMatching(/^[a-z0-9]{1,8}$/u);
    fc.assert(fc.property(segment, segment, segment, (folder, page, rest) => {
      const file = parseRobots(`User-agent: *\nDisallow: /${folder}/\nAllow: /${folder}/${page}\n`);
      assert.equal(isAllowed(file, ['googlebot'], `/${folder}/${page}${rest}`).allowed, true);
      if (!rest.startsWith(page)) assert.equal(isAllowed(file, ['googlebot'], `/${folder}/${rest}`).allowed, false);
    }));
  });
});

describe('untrusted text', () => {
  test('cleaned text keeps no control, format or invisible characters', () => {
    fc.assert(fc.property(text, value => !unsafe(cleanText(value, 100_000))));
  });

  test('HTML escaping leaves no character that could open markup or an attribute', () => {
    fc.assert(fc.property(text, value => !/[<>"']/u.test(escapeHtml(value))));
  });

  test('Markdown text is one line with no raw angle bracket and no unescaped backtick', () => {
    fc.assert(fc.property(text, value => {
      const line = markdownText(value, 100_000);
      return !line.includes('\n') && !/[<>]/u.test(line) && !/(?<!\\)`/u.test(line);
    }));
  });

  test('an untrusted block cannot be closed from inside', () => {
    fc.assert(fc.property(text, value => {
      const lines = untrustedBlock(value, 100_000).split('\n');
      const fence = lines[0]!.replace(/untrusted$/u, '');
      return lines.at(-1) === fence && !lines.slice(1, -1).join('\n').includes(fence);
    }));
  });

  test('JSON for a script element round-trips and cannot close the element', () => {
    fc.assert(fc.property(fc.jsonValue(), value => {
      const json = jsonForScript(value);
      assert.ok(!/[<>&]/u.test(json) && !lineSeparators.some(separator => json.includes(separator)));
      assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(value)));
    }));
  });
});
