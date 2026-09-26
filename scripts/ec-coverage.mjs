#!/usr/bin/env node
// Parses docs/EDGE_CASES.md for every row's (ID, priority), then checks that every P0 id has:
//   (a) a `[EC:<id>]` section header in at least one packages/**/spec/*.pseudo.md
//   (b) an `EC:<id>` mention in at least one packages/**/ts/src/** file
//   (c) an `EC:<id>` mention in at least one packages/**/py/src/** file
//
// Section F (docs/EDGE_CASES.md "F. Provider 별 특이점") has no ID column — the whole section
// is treated as a single pseudo-id "F" (matches `[EC:F]` usage across the codebase).
//
// No dependencies. Node >=20.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DOC_PATH = join(ROOT, 'docs/EDGE_CASES.md');

// ---------------------------------------------------------------------------
// 1. Parse docs/EDGE_CASES.md tables.
// ---------------------------------------------------------------------------

function parseEdgeCases(text) {
  const lines = text.split('\n');
  /** @type {Map<string, string>} id -> priority (P0/P1/P2) */
  const ids = new Map();
  let sectionLetter = null;
  let header = null; // array of column names for current table
  let idColIdx = -1;
  let pColIdx = -1;
  let sectionHasP0 = false; // for section F only

  const flushSection = () => {
    if (sectionLetter === 'F' && sectionHasP0) {
      ids.set('F', 'P0');
    }
    sectionHasP0 = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    const headingMatch = line.match(/^##\s+([A-Z])\./);
    if (headingMatch) {
      flushSection();
      sectionLetter = headingMatch[1];
      header = null;
      idColIdx = -1;
      pColIdx = -1;
      continue;
    }

    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

    // Separator row like |---|---|---|
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;

    if (!header) {
      // This is the header row for the current section's table.
      header = cells;
      idColIdx = header.findIndex((c) => c === 'ID');
      pColIdx = header.length - 1; // 'P' is always the last column
      continue;
    }

    // Data row.
    if (cells.length !== header.length) continue; // malformed row, skip defensively
    const priority = cells[pColIdx];
    if (!/^P[0-2]$/.test(priority)) continue;

    if (idColIdx !== -1) {
      const id = cells[idColIdx];
      if (id) ids.set(id, priority);
    } else if (sectionLetter === 'F') {
      if (priority === 'P0') sectionHasP0 = true;
    }
  }
  flushSection();

  return ids;
}

// ---------------------------------------------------------------------------
// 2. Extract `EC:<id>` mentions from arbitrary text (spec headers, ts/py comments).
//    Handles both continuation styles seen in the codebase:
//      "EC:B1 B2 B7 A15"   (single prefix, space-separated ids)
//      "EC:C1 EC:C5 EC:C6" (repeated prefix)
//      "EC:F/E8/E9"        (slash-separated)
//    Wildcards like "D*" expand to "covers every id starting with D".
// ---------------------------------------------------------------------------

function extractEcIds(text) {
  const ids = new Set();
  const wildcardPrefixes = new Set();
  const tokenRe = /^[ /]*([A-Z]\d*\*?)/;

  const parts = text.split('EC:').slice(1);
  for (const part of parts) {
    let rest = part;
    // First token has no required leading separator.
    let first = true;
    while (true) {
      if (!first && !/^[ /]/.test(rest)) break;
      const m = rest.match(tokenRe);
      if (!m) break;
      const tok = m[1];
      if (tok.endsWith('*')) wildcardPrefixes.add(tok.slice(0, -1));
      else ids.add(tok);
      rest = rest.slice(m[0].length);
      first = false;
    }
  }
  return { ids, wildcardPrefixes };
}

function covers(id, set, wildcardPrefixes) {
  if (set.has(id)) return true;
  const letterMatch = id.match(/^([A-Z])/);
  if (letterMatch && wildcardPrefixes.has(letterMatch[1])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 3. Walk packages/ collecting spec / ts-src / py-src files.
// ---------------------------------------------------------------------------

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

function collectFiles() {
  const all = [];
  walk(join(ROOT, 'packages'), all);
  const spec = all.filter((f) => f.includes('/spec/') && f.endsWith('.pseudo.md'));
  const ts = all.filter((f) => f.includes('/ts/src/') && f.endsWith('.ts'));
  const py = all.filter((f) => f.includes('/py/src/') && f.endsWith('.py'));
  return { spec, ts, py };
}

function buildCoverageSet(files, headerOnly) {
  const ids = new Set();
  const wildcardPrefixes = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (headerOnly) {
      text = text
        .split('\n')
        .filter((l) => l.trimStart().startsWith('##'))
        .join('\n');
    }
    const found = extractEcIds(text);
    for (const id of found.ids) ids.add(id);
    for (const p of found.wildcardPrefixes) wildcardPrefixes.add(p);
  }
  return { ids, wildcardPrefixes };
}

// ---------------------------------------------------------------------------
// 4. Main.
// ---------------------------------------------------------------------------

function main() {
  const docText = readFileSync(DOC_PATH, 'utf8');
  const allIds = parseEdgeCases(docText);

  if (allIds.size === 0) {
    console.error('ec-coverage: parsed zero ids from docs/EDGE_CASES.md — parser is broken or doc changed shape.');
    process.exit(1);
  }

  const p0Ids = [...allIds.entries()].filter(([, p]) => p === 'P0').map(([id]) => id).sort();

  const { spec: specFiles, ts: tsFiles, py: pyFiles } = collectFiles();
  const specCov = buildCoverageSet(specFiles, true);
  const tsCov = buildCoverageSet(tsFiles, false);
  const pyCov = buildCoverageSet(pyFiles, false);

  const rows = p0Ids.map((id) => ({
    id,
    spec: covers(id, specCov.ids, specCov.wildcardPrefixes),
    ts: covers(id, tsCov.ids, tsCov.wildcardPrefixes),
    py: covers(id, pyCov.ids, pyCov.wildcardPrefixes),
  }));

  const missingSpec = rows.filter((r) => !r.spec).map((r) => r.id);
  const missingTs = rows.filter((r) => !r.ts).map((r) => r.id);
  const missingPy = rows.filter((r) => !r.py).map((r) => r.id);

  console.log('Edge-case reference mapping only: source mentions do not prove behavior coverage.');
  console.log(`Parsed ${allIds.size} ids from docs/EDGE_CASES.md (${p0Ids.length} P0).`);
  console.log(`Scanned ${specFiles.length} spec files, ${tsFiles.length} ts files, ${pyFiles.length} py files.\n`);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('ID', 8) + pad('spec', 8) + pad('ts', 8) + pad('py', 8));
  console.log('-'.repeat(32));
  for (const r of rows) {
    console.log(
      pad(r.id, 8) + pad(r.spec ? 'OK' : 'MISSING', 8) + pad(r.ts ? 'OK' : 'MISSING', 8) + pad(r.py ? 'OK' : 'MISSING', 8)
    );
  }

  const anyMissing = missingSpec.length + missingTs.length + missingPy.length > 0;

  if (anyMissing) {
    console.log('\nMissing P0 references:');
    if (missingSpec.length) console.log('  spec: ' + missingSpec.join(' '));
    if (missingTs.length) console.log('  ts:   ' + missingTs.join(' '));
    if (missingPy.length) console.log('  py:   ' + missingPy.join(' '));
    process.exit(1);
  }

  console.log('\nAll P0 edge-case IDs referenced in spec, ts, and py. Behavioral tests must pass separately.');
}

main();
