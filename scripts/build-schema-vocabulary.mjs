#!/usr/bin/env node
/**
 * Builds src/data/schema-org-vocabulary.json, the compact schema.org snapshot the schema rules validate against.
 * Run with `node scripts/build-schema-vocabulary.mjs`; it downloads the current release and the attic file, and
 * refuses releases older than the one the rules were written for.
 *
 * schema.org vocabulary data is licensed under CC BY-SA 3.0 (https://schema.org/docs/terms.html); see NOTICE.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = 'https://schema.org/version/latest/';
const minimumRelease = [30, 1];
const output = fileURLToPath(new URL('../src/data/schema-org-vocabulary.json', import.meta.url));

async function download(url, as) {
  const response = await fetch(url, { headers: { accept: as === 'json' ? 'application/ld+json, application/json' : 'text/html' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return as === 'json' ? response.json() : response.text();
}

const bare = id => String(id).replace(/^schema:/u, '').replace(/^https?:\/\/schema\.org\//u, '');
const ids = value => (value === undefined ? [] : [value].flat().map(entry => bare(entry['@id'] ?? entry)));
const sorted = values => [...new Set(values)].sort();
const isSchemaTerm = node => typeof node['@id'] === 'string' && node['@id'].startsWith('schema:');

function releaseOf(html) {
  const match = /Version\s+(\d+)\.(\d+)/u.exec(html);
  if (!match) throw new Error('The release summary page does not state a version');
  const release = [Number(match[1]), Number(match[2])];
  const tooOld = release[0] < minimumRelease[0] || (release[0] === minimumRelease[0] && release[1] < minimumRelease[1]);
  if (tooOld) throw new Error(`schema.org ${release.join('.')} is older than ${minimumRelease.join('.')}`);
  return release.join('.');
}

function build(current, all, release) {
  const graph = current['@graph'].filter(isSchemaTerm);
  const classes = new Map();
  const properties = new Map();
  const dataTypes = new Set();
  const typed = [];
  const superseded = {};
  const pending = [];
  for (const node of graph) {
    const name = bare(node['@id']);
    const kinds = [node['@type']].flat().map(String);
    if (kinds.includes('rdfs:Class')) {
      classes.set(name, ids(node['rdfs:subClassOf']).filter(parent => !parent.includes(':')));
      if (kinds.includes('schema:DataType')) dataTypes.add(name);
    } else if (kinds.includes('rdf:Property')) {
      properties.set(name, [sorted(ids(node['schema:domainIncludes'])), sorted(ids(node['schema:rangeIncludes']))]);
    } else {
      typed.push({ name, kinds: kinds.filter(kind => kind.startsWith('schema:')).map(bare) });
    }
    const replacement = ids(node['schema:supersededBy'])[0];
    if (replacement) superseded[name] = replacement;
    if (ids(node['schema:isPartOf']).some(part => /pending\.schema\.org/u.test(part))) pending.push(name);
  }
  // Data types such as Number and URL inherit from DataType or Text without being marked themselves.
  for (let size = -1; size !== dataTypes.size;) {
    size = dataTypes.size;
    for (const [name, parents] of classes) if (parents.some(parent => dataTypes.has(parent))) dataTypes.add(name);
  }
  const ancestors = name => {
    const seen = new Set();
    const queue = [name];
    while (queue.length > 0) {
      const next = queue.shift();
      for (const parent of classes.get(next) ?? []) if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
    return seen;
  };
  const enumerations = {};
  for (const { name, kinds } of typed) {
    for (const kind of kinds) {
      if (!ancestors(kind).has('Enumeration')) continue;
      (enumerations[kind] ??= []).push(name);
    }
  }
  const values = sorted(typed.filter(entry => entry.kinds.some(kind => !ancestors(kind).has('Enumeration'))).map(entry => entry.name));
  const known = new Set(current['@graph'].map(node => node['@id']));
  const attic = sorted(all['@graph'].filter(node => isSchemaTerm(node) && !known.has(node['@id'])).map(node => bare(node['@id'])));
  const byName = map => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    release,
    source: `https://schema.org/version/${release}/schemaorg-current-https.jsonld`,
    license: 'CC BY-SA 3.0, https://schema.org/docs/terms.html',
    types: byName([...classes].map(([name, parents]) => [name, sorted(parents)])),
    dataTypes: sorted(dataTypes),
    properties: byName(properties),
    enumerations: byName(Object.entries(enumerations).map(([name, members]) => [name, sorted(members)])),
    values,
    superseded: byName(Object.entries(superseded)),
    pending: sorted(pending),
    attic,
  };
}

const release = releaseOf(await download(base, 'text'));
const [current, all] = await Promise.all([
  download(`${base}schemaorg-current-https.jsonld`, 'json'),
  download(`${base}schemaorg-all-https.jsonld`, 'json'),
]);
const vocabulary = build(current, all, release);
await writeFile(output, `${JSON.stringify(vocabulary)}\n`);
console.log(`schema.org ${release}: ${Object.keys(vocabulary.types).length} types, ${Object.keys(vocabulary.properties).length} properties, `
  + `${Object.keys(vocabulary.enumerations).length} enumerations, ${vocabulary.attic.length} attic terms`);
