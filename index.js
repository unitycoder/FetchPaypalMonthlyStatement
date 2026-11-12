'use strict';

// Node.js 18+; npm install pdfkit
// Keep this file alongside secrets/secret.json, as with the original script.
// Usage: node paypal-report.js [year] [month]
// The receipts are locally generated API records, not PayPal-issued PDFs or merchant invoices.
// References: https://developer.paypal.com/reports/reference/t-codes
// https://developer.paypal.com/api/transaction-search/v1/search-get

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const PDFDocument = require('pdfkit');

const REPORT_YEAR = Number(process.argv[2] || 2026);
const REPORT_MONTH = Number(process.argv[3] || 10);

const BASE = 'https://api-m.paypal.com';
const OUTPUT_ROOT = path.join(__dirname, 'reports');
const STATUS = { S: 'Completed', P: 'Pending', D: 'Denied', V: 'Reversed' };
const CATEGORY = { paymentsReceived: 'Payments received', paymentsSent: 'Payments sent', conversions: 'Currency conversions', transfers: 'Funding and withdrawals', fees: 'Fees', holds: 'Holds and releases', adjustments: 'Refunds, reversals and adjustments', other: 'Other movements' };

const EVENTS = {
    T0000: 'General payment',
    T0001: 'Mass payment',
    T0002: 'Subscription payment',
    T0003: 'Preapproved recurring payment',
    T0004: 'eBay auction payment',
    T0005: 'Credit card payment',
    T0006: 'Express Checkout payment',
    T0007: 'Standard web checkout payment',
    T0008: 'Postage payment',
    T0009: 'Gift certificate payment',
    T0010: 'Third-party auction payment',
    T0011: 'Mobile payment',
    T0012: 'Virtual Terminal payment',
    T0013: 'Donation payment',
    T0014: 'Rebate or cashback payment',
    T0015: 'Third-party payout',
    T0016: 'Third-party recoupment',
    T0017: 'Chained payment or refund',
    T0018: 'Point-of-sale payment',
    T0023: 'Business payment',
    T0200: 'General currency conversion',
    T0201: 'User-initiated currency conversion',
    T0202: 'Conversion to cover negative balance',
    T0300: 'Bank deposit to PayPal account',
    T0301: 'Balance Manager account funding',
    T0302: 'ACH funds recovery',
    T0303: 'Electronic funds transfer funding',
    T0400: 'Bank withdrawal',
    T0401: 'Automatic withdrawal (auto-sweep)',
    T0402: 'Withdrawal to Hyperwallet',
    T0403: 'Manual withdrawal',
    T0500: 'PayPal debit card transaction',
    T0501: 'Virtual debit card transaction',
    T0502: 'Debit card ATM withdrawal',
    T0503: 'Hidden virtual debit card transaction',
    T0504: 'Debit card cash advance',
    T0505: 'Debit card authorization',
    T0600: 'Credit card withdrawal',
    T0700: 'Credit card deposit',
    T0701: 'Credit card funding of negative balance',
    T1100: 'General reversal',
    T1101: 'Reversal of ACH withdrawal',
    T1102: 'Debit card reversal',
    T1104: 'Reversal of ACH deposit',
    T1105: 'Reversal of account hold',
    T1106: 'Payment reversal',
    T1107: 'Payment refund',
    T1108: 'Fee reversal',
    T1109: 'Fee refund',
    T1110: 'Dispute investigation hold',
    T1111: 'Cancellation of dispute hold',
    T1112: 'Cancelled transfer',
    T1114: 'Mass payment reversal',
    T1115: 'Mass payment refund',
    T1200: 'Account adjustment',
    T1201: 'Chargeback',
    T1202: 'Chargeback reversal',
    T1300: 'Authorization',
    T1500: 'Account hold',
    T1501: 'Open authorization hold',
    T1700: 'Withdrawal to non-bank institution',
    T1900: 'Account correction',
    T2000: 'Intraaccount transfer',
    T2001: 'Consolidation transfer',
    T2101: 'General hold',
    T2102: 'General hold release',
    T2103: 'Reserve hold',
    T2104: 'Reserve release',
    T9800: 'Display-only transaction',
    T9900: 'Other transaction'
};

function loadSecrets()
{
    const file = path.join(__dirname, 'secrets', 'secret.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

const SECRETS = loadSecrets();
const COMPANY = [SECRETS.COMPANY_NAME, ...(SECRETS.COMPANY_ADDRESS || [])].filter(Boolean);

function monthRange(year, month)
{
    if (!Number.isInteger(year) || year < 2000 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('Supply a valid year and month (1-12).');
    return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

async function requestJson(url, options = {})
{
    for (let attempt = 0; attempt < 4; attempt++)
    {
        const res = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });

        if ((res.status === 429 || res.status >= 500) && attempt < 3)
        {
            const retryAfter = res.headers.get('retry-after');
            const delay = Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now() || 1000 * (2 ** attempt);
            await res.arrayBuffer();
            await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(1000, delay))));
            continue;
        }

        if (!res.ok)
        {
            const err = new Error(`PayPal request failed: HTTP ${res.status} ${res.statusText}; endpoint ${new URL(url).pathname}; debug ID ${res.headers.get('paypal-debug-id') || 'unavailable'}`);
            err.status = res.status;
            throw err;
        }

        return res.json();
    }
}

async function accessToken()
{
    const id = process.env.PAYPAL_CLIENT_ID || SECRETS.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET || SECRETS.PAYPAL_CLIENT_SECRET;

    if (!id || !secret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET or provide secrets/secret.json.');

    const auth = Buffer.from(`${id}:${secret}`).toString('base64');
    const data = await requestJson(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });

    if (!data.access_token) throw new Error('PayPal did not return an access token.');

    return data.access_token;
}

async function fetchTransactions(token, start, end)
{
    const all = [];

    // Query the half-open month precisely; do not include next month's midnight.
    const endInclusive = new Date(end.getTime() - 1).toISOString();

    for (let page = 1; ; page++)
    {
        const url = new URL(`${BASE}/v1/reporting/transactions`);
        url.search = new URLSearchParams({ start_date: start.toISOString(), end_date: endInclusive, fields: 'all', balance_affecting_records_only: 'Y', page_size: '500', page: String(page) }).toString();

        const data = await requestJson(url, { headers: { Authorization: `Bearer ${token}` } });

        // PayPal omits transaction_details when the range has no transactions.
        if (data.transaction_details === undefined && Number(data.total_items) === 0) data.transaction_details = [];
        if (!Array.isArray(data.transaction_details)) throw new Error(`Unexpected transaction response: transaction_details is missing. Keys: ${Object.keys(data || {}).join(', ')}`);

        all.push(...data.transaction_details);
        console.log(`Fetched page ${page}: ${data.transaction_details.length} records.`);

        if (page >= Number(data.total_pages || 1)) break;
    }

    // Do not deduplicate by ID: PayPal can return multiple distinct records with the same ID.
    return all.sort((a, b) => String(a.transaction_info?.transaction_initiation_date || '').localeCompare(String(b.transaction_info?.transaction_initiation_date || '')));
}

async function fetchBalances(token, date)
{
    const url = new URL(`${BASE}/v1/reporting/balances`);
    url.searchParams.set('as_of_time', date.toISOString());

    try
    {
        const data = await requestJson(url, { headers: { Authorization: `Bearer ${token}` } });
        return { ok: true, requestedAt: date.toISOString(), data };
    }
    catch (err)
    {
        console.warn(`Balance unavailable at ${date.toISOString()}: ${err.message}`);
        return { ok: false, requestedAt: date.toISOString(), error: err.message };
    }
}

function number(value)
{
    if (value === '' || value === null || value === undefined) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function money(amount)
{
    const value = number(amount?.value);
    return value === null ? 'Not provided' : `${value.toFixed(2)} ${amount.currency_code || '(currency not provided)'}`;
}

function eventName(code)
{
    if (EVENTS[code]) return EVENTS[code];
    if (code?.startsWith('T01')) return 'PayPal fee';

    return code ? 'Transaction (unmapped event code)' : 'Transaction (event code not provided)';
}

function classify(t)
{
    const code = t.info.transaction_event_code || '';

    if (/^T02/.test(code)) return 'conversions';
    if (/^T01/.test(code) || ['T1108', 'T1109'].includes(code)) return 'fees';
    if (/^T(13|15|21)/.test(code) || ['T0505', 'T1105', 'T1110', 'T1111'].includes(code)) return 'holds';
    if (/^T(03|04|06|07|17|20)/.test(code) || ['T0502', 'T0504'].includes(code)) return 'transfers';
    if (/^T(11|12|19)/.test(code)) return 'adjustments';
    if (/^T00/.test(code) || ['T0500', 'T0501', 'T0503'].includes(code)) return number(t.info.transaction_amount?.value) < 0 ? 'paymentsSent' : 'paymentsReceived';

    return 'other';
}

function normalize(raw, index)
{
    const info = raw.transaction_info || {};
    const payer = raw.payer_info || {};
    const name = payer.payer_name || {};
    const fullName = name.full_name || name.alternate_full_name || [name.given_name, name.middle_name, name.surname].filter(Boolean).join(' ');
    const conversion = /^T02/.test(info.transaction_event_code || '');
    const contact = [fullName, payer.email_address].filter(Boolean).join('\n');
    const contactFallback = conversion ? 'Internal currency conversion' : 'Name/email not provided by PayPal';
    const gross = info.transaction_amount;
    const fee = info.fee_amount;

    let net = info.net_amount || null;
    let netDerived = false;

    if (!net && number(gross?.value) !== null && number(fee?.value) !== null && gross.currency_code && gross.currency_code === fee.currency_code)
    {
        net = { value: String(number(gross.value) + number(fee.value)), currency_code: gross.currency_code };
        netDerived = true;
    }

    return { raw, info, index, contact: contact || contactFallback, conversion, net, netDerived, id: info.transaction_id || 'no-id', currency: gross?.currency_code || 'UNKNOWN' };
}

function relatedRecords(t, all)
{
    const ref = t.info.paypal_reference_id_type === 'TXN' ? t.info.paypal_reference_id : null;
    return all.filter(other => other !== t && (other.id === t.id && t.id !== 'no-id' || ref && other.id === ref || other.info.paypal_reference_id_type === 'TXN' && other.info.paypal_reference_id === t.id && t.id !== 'no-id'));
}

function safeFilename(value)
{
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 90) || 'unknown';
}

function receiptFilename(t)
{
    return `${String(t.index + 1).padStart(5, '0')}_${safeFilename((t.info.transaction_initiation_date || 'undated').slice(0, 10))}_${safeFilename(t.id)}_${safeFilename(t.info.transaction_event_code || 'event')}_${safeFilename(t.currency)}.pdf`;
}

async function writePdf(file, render, landscape = false)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const temporary = `${file}.tmp`;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 40, info: { Title: path.basename(file, '.pdf'), Author: COMPANY[0] } });

    // Embed a local font when available, including Finnish names. No extra npm dependency.
    const fontPairs = [[process.env.PAYPAL_FONT_REGULAR, process.env.PAYPAL_FONT_BOLD], [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'), path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arialbd.ttf')], ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf']];
    const pair = fontPairs.find(([regular, bold]) => regular && bold && fs.existsSync(regular) && fs.existsSync(bold));

    doc.registerFont('Body', pair ? pair[0] : 'Helvetica');
    doc.registerFont('BodyBold', pair ? pair[1] : 'Helvetica-Bold');

    const completed = pipeline(doc, fs.createWriteStream(temporary));

    // Observe errors immediately even if rendering throws before await.
    completed.catch(() => {});

    try
    {
        render(doc);
        doc.end();
        await completed;
        fs.renameSync(temporary, file);
    }
    catch (err)
    {
        doc.destroy(err);
        await completed.catch(() => {});
        fs.rmSync(temporary, { force: true });
        throw err;
    }
}

function heading(doc, title)
{
    doc.x = doc.page.margins.left;
    doc.font('BodyBold').fontSize(16).fillColor('#173451').text(title);
    doc.moveDown(0.6);
    doc.font('Body').fontSize(10).fillColor('black');
}

function paragraph(doc, value, options = {})
{
    doc.font('Body').fontSize(10).fillColor('black').text(String(value), doc.page.margins.left, doc.y, { width: doc.page.width - 80, ...options });
    doc.moveDown(0.4);
}

function table(doc, headers, rows, fractions)
{
    const widths = fractions.map(f => f * (doc.page.width - 80));
    const x0 = doc.page.margins.left;
    const bottom = doc.page.height - 40;

    function draw(cells, bold, shaded)
    {
        doc.font(bold ? 'BodyBold' : 'Body').fontSize(9);

        const height = Math.max(...cells.map((cell, i) => doc.heightOfString(String(cell), { width: widths[i] - 12 })), 12) + 12;
        const y = doc.y;

        if (shaded) doc.save().rect(x0, y, doc.page.width - 80, height).fill('#edf2f7').restore();

        let x = x0;

        cells.forEach((cell, i) =>
        {
            doc.fillColor('black').text(String(cell), x + 6, y + 6, { width: widths[i] - 12 });
            x += widths[i];
        });

        doc.moveTo(x0, y + height).lineTo(doc.page.width - 40, y + height).strokeColor('#ccd6df').stroke();
        doc.x = x0;
        doc.y = y + height;

        return height;
    }

    doc.font('Body').fontSize(9);

    const totalHeight = rows.reduce((total, row) => total + Math.max(...row.map((cell, i) => doc.heightOfString(String(cell), { width: widths[i] - 12 })), 12) + 12, 35);

    if (doc.y + 70 > bottom || totalHeight < bottom - 40 && doc.y + totalHeight > bottom) doc.addPage();

    draw(headers, true, true);

    for (const [index, row] of rows.entries())
    {
        doc.font('Body').fontSize(9);

        const h = Math.max(...row.map((cell, i) => doc.heightOfString(String(cell), { width: widths[i] - 12 })), 12) + 12;

        if (doc.y + h > bottom)
        {
            doc.addPage();
            draw(headers, true, true);
        }

        draw(row, false, index % 2 === 0);
    }

    doc.y += 12;
}

function short(value, limit = 180)
{
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function balanceRows(result)
{
    if (!result.ok || !Array.isArray(result.data.balances)) return [];

    return result.data.balances.map(b => [b.currency || b.currency_code || 'Unknown', money(b.total_balance), money(b.available_balance), money(b.withheld_balance)]);
}

function activitySummary(all)
{
    const byCurrency = new Map();

    function add(currency, bucket, value)
    {
        if (number(value) === null) return;
        if (!byCurrency.has(currency)) byCurrency.set(currency, Object.fromEntries(Object.keys(CATEGORY).map(k => [k, 0])));

        byCurrency.get(currency)[bucket] += Number(value);
    }

    for (const t of all)
    {
        add(t.currency, classify(t), t.info.transaction_amount?.value);

        if (number(t.info.fee_amount?.value) !== null) add(t.info.fee_amount.currency_code || 'UNKNOWN', 'fees', t.info.fee_amount.value);
    }

    return byCurrency;
}

async function generateReport(file, all, start, end, beginning, ending, period)
{
    await writePdf(file, doc =>
    {
        heading(doc, 'PayPal Monthly Report');
        paragraph(doc, COMPANY.join('\n'));
        paragraph(doc, `Period: ${period} (UTC). ${all.length} balance-affecting transaction records.`);
        paragraph(doc, 'Generated from the PayPal Reporting API. Full details are in the separate transaction PDFs.');

        for (const [label, result] of [['Beginning balance snapshot', beginning], ['Ending balance snapshot', ending]])
        {
            heading(doc, label);
            paragraph(doc, `Requested: ${result.requestedAt}\nReturned as of: ${result.data?.as_of_time || 'Not provided'}; last refreshed: ${result.data?.last_refresh_time || 'Not provided'}`);

            const rows = balanceRows(result);

            if (rows.length) table(doc, ['Currency', 'Total', 'Available', 'Withheld'], rows, [0.16, 0.28, 0.28, 0.28]);
            else paragraph(doc, 'Balance data unavailable.');
        }

        doc.addPage();
        heading(doc, 'Activity Summary');
        paragraph(doc, 'Signed gross amounts by event category; transaction fees are added separately in their own currency. Conversions, holds and refunds remain separate from sales. Available-balance changes may differ because of holds and reporting snapshots.');

        const summary = activitySummary(all);

        for (const [currency, buckets] of summary)
        {
            const rows = Object.entries(CATEGORY).map(([key, label]) => [label, buckets[key].toFixed(2)]);
            rows.push(['Sum of listed movements and fees', Object.values(buckets).reduce((a, b) => a + b, 0).toFixed(2)]);
            table(doc, ['Category', currency], rows, [0.78, 0.22]);
        }

        if (!all.length) paragraph(doc, 'No transactions returned.');

        for (const currency of [...new Set(all.map(t => t.currency))].sort())
        {
            doc.addPage();
            heading(doc, `Transaction History - ${currency}`);
            paragraph(doc, 'Net* is calculated as gross plus the signed fee, only when both currencies match. Missing amounts are not assumed to be zero. Long text is shortened here; separate PDFs retain all returned fields.');

            const rows = all.filter(t => t.currency === currency).map(t => [(t.info.transaction_initiation_date || '').slice(0, 10), [eventName(t.info.transaction_event_code), t.info.transaction_event_code, short(t.info.transaction_subject), short(t.info.transaction_note), `ID: ${t.id}`, `Receipt: ${t.index + 1}`].filter(Boolean).join('\n'), short(t.contact, 200), money(t.info.transaction_amount), money(t.info.fee_amount), `${money(t.net)}${t.netDerived ? '*' : ''}`]);

            table(doc, ['Date', 'Description', 'Name / Email', 'Gross', 'Fee', 'Net'], rows, [0.10, 0.32, 0.22, 0.12, 0.12, 0.12]);
        }
    }, true);
}

function flatten(value, prefix = '', out = [])
{
    if (value === null || value === undefined) return out;

    if (typeof value !== 'object') out.push([prefix, String(value)]);
    else for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);

    return out;
}

async function generateReceipt(file, t, all)
{
    await writePdf(file, doc =>
    {
        heading(doc, 'PayPal Transaction Record');
        paragraph(doc, COMPANY.join('\n'));
        paragraph(doc, 'Generated from PayPal API data. This is not a PayPal-issued receipt or a supplier tax invoice.');

        const details = [['Transaction ID', t.id], ['Date', t.info.transaction_initiation_date || 'Not provided'], ['Event', `${eventName(t.info.transaction_event_code)} (${t.info.transaction_event_code || 'unknown'})`], ['Category', CATEGORY[classify(t)]], ['Status', STATUS[t.info.transaction_status] || t.info.transaction_status || 'Not provided'], ['Name / Email (API payer_info)', t.contact], ['Gross', money(t.info.transaction_amount)], ['Fee', money(t.info.fee_amount)], [t.netDerived ? 'Net (gross + signed fee, calculated)' : 'Net', money(t.net)]];

        for (const [label, value] of details) paragraph(doc, `${label}: ${value}`);

        if (t.conversion) paragraph(doc, 'This record is a currency conversion between balances. It does not identify a merchant purchase. An external recipient name or email may therefore be absent.');

        const related = relatedRecords(t, all);

        if (related.length)
        {
            paragraph(doc, 'Related records in this export (linked by transaction ID or an explicit TXN reference):');

            for (const other of related) paragraph(doc, `${other.id} | ${eventName(other.info.transaction_event_code)} | ${money(other.info.transaction_amount)} | Receipt ${other.index + 1}`);
        }

        if (t.conversion && !related.length) paragraph(doc, 'No related conversion leg was identified by ID in this export. No destination currency or exchange rate has been inferred.');

        doc.addPage();
        heading(doc, 'All Returned Transaction Fields');
        paragraph(doc, 'Original API field names are retained below, including available item details, addresses, notes and references. Missing fields were not supplied by PayPal.');

        for (const [key, value] of flatten(t.raw))
        {
            if (doc.y + 45 > doc.page.height - 40) doc.addPage();

            doc.font('BodyBold').fontSize(8).fillColor('#173451').text(key, 40, doc.y, { width: doc.page.width - 80 });
            doc.font('Body').fontSize(9).fillColor('black').text(value, 40, doc.y, { width: doc.page.width - 80 });
            doc.moveDown(0.5);
        }
    });
}

async function exportFiles(raw, beginning, ending, start, end, root = OUTPUT_ROOT)
{
    const period = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const directory = path.join(root, `paypal-${period}`);
    const receiptDir = path.join(directory, 'receipts');

    fs.mkdirSync(receiptDir, { recursive: true });

    const all = raw.map(normalize);
    const reportFile = path.join(directory, `paypal-report-${period}.pdf`);

    // Retain the complete source data even if a later PDF write fails.
    fs.writeFileSync(path.join(directory, 'transactions.json'), JSON.stringify({ period, fetchedAt: new Date().toISOString(), start: start.toISOString(), endExclusive: end.toISOString(), transactions: raw, beginningBalance: beginning, endingBalance: ending }, null, 2));

    await generateReport(reportFile, all, start, end, beginning, ending, period);

    const manifest = [];

    for (const t of all)
    {
        const file = receiptFilename(t);
        await generateReceipt(path.join(receiptDir, file), t, all);
        manifest.push({ transactionId: t.id, eventCode: t.info.transaction_event_code, currency: t.currency, amount: t.info.transaction_amount?.value, file: `receipts/${file}` });
    }

    // This index is authoritative for the current run; older files are not deleted.
    fs.writeFileSync(path.join(directory, 'receipt-index.json'), JSON.stringify(manifest, null, 2));

    console.log(`Report: ${reportFile}`);
    console.log(`Transaction PDFs: ${manifest.length}, in ${receiptDir}`);

    return { directory, reportFile, manifest };
}

async function main()
{
    const { start, end } = monthRange(REPORT_YEAR, REPORT_MONTH);
    const token = await accessToken();
    const raw = await fetchTransactions(token, start, end);
    const beginning = await fetchBalances(token, start);
    const ending = await fetchBalances(token, end);

    await exportFiles(raw, beginning, ending, start, end);
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });

module.exports = { monthRange, fetchTransactions, normalize, classify, activitySummary, relatedRecords, receiptFilename, exportFiles };