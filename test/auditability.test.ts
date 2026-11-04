import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notAuditableReason } from '../src/analyze/auditability.ts';
import { response } from './support/facts.ts';

test('recognizes firewall challenges and bot walls', () => {
  assert.equal(notAuditableReason(response('https://example.com/', { status: 403, headers: { 'cf-mitigated': 'challenge' } }), undefined), 'challenge-challenge');
  const challenge = '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>';
  assert.equal(notAuditableReason(response('https://example.com/', { status: 503, body: challenge }), challenge), 'challenge-page');
  assert.equal(notAuditableReason(response('https://example.com/', { status: 401 }), ''), 'authentication-required');
});

test('treats ordinary pages and ordinary errors as auditable', () => {
  assert.equal(notAuditableReason(response('https://example.com/', { status: 200, body: '<title>Just a moment of calm</title>' }), undefined), undefined);
  assert.equal(notAuditableReason(response('https://example.com/missing', { status: 404 }), '<title>Not found</title>'), undefined);
  assert.equal(notAuditableReason(response('https://example.com/busy', { status: 503 }), '<title>Maintenance</title>'), undefined);
});
