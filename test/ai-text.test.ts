import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkQuote, factIndex, fold, normalizeText, quoteSegments, unsupportedFacts } from '../src/ai/text.ts';

const cp = (...points: number[]) => String.fromCodePoint(...points);
const rightQuote = cp(0x2019);
const leftDouble = cp(0x201c);
const rightDouble = cp(0x201d);
const emDash = cp(0x2014);
const enDash = cp(0x2013);
const nbsp = cp(0x00a0);
const narrowNbsp = cp(0x202f);
const ellipsis = cp(0x2026);
const middleDot = cp(0x00b7);
const hyphenationPoint = cp(0x2027);
const zeroWidth = cp(0x200b);
const rightToLeftOverride = cp(0x202e);
const eAcute = cp(0x00e9);
const oAcute = cp(0x00f3);

describe('quote normalisation', () => {
  test('maps curly quotes, dashes, special spaces and the ellipsis character', () => {
    assert.equal(normalizeText(`It${rightQuote}s ${leftDouble}great${rightDouble} ${emDash} really${nbsp}so${narrowNbsp}good${ellipsis}`), `It's "great" - really so good...`);
    assert.equal(normalizeText(`2019${enDash}2026`), '2019-2026');
  });

  test('removes zero-width and bidirectional characters and applies NFC', () => {
    assert.equal(normalizeText(`sa${zeroWidth}fe${rightToLeftOverride}text`), 'safetext');
    assert.equal(normalizeText(`caf${'e'}${cp(0x0301)}`), `caf${eAcute}`);
  });

  test('treats the three ways of writing the Catalan l.l geminate as one', () => {
    const words = [`col${middleDot}lecci${oAcute}`, `col${hyphenationPoint}lecci${oAcute}`, `col.lecci${oAcute}`].map(normalizeText);
    assert.equal(new Set(words).size, 1);
    assert.equal(words[0], `col${middleDot}lecci${oAcute}`);
    assert.equal(normalizeText(`Il${middleDot}lustre`), normalizeText('Il.lustre'));
    assert.equal(checkQuote(`la col.lecci${oAcute} permanent del museu`, `Visiteu la col${middleDot}lecci${oAcute} permanent del museu cada dia.`), 'ok');
  });

  test('keeps case, because a claim can be about capitalisation', () => {
    assert.equal(checkQuote('BEST HOTEL IN TOWN', 'Best hotel in town'), 'quote-not-found');
  });
});

describe('checkQuote', () => {
  const source = `We don${rightQuote}t rent rooms by the hour. Our 45 rooms look over the valley of Andorra la Vella, and breakfast is served until 11:00.`;

  test('accepts apostrophe and quote variants on either side', () => {
    assert.equal(checkQuote("We don't rent rooms by the hour", source), 'ok');
    assert.equal(checkQuote(`We don${cp(0x02bc)}t rent rooms`, source), 'ok');
    assert.equal(checkQuote(`We don${cp(0x2018)}t rent rooms`, "We don't rent rooms anymore"), 'ok');
  });

  test('splits at ellipses into passages that must appear in order', () => {
    assert.equal(checkQuote(`Our 45 rooms ${ellipsis} Andorra la Vella`, source), 'ok');
    assert.equal(checkQuote('Our 45 rooms ... breakfast is served', source), 'ok');
    assert.equal(checkQuote('breakfast is served ... Our 45 rooms', source), 'quote-not-found');
    assert.deepEqual(quoteSegments(`one two [...] three four ${ellipsis} five six`), ['one two', 'three four', 'five six']);
  });

  test('needs at least three words or fifteen characters, and real passages between ellipses', () => {
    assert.equal(checkQuote('the valley', source), 'quote-too-short');
    assert.equal(checkQuote('Andorra', source), 'quote-too-short');
    assert.equal(checkQuote('valley of Andorra', source), 'ok');
    assert.equal(checkQuote('The ... is', 'The cat is here'), 'quote-too-short');
    assert.equal(checkQuote('...', source), 'quote-too-short');
  });

  test('does not match text that is not there', () => {
    assert.equal(checkQuote('Our 46 rooms look over', source), 'quote-not-found');
  });
});

describe('unsupportedFacts', () => {
  const index = factIndex(`Call +376 800 800 or write to info@hotel.ad. Since 1998, 45 rooms rated 4,8/5, the best views. Open 09:00${enDash}18:00.`);

  test('accepts numbers, years, ratings, phones and emails the page shows, in other formats', () => {
    assert.deepEqual(unsupportedFacts('Since 1998: 45 rooms rated 4.8, the best views, call 00376 800800 or info@hotel.ad', index), []);
    assert.deepEqual(unsupportedFacts('Open 9:00-18:00, built 1998-05-01', index), []);
  });

  test('reports numbers, superlatives, phones and emails the page does not show', () => {
    assert.deepEqual(unsupportedFacts('46 rooms, the top hotel', index), ['46', 'top']);
    assert.deepEqual(unsupportedFacts('Call +376 900 900', index), ['+376 900 900']);
    assert.deepEqual(unsupportedFacts('Write to bookings@hotel.ad', index), ['bookings@hotel.ad']);
    assert.deepEqual(unsupportedFacts(`El millor hotel d${rightQuote}Andorra`, index), ['millor']);
  });

  test('folds case and accents for facts', () => {
    assert.equal(fold(`L${middleDot}EXCEL${middleDot}L${eAcute}NCIA`), `l${middleDot}excel${middleDot}lencia`);
  });
});
