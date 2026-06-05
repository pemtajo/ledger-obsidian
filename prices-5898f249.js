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
const P_HEAD_RE = /^P\s+(\d{4}[\/-]\d{2}[\/-]\d{2})\s+(\S+)\s+(.+?)\s*$/;
// Price formats:
//   "$12.06"      currency-prefix
//   "R$67.37"     currency-prefix
//   "5.05 R$"     value-suffix (used by ledger-cli for USD→BRL rates)
//   "12.06 $"     value-suffix (unusual but tolerated)
const PRICE_PREFIX_RE = /^(R\$|\$)\s*([\d.,]+)$/;
const PRICE_SUFFIX_RE = /^([\d.,]+)\s+(R\$|\$)$/;
const parsePricesDB = (content) => {
    const index = new Map();
    for (const raw of content.split('\n')) {
        const head = raw.match(P_HEAD_RE);
        if (!head)
            continue;
        const [, dateRaw, commodity, priceRaw] = head;
        let price;
        let targetCurrency;
        const pre = priceRaw.match(PRICE_PREFIX_RE);
        if (pre) {
            targetCurrency = pre[1];
            price = parseFloat(pre[2].replace(/,/g, ''));
        }
        else {
            const suf = priceRaw.match(PRICE_SUFFIX_RE);
            if (!suf)
                continue;
            price = parseFloat(suf[1].replace(/,/g, ''));
            targetCurrency = suf[2];
        }
        if (Number.isNaN(price))
            continue;
        const isoDate = dateRaw.replace(/\//g, '-');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJpY2VzLTU4OThmMjQ5LmpzIiwic291cmNlcyI6WyJzcmMvcHJpY2VzLnRzIl0sInNvdXJjZXNDb250ZW50IjpudWxsLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBNEJBLE1BQU0sU0FBUyxHQUFHLHNEQUFzRCxDQUFDO0FBQ3pFO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFNLGVBQWUsR0FBRyx3QkFBd0IsQ0FBQztBQUNqRCxNQUFNLGVBQWUsR0FBRyx3QkFBd0IsQ0FBQztNQUVwQyxhQUFhLEdBQUcsQ0FBQyxPQUFlO0lBQzNDLE1BQU0sS0FBSyxHQUFlLElBQUksR0FBRyxFQUFFLENBQUM7SUFDcEMsS0FBSyxNQUFNLEdBQUcsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFO1FBQ3JDLE1BQU0sSUFBSSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDbEMsSUFBSSxDQUFDLElBQUk7WUFBRSxTQUFTO1FBQ3BCLE1BQU0sR0FBRyxPQUFPLEVBQUUsU0FBUyxFQUFFLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQztRQUU5QyxJQUFJLEtBQWEsQ0FBQztRQUNsQixJQUFJLGNBQTBCLENBQUM7UUFDL0IsTUFBTSxHQUFHLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUM1QyxJQUFJLEdBQUcsRUFBRTtZQUNQLGNBQWMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFlLENBQUM7WUFDdEMsS0FBSyxHQUFHLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1NBQzlDO2FBQU07WUFDTCxNQUFNLEdBQUcsR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLGVBQWUsQ0FBQyxDQUFDO1lBQzVDLElBQUksQ0FBQyxHQUFHO2dCQUFFLFNBQVM7WUFDbkIsS0FBSyxH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
