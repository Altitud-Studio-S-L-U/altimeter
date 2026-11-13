import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalList, domainForms, namesDomain, onSite, parseUrl, urlKey, urlsInText, withoutUrls } from '../src/probe/urls.ts';

describe('URLs read from engine output', () => {
  test('come from Markdown links and bare URLs, without the punctuation around them', () => {
    const text = [
      'See [Altitud](https://altitudstudio.ad/serveis/) and https://example.com/a.',
      'Also (https://example.org/b) and **https://example.net/c**, then <https://example.edu/d>.',
      'Wikipedia: https://en.wikipedia.org/wiki/Andorra_(disambiguation).',
      '[A](https://a.example/x)[B](https://b.example)',
    ].join('\n');
    assert.deepEqual(urlsInText(text), [
      'https://altitudstudio.ad/serveis/', 'https://example.com/a', 'https://example.org/b', 'https://example.net/c', 'https://example.edu/d',
      'https://en.wikipedia.org/wiki/Andorra_(disambiguation)', 'https://a.example/x', 'https://b.example/',
    ]);
  });

  test('lose tracking parameters and fragments, and the same page counts once', () => {
    assert.deepEqual(urlsInText('https://example.com/p?utm_source=chatgpt.com#top https://www.example.com/p/ https://example.com/p?id=2&utm_medium=x&gclid=1'), [
      'https://example.com/p', 'https://example.com/p?id=2',
    ]);
  });

  test('are refused with another scheme, credentials, a bare host, an IPv6 literal or more than 2,048 characters', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/', 'https://user:password@example.com/', 'https://localhost/', 'http://[::1]/', `https://example.com/${'a'.repeat(2100)}`]) {
      assert.equal(parseUrl(bad), undefined, bad);
    }
    assert.deepEqual(urlsInText('javascript:alert(1) https://user:password@example.com/ ftp://example.com/ file:///etc/passwd'), []);
    assert.equal(parseUrl('https://127.0.0.1:8080/x')?.href, 'https://127.0.0.1:8080/x');
  });

  test('are read after control, bidirectional and zero-width characters are removed, with hosts in punycode', () => {
    const hidden = `https://exa${String.fromCodePoint(0x200b)}mple.com/${String.fromCodePoint(0x202e)}path${String.fromCodePoint(0x1b)}[31m`;
    assert.deepEqual(urlsInText(hidden), ['https://example.com/path']);
    assert.deepEqual(urlsInText(`https://ex${String.fromCodePoint(0xe4)}mple.com/`), ['https://xn--exmple-cua.com/']);
  });

  test('stop at 50 per text', () => {
    const many = Array.from({ length: 80 }, (_, index) => `https://site${index}.example/`).join(' ');
    assert.equal(urlsInText(many).length, 50);
    assert.equal(canonicalList(['https://a.example/', ' https://a.example ', 'not a url', 'https://b.example/x#y']).length, 2);
  });

  test('compare by host without www, either scheme, no trailing slash and a stable query order', () => {
    assert.equal(urlKey('http://www.example.com/a/'), urlKey('https://example.com/a'));
    assert.equal(urlKey('https://example.com/?b=2&a=1&utm_source=x'), urlKey('https://example.com/?a=1&b=2'));
    assert.notEqual(urlKey('https://example.com/a'), urlKey('https://example.com/b'));
    assert.notEqual(urlKey('https://example.com:8443/a'), urlKey('https://example.com/a'));
  });

  test('belong to the site when they share its registrable domain, so look-alikes do not', () => {
    assert.equal(onSite('https://blog.example.com/x', 'example.com'), true);
    assert.equal(onSite('https://example.com.evil.example/', 'example.com'), false);
    assert.equal(onSite('https://notexample.com/', 'example.com'), false);
    assert.equal(onSite('https://shop.example.co.uk/', 'example.co.uk'), true);
    assert.equal(onSite('javascript:alert(1)', 'example.com'), false);
  });

  test('are removed from text, so a name inside an address is not read as a mention', () => {
    assert.equal(withoutUrls('Visit https://altitudstudio.ad/ today').replace(/\s+/gu, ' '), 'Visit today');
  });
});

describe('naming the domain', () => {
  test('is a match on whole names, in ASCII and in Unicode, whatever the case', () => {
    const forms = domainForms({ host: 'art.com', domain: 'art.com' });
    assert.equal(namesDomain('reviews of art.com', forms), true);
    assert.equal(namesDomain('www.art.com prices', forms), true);
    assert.equal(namesDomain('ART.COM', forms), true);
    assert.equal(namesDomain('smart.com deals', forms), false);
    assert.equal(namesDomain('art prints', forms), false);
    const idn = domainForms({ host: 'xn--espaa-rta.es', domain: 'xn--espaa-rta.es' });
    assert.equal(namesDomain(`hoteles en espa${String.fromCodePoint(0xf1)}a.es`, idn), true);
    assert.equal(namesDomain('hoteles en xn--espaa-rta.es', idn), true);
  });
});
