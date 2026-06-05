/**
 * Parser and resolver for ledger-cli's price database (`prices.db`).
 *
 * Goal: convert every posting in the user's ledger to BRL before the parser
 * sees it, so the Dashboard's net-worth/balance views always work in R$
 * — independent of how many currencies/commodities the user has.
 *
 * Supported price-db lines:
 *   P 2026/06/05 $ 5.05 R$        (USD → BRL rate)
 *   P 2026/06/05 NU $12.06        (USD-quoted commodity)
 *   P 2026/06/05 IRIM11 R$67.37   (BRL-quoted commodity)
 *
 * Posting forms handled in the preprocessor:
 *   account    $-2607.02                       (currency-prefix USD)
 *   account    R$1234.56                       (currency-prefix BRL — passthrough)
 *   account    202 NU                          (commodity suffix, no lot price)
 *   account    202 NU @ $12.06                 (commodity with lot price)
 *   account    35 "IRIM11" @ R$67.37           (quoted commodity ending in digit)
 */

export interface PriceEntry {
  date: string;     // YYYY-MM-DD
  price: number;
  currency: '$' | 'R$';
}

export type PriceIndex = Map<string, PriceEntry[]>; // commodity → entries (date asc)

const P_HEAD_RE = /^P\s+(\d{4}[\/-]\d{2}[\/-]\d{2})\s+(\S+)\s+(.+?)\s*$/;
// Price formats:
//   "$12.06"      currency-prefix
//   "R$67.37"     currency-prefix
//   "5.05 R$"     value-suffix (used by ledger-cli for USD→BRL rates)
//   "12.06 $"     value-suffix (unusual but tolerated)
const PRICE_PREFIX_RE = /^(R\$|\$)\s*([\d.,]+)$/;
const PRICE_SUFFIX_RE = /^([\d.,]+)\s+(R\$|\$)$/;

export const parsePricesDB = (content: string): PriceIndex => {
  const index: PriceIndex = new Map();
  for (const raw of content.split('\n')) {
    const head = raw.match(P_HEAD_RE);
    if (!head) continue;
    const [, dateRaw, commodity, priceRaw] = head;

    let price: number;
    let targetCurrency: '$' | 'R$';
    const pre = priceRaw.match(PRICE_PREFIX_RE);
    if (pre) {
      targetCurrency = pre[1] as '$' | 'R$';
      price = parseFloat(pre[2].replace(/,/g, ''));
    } else {
      const suf = priceRaw.match(PRICE_SUFFIX_RE);
      if (!suf) continue;
      price = parseFloat(suf[1].replace(/,/g, ''));
      targetCurrency = suf[2] as '$' | 'R$';
    }
    if (Number.isNaN(price)) continue;

    const isoDate = dateRaw.replace(/\//g, '-');
    if (!index.has(commodity)) index.set(commodity, []);
    index.get(commodity)!.push({ date: isoDate, price, currency: targetCurrency });
  }
  for (const entries of index.values()) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
  }
  return index;
};

/** Most recent price on or before `date`; falls back to earliest known. */
const getPriceAt = (
  index: PriceIndex,
  commodity: string,
  date: string,
): PriceEntry | null => {
  const entries = index.get(commodity);
  if (!entries || entries.length === 0) return null;
  let lo = 0;
  let hi = entries.length - 1;
  let best: PriceEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].date <= date) {
      best = entries[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best ?? entries[0];
};

/**
 * Convert `amount` of `commodity` to BRL using prices known at `date`.
 * Returns null when no conversion path is available (caller decides fallback).
 */
export const convertToBRL = (
  amount: number,
  commodity: string,
  date: string,
  index: PriceIndex,
): number | null => {
  if (commodity === 'R$') return amount;

  if (commodity === '$') {
    const usdRate = getPriceAt(index, '$', date);
    return usdRate ? amount * usdRate.price : null;
  }

  // Other commodity (NU, SGOV, IRIM11, SOL, USDC, ...)
  const cprice = getPriceAt(index, commodity, date);
  if (!cprice) return null;

  if (cprice.currency === 'R$') {
    return amount * cprice.price; // single hop
  }

  // Commodity priced in USD → chain via USD/BRL
  const usdValue = amount * cprice.price;
  const usdRate = getPriceAt(index, '$', date);
  return usdRate ? usdValue * usdRate.price : null;
};

const TX_DATE_RE = /^(\d{4}[\/-]\d{2}[\/-]\d{2})/;

// `account    -202 NU @ $12.06   ; optional comment`
//          account part           amount     commodity     optional @price        optional comment
const COMMODITY_POSTING_RE =
  /^(\s+[^;#|\n]+?)\s{2,}(-?[\d.,]+)\s+"?([A-Za-z][A-Za-z0-9_.-]*)"?\s*(?:@\s*R?\$[\d.,]+)?(\s*[;#|].*)?$/;

// `account    $-2607.02   ; comment` or `account    R$1234.56`
const CURRENCY_POSTING_RE =
  /^(\s+[^;#|\n]+?)\s{2,}(R\$|\$)\s*(-?[\d.,]+)(\s*[;#|].*)?$/;

const fmtBRL = (value: number): string => {
  if (Object.is(value, NaN)) return 'R$0.00';
  return value < 0 ? `R$-${(-value).toFixed(2)}` : `R$${value.toFixed(2)}`;
};

/**
 * Rewrite every posting in `content` so its amount is BRL, using prices known
 * on each transaction's date. Untouched lines (date headers, comments,
 * implicit-balance postings, structurally unparseable lines) pass through.
 *
 * Line count is preserved so editor offsets stay valid.
 */
export const preprocessLedger = (
  content: string,
  index: PriceIndex,
): string => {
  const lines = content.split('\n');
  let currentDate = '1970-01-01';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const dateMatch = line.match(TX_DATE_RE);
    if (dateMatch) {
      currentDate = dateMatch[1].replace(/\//g, '-');
      continue;
    }

    // Only attempt to rewrite indented lines (postings).
    if (!/^\s/.test(line)) continue;

    // Try commodity-suffix first (more specific). Avoid matching currency-prefix
    // postings (whose amount starts with $ or R$).
    const cm = line.match(COMMODITY_POSTING_RE);
    if (cm) {
      const [, prefix, amountStr, commodity, comment = ''] = cm;
      // Skip if the would-be "commodity" is actually a currency token
      if (commodity === 'R' || commodity === 'R$') {
        // Defer to currency regex below
      } else {
        const amount = parseFloat(amountStr.replace(/,/g, ''));
        const brl = convertToBRL(amount, commodity, currentDate, index);
        if (brl !== null && !Number.isNaN(brl)) {
          lines[i] = `${prefix.trimEnd()}    ${fmtBRL(brl)}${comment}`;
          continue;
        }
        // No price available — leave line untouched (parser will likely drop it
        // or treat it strangely, but at least no false data is injected).
        continue;
      }
    }

    const m = line.match(CURRENCY_POSTING_RE);
    if (m) {
      const [, prefix, currency, amountStr, comment = ''] = m;
      if (currency === 'R$') continue; // already BRL
      const amount = parseFloat(amountStr.replace(/,/g, ''));
      const brl = convertToBRL(amount, '$', currentDate, index);
      if (brl !== null && !Number.isNaN(brl)) {
        lines[i] = `${prefix.trimEnd()}    ${fmtBRL(brl)}${comment}`;
      }
    }
  }

  return lines.join('\n');
};
