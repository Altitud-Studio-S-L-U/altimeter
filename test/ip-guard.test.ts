import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressAllowed, classifyAddress, publicOnly } from '../src/fetch/ip-guard.ts';

test('classifies IPv4 special-purpose ranges', () => {
  const cases: Array<[string, string]> = [
    ['8.8.8.8', 'public'],
    ['93.184.216.34', 'public'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-nat'],
    ['0.0.0.0', 'unspecified'],
    ['192.0.2.10', 'documentation'],
    ['198.18.0.1', 'reserved'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
  ];
  for (const [address, expected] of cases) assert.equal(classifyAddress(address), expected, address);
});

test('classifies IPv6 ranges and embedded IPv4 addresses', () => {
  const cases: Array<[string, string]> = [
    ['2606:4700::6810:84e5', 'public'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::', 'unspecified'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['64:ff9b::8.8.8.8', 'public'],
    ['2002:c0a8:0101::1', 'private'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378::1', 'reserved'],
    ['::127.0.0.1', 'reserved'],
  ];
  for (const [address, expected] of cases) assert.equal(classifyAddress(address), expected, address);
});

test('rejects text that is not an IP literal', () => {
  assert.throws(() => classifyAddress('example.com'), /Not an IP address/u);
});

test('allows private addresses only by explicit policy', () => {
  assert.equal(addressAllowed(publicOnly, 'example.com', '8.8.8.8'), true);
  assert.equal(addressAllowed(publicOnly, 'example.com', '127.0.0.1'), false);
  assert.equal(addressAllowed({ allowPrivate: true }, 'example.com', '10.0.0.1'), true);
  const local = { allowPrivate: false, privateHosts: new Set(['127.0.0.1', 'localhost']) };
  assert.equal(addressAllowed(local, 'localhost', '127.0.0.1'), true);
  assert.equal(addressAllowed(local, 'LOCALHOST', '::1'), true);
  assert.equal(addressAllowed(local, 'attacker.example', '127.0.0.1'), false);
});
