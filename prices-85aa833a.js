'use strict';

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
const P_LINE_RE = /^P\s+(\d{4}[\/-]\d{2}[\/-]\d{2})\s+(\S+)\s+(R\$|\$)\s*([\d.,]+)\s*(R\$|\$)?\s*$/;
const parsePricesDB = (content) => {
    const index = new Map();
    for (const raw of content.split('\n')) {
        const m = raw.match(P_LINE_RE);
        if (!m)
            continue;
        const [, dateRaw, commodity, prefixCur, priceStr, suffixCur] = m;
        const isoDate = dateRaw.replace(/\//g, '-');
        const price = parseFloat(priceStr.replace(/,/g, ''));
        if (Number.isNaN(price))
            continue;
        // Determine target currency:
        //   P DATE $ 5.05 R$    → commodity=$, prefix=$, suffix=R$ → target R$
        //   P DATE NU $12.06    → commodity=NU, prefix=$ → target $
        //   P DATE IRIM11 R$67  → commodity=IRIM11, prefix=R$ → target R$
        const targetCurrency = suffixCur === 'R$' ? 'R$' : prefixCur;
        if (!index.has(commodity))
            index.set(commodity, []);
        index.get(commodity).push({ date: isoDate, price, currency: targetCurrency });
    }
    for (const entries of index.values()) {
        entries.sort((a, b) => a.date.localeCompare(b.date));
    }
    return index;
};
/** Most recent price on or before `date`; falls back to earliest known. */
const getPriceAt = (index, commodity, date) => {
    const entries = index.get(commodity);
    if (!entries || entries.length === 0)
        return null;
    let lo = 0;
    let hi = entries.length - 1;
    let best = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].date <= date) {
            best = entries[mid];
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    return best ?? entries[0];
};
/**
 * Convert `amount` of `commodity` to BRL using prices known at `date`.
 * Returns null when no conversion path is available (caller decides fallback).
 */
const convertToBRL = (amount, commodity, date, index) => {
    if (commodity === 'R$')
        return amount;
    if (commodity === '$') {
        const usdRate = getPriceAt(index, '$', date);
        return usdRate ? amount * usdRate.price : null;
    }
    // Other commodity (NU, SGOV, IRIM11, SOL, USDC, ...)
    const cprice = getPriceAt(index, commodity, date);
    if (!cprice)
        return null;
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
const COMMODITY_POSTING_RE = /^(\s+[^;#|\n]+?)\s{2,}(-?[\d.,]+)\s+"?([A-Za-z][A-Za-z0-9_.-]*)"?\s*(?:@\s*R?\$[\d.,]+)?(\s*[;#|].*)?$/;
// `account    $-2607.02   ; comment` or `account    R$1234.56`
const CURRENCY_POSTING_RE = /^(\s+[^;#|\n]+?)\s{2,}(R\$|\$)\s*(-?[\d.,]+)(\s*[;#|].*)?$/;
const fmtBRL = (value) => {
    if (Object.is(value, NaN))
        return 'R$0.00';
    return value < 0 ? `R$-${(-value).toFixed(2)}` : `R$${value.toFixed(2)}`;
};
/**
 * Rewrite every posting in `content` so its amount is BRL, using prices known
 * on each transaction's date. Untouched lines (date headers, comments,
 * implicit-balance postings, structurally unparseable lines) pass through.
 *
 * Line count is preserved so editor offsets stay valid.
 */
const preprocessLedger = (content, index) => {
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
        if (!/^\s/.test(line))
            continue;
        // Try commodity-suffix first (more specific). Avoid matching currency-prefix
        // postings (whose amount starts with $ or R$).
        const cm = line.match(COMMODITY_POSTING_RE);
        if (cm) {
            const [, prefix, amountStr, commodity, comment = ''] = cm;
            // Skip if the would-be "commodity" is actually a currency token
            if (commodity === 'R' || commodity === 'R$') ;
            else {
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
            if (currency === 'R$')
                continue; // already BRL
            const amount = parseFloat(amountStr.replace(/,/g, ''));
            const brl = convertToBRL(amount, '$', currentDate, index);
            if (brl !== null && !Number.isNaN(brl)) {
                lines[i] = `${prefix.trimEnd()}    ${fmtBRL(brl)}${comment}`;
            }
        }
    }
    return lines.join('\n');
};

exports.convertToBRL = convertToBRL;
exports.parsePricesDB = parsePricesDB;
exports.preprocessLedger = preprocessLedger;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJpY2VzLTg1YWE4MzNhLmpzIiwic291cmNlcyI6WyJzcmMvcHJpY2VzLnRzIl0sInNvdXJjZXNDb250ZW50IjpudWxsLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNEJBLE1BQU0sU0FBUyxHQUNiLGlGQUFpRixDQUFDO01BRXZFLGFBQWEsR0FBRyxDQUFDLE9BQWU7SUFDM0MsTUFBTSxLQUFLLEdBQWUsSUFBSSxHQUFHLEVBQUUsQ0FBQztJQUNwQyxLQUFLLE1BQU0sR0FBRyxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUU7UUFDckMsTUFBTSxDQUFDLEdBQUcsR0FBRyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUMvQixJQUFJLENBQUMsQ0FBQztZQUFFLFNBQVM7UUFDakIsTUFBTSxHQUFHLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDakUsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDNUMsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7UUFDckQsSUFBSSxNQUFNLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQztZQUFFLFNBQVM7Ozs7O1FBTWxDLE1BQU0sY0FBYyxHQUFlLFNBQVMsS0FBSyxJQUFJLEdBQUcsSUFBSSxHQUFJLFNBQXdCLENBQUM7UUFFekYsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDO1lBQUUsS0FBSyxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDcEQsS0FBSyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsT0FBTyxF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
