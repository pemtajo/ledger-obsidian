import * as fs from 'fs';
import { parsePricesDB, preprocessLedger } from '../src/prices';

const prices = fs.readFileSync('/Users/pedro.matias/dev/p/obsidian/ourun/finances/prices.db', 'utf8');
const ledger = fs.readFileSync('/Users/pedro.matias/dev/p/obsidian/ourun/finances/Ledger.ledger', 'utf8');

const idx = parsePricesDB(prices);
console.log('=== prices index ===');
console.log('commodities:', [...idx.keys()].sort().join(', '));

console.log('\n=== preprocessing real ledger ===');
const out = preprocessLedger(ledger, idx);

console.log('\n=== sanity-check migration entries (after preprocess) ===');
const sample = out.split('\n').slice(-80).join('\n');
console.log(sample);

test('preprocessor produces non-zero R$ amounts in NDIV11 migration', () => {
  const lines = out.split('\n');
  const ndiv11Idx = lines.findIndex(l => l.includes('ndiv11 migration'));
  expect(ndiv11Idx).toBeGreaterThan(0);
  const postingLine = lines[ndiv11Idx + 1];
  expect(postingLine).toMatch(/R\$\d/); // should contain R$N
  console.log('NDIV11 posting line after preprocess:', postingLine);
});
