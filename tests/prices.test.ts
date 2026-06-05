import { parsePricesDB, preprocessLedger, convertToBRL } from '../src/prices';
import * as fs from 'fs';

const samplePrices = `P 2026/06/05 $ 5.05 R$
P 2026/06/05 NU $12.06
P 2026/06/05 IRIM11 R$67.37
P 2026/06/05 SOL $62.86`;

test('parses USD/BRL rate', () => {
  const idx = parsePricesDB(samplePrices);
  expect(idx.get('$')).toEqual([{ date: '2026-06-05', price: 5.05, currency: 'R$' }]);
});

test('parses commodity USD price', () => {
  const idx = parsePricesDB(samplePrices);
  expect(idx.get('NU')).toEqual([{ date: '2026-06-05', price: 12.06, currency: '$' }]);
});

test('parses commodity BRL price', () => {
  const idx = parsePricesDB(samplePrices);
  expect(idx.get('IRIM11')).toEqual([{ date: '2026-06-05', price: 67.37, currency: 'R$' }]);
});

test('R$ → R$ is identity', () => {
  const idx = parsePricesDB(samplePrices);
  expect(convertToBRL(100, 'R$', '2026-06-05', idx)).toBe(100);
});

test('$ → R$ via daily rate', () => {
  const idx = parsePricesDB(samplePrices);
  expect(convertToBRL(100, '$', '2026-06-05', idx)).toBeCloseTo(505);
});

test('NU → R$ via chain', () => {
  const idx = parsePricesDB(samplePrices);
  // 202 × $12.06 × R$5.05 = R$12302.41
  expect(convertToBRL(202, 'NU', '2026-06-05', idx)).toBeCloseTo(12302.41, 1);
});

test('IRIM11 → R$ single-hop', () => {
  const idx = parsePricesDB(samplePrices);
  expect(convertToBRL(35, 'IRIM11', '2026-06-05', idx)).toBeCloseTo(2357.95, 2);
});

test('SOL → R$ via chain', () => {
  const idx = parsePricesDB(samplePrices);
  // 1.13 × $62.86 × R$5.05 = R$358.71
  expect(convertToBRL(1.13, 'SOL', '2026-06-05', idx)).toBeCloseTo(358.71, 1);
});

test('preprocessor rewrites commodity-suffix amount', () => {
  const idx = parsePricesDB(samplePrices);
  const input = `2026/06/05 nu migration
    assets:save:USD:stocks:etrade:NU    202 NU @ $12.06
    equity:realignment`;
  const out = preprocessLedger(input, idx);
  expect(out).toContain('R$12302.41');
});

test('preprocessor rewrites $ to R$', () => {
  const idx = parsePricesDB(samplePrices);
  const input = `2026/06/05 sgov
    assets:save:USD:ETF:avenue:SGOV    $-89.76
    income`;
  const out = preprocessLedger(input, idx);
  expect(out).toContain('R$-453.29'); // -89.76 × 5.05 ≈ -453.29
});

test('preprocessor leaves R$ untouched', () => {
  const idx = parsePricesDB(samplePrices);
  const input = `2026/06/01 cashback
    assets:save:BRL:fixa:cdb:nubank:uv    R$0.90
    income`;
  const out = preprocessLedger(input, idx);
  expect(out).toContain('R$0.90');
  expect(out).not.toContain('R$4.55'); // should not be doubled by conversion
});

test('preprocessor handles quoted commodity ending in digit', () => {
  const idx = parsePricesDB(samplePrices);
  const input = `2026/06/05 irim11
    assets:save:BRL:var:FII:nubank:IRIM11    35 "IRIM11" @ R$67.37
    equity`;
  const out = preprocessLedger(input, idx);
  expect(out).toContain('R$2357.95');
});

test('preprocessor preserves line count for editor offsets', () => {
  const idx = parsePricesDB(samplePrices);
  const input = "line1\nline2\nline3\n";
  expect(preprocessLedger(input, idx).split('\n').length).toBe(input.split('\n').length);
});
