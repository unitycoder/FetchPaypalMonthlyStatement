'use strict';

const fs = require('fs');
const PDFDocument = require('pdfkit');

const secrets = loadSecrets();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || secrets.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || secrets.PAYPAL_CLIENT_SECRET || '';

function loadSecrets()
{
    try
    {
        return require('./secrets/secret.json');
    }
    catch (err)
    {
        if (err.code !== 'MODULE_NOT_FOUND')
        {
            throw err;
        }

        return {};
    }
}

// Adjust these:
const REPORT_YEAR = 2025;
const REPORT_MONTH = 11;

// Output file:
const OUTPUT_PDF = `reports/paypal-report-${REPORT_YEAR}-${String(REPORT_MONTH).padStart(2, '0')}.pdf`;

// Live endpoints (not sandbox):
const BASE = 'https://api-m.paypal.com';

function assertEnv()
{
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)
    {
        throw new Error('Missing PayPal credentials. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET env vars or provide secrets/secret.json.');
    }
}

function toIsoUtc(dt)
{
    return dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function monthRangeUtc(year, month1to12)
{
    const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, month1to12, 1, 0, 0, 0));
    return { start, end };
}

function daysInMonthUtc(year, month1to12)
{
    return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

async function paypalAccessToken()
{
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

    const res = await fetch(`${BASE}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    if (!res.ok)
    {
        const text = await res.text().catch(() => '');
        throw new Error(`Token request failed: ${res.status} ${res.statusText}\n${text}`);
    }

    const data = await res.json();
    if (!data.access_token) throw new Error('No access_token in token response.');
    return data.access_token;
}

async function fetchAllTransactions(token, startIso, endIso)
{
    const pageSize = 100;
    let page = 1;
    let all = [];

    for (; ;)
    {
        const url = new URL(`${BASE}/v1/reporting/transactions`);
        url.searchParams.set('start_date', startIso);
        url.searchParams.set('end_date', endIso);
        url.searchParams.set('fields', 'all');
        url.searchParams.set('page_size', String(pageSize));
        url.searchParams.set('page', String(page));

        const res = await fetch(url.toString(), {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok)
        {
            const text = await res.text().catch(() => '');
            throw new Error(`Transactions request failed: ${res.status} ${res.statusText}\n${text}`);
        }

        const data = await res.json();
        const txns = Array.isArray(data.transaction_details) ? data.transaction_details : [];
        all = all.concat(txns);

        console.log(`Fetched page ${page}, ${txns.length} transactions.`);

        const totalPages = data.total_pages || 1;
        if (page >= totalPages) break;
        page += 1;
    }

    return all;
}

async function fetchBalancesAsOf(token, asOfIso)
{
    const url = new URL(`${BASE}/v1/reporting/balances`);
    if (asOfIso) url.searchParams.set('as_of_time', asOfIso);

    const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok)
    {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, statusText: res.statusText, body: text };
    }

    const data = await res.json();
    return { ok: true, data };
}

function extractBalancesArray(balancesResult)
{
    if (!balancesResult || !balancesResult.ok) return [];
    const data = balancesResult.data;

    if (Array.isArray(data?.balances)) return data.balances;
    if (Array.isArray(data?.balance)) return data.balance;
    if (Array.isArray(data)) return data;

    return [];
}

function pickAvailableByCurrency(balancesArr)
{
    const map = new Map();
    for (const b of balancesArr)
    {
        const cur = b.currency_code || b.currency || b.currencyCode || '';
        const avail = Number(b.available_balance?.value ?? b.available?.value ?? b.available_balance ?? b.available);
        const total = Number(b.total_balance?.value ?? b.total?.value ?? b.total_balance ?? b.total);

        const v = Number.isFinite(avail) ? avail : (Number.isFinite(total) ? total : NaN);
        if (!cur || !Number.isFinite(v)) continue;

        map.set(cur, v);
    }
    return map;
}

function pickTotalByCurrency(balancesArr)
{
    const map = new Map();
    for (const b of balancesArr)
    {
        const cur = b.currency_code || b.currency || b.currencyCode || '';
        const total = Number(
            b.total_balance?.value ??
            b.total?.value ??
            b.total_balance ??
            b.total
        );

        if (!cur || !Number.isFinite(total)) continue;
        map.set(cur, total);
    }
    return map;
}

function pickWithheldByCurrency(balancesArr)
{
    // Withheld = total - available (if both are present)
    const avail = pickAvailableByCurrency(balancesArr);
    const total = pickTotalByCurrency(balancesArr);

    const out = new Map();
    for (const [cur, t] of total.entries())
    {
        const a = avail.get(cur);
        if (!Number.isFinite(a)) continue;
        out.set(cur, t - a);
    }
    return out;
}


function safeGet(obj, path, fallback = '')
{
    try
    {
        return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? fallback;
    } catch
    {
        return fallback;
    }
}

function normalizeTransaction(t)
{
    const td = t || {};
    const info = td.transaction_info || {};
    const payer = td.payer_info || {};
    const ship = td.shipping_info || {};

    const transactionId = info.transaction_id || '';
    const date = info.transaction_initiation_date || info.transaction_updated_date || '';
    const status = info.transaction_status || '';
    const type = info.transaction_event_code || info.transaction_type || '';
    const note = info.transaction_note || '';

    const amountVal = safeGet(info, 'transaction_amount.value', '');
    const amountCur = safeGet(info, 'transaction_amount.currency_code', '');
    const feeVal = safeGet(info, 'fee_amount.value', '');
    const feeCur = safeGet(info, 'fee_amount.currency_code', '');
    const netVal = safeGet(info, 'net_amount.value', '');
    const netCur = safeGet(info, 'net_amount.currency_code', '');

    const payerName = [payer.payer_name?.given_name, payer.payer_name?.surname].filter(Boolean).join(' ').trim();
    const payerEmail = payer.email_address || '';

    const shipName = ship.name || '';
    const shipLine1 = ship.address?.line1 || '';
    const shipCity = ship.address?.city || '';
    const shipCountry = ship.address?.country_code || '';

    return {
        transactionId,
        date,
        status,
        type,
        note,
        amountVal,
        amountCur,
        feeVal,
        feeCur,
        netVal,
        netCur,
        payerName,
        payerEmail,
        shipName,
        shipLine1,
        shipCity,
        shipCountry
    };
}

function toNumberOrZero(x)
{
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
}

function classifyTransaction(tx)
{
    const code = String(tx.type || '').toUpperCase();
    const gross = Number(tx.amountVal);

    // Bank-ish withdrawals (these should NOT be "payments sent")
    const WITHDRAWALS_AND_DEBITS = new Set([
        'T0200', // Withdrawal to bank
        'T0301', // Transfer to bank
        'T0600'  // General debit
    ]);

    // Deposits/credits (topups, refunds, adjustments)
    const DEPOSITS_AND_CREDITS = new Set([
        'T0300', // Add funds from bank
        'T0400', // Refund
        'T0401', // Reversal
        'T0500', // Adjustment
        'T0700'  // General credit
    ]);

    // Buyer payments to you
    const PAYMENTS_RECEIVED = new Set([
        'T0006', // Express Checkout Payment
        'T0013', // Subscription payment
        'T1107', // Mobile payment received
        'T1110'  // POS payment received
    ]);

    // You paying someone (this is what you want in "Payments sent")
    // Include a wider set because accounts vary.
    const PAYMENTS_SENT = new Set([
        'T0001', // Website payment (often used for purchases)
        'T0002', // General payment
        'T0010', // MassPay payment sent
        'T1105', // Mobile payment sent
        'T1106', // Payment sent
        'T1500', // PayPal card purchase / debit-like purchase (varies)
        'T1501'  // Another purchase-like code (varies)
    ]);

    if (PAYMENTS_RECEIVED.has(code)) return 'paymentsReceived';
    if (PAYMENTS_SENT.has(code)) return 'paymentsSent';
    if (DEPOSITS_AND_CREDITS.has(code)) return 'depositsAndCredits';
    if (WITHDRAWALS_AND_DEBITS.has(code)) return 'withdrawalsAndDebits';

    // Fallback:
    // - Unknown positives: treat as deposits/credits (statement usually does this)
    // - Unknown negatives: treat as payments sent UNLESS it looks like a bank transfer/withdrawal
    const typeText = code; // already upper
    const looksLikeWithdrawal =
        typeText.includes('WITHDRAW') ||
        typeText.includes('TRANSFER_TO_BANK') ||
        typeText.includes('BANK') ||
        typeText.includes('PAYOUT');

    if (Number.isFinite(gross) && gross < 0)
    {
        return looksLikeWithdrawal ? 'withdrawalsAndDebits' : 'paymentsSent';
    }

    return 'depositsAndCredits';
}

function ensureCurMap(perCur, cur)
{
    if (!perCur.has(cur))
    {
        perCur.set(cur, {
            paymentsReceived: 0,
            paymentsSent: 0,
            withdrawalsAndDebits: 0,
            depositsAndCredits: 0,
            fees: 0
        });
    }
    return perCur.get(cur);
}

function addSigned(bucket, val)
{
    if (bucket === 'paymentsReceived') return Math.max(0, val);
    if (bucket === 'depositsAndCredits') return Math.max(0, val);
    if (bucket === 'paymentsSent') return Math.min(0, val);
    if (bucket === 'withdrawalsAndDebits') return Math.min(0, val);
    return 0;
}

function buildActivitySummary(normalizedTxs)
{
    const perCur = new Map();

    for (const tx of normalizedTxs)
    {
        const bucket = classifyTransaction(tx);

        // Gross bucketed by transaction_amount currency
        if (tx.amountCur)
        {
            const gross = toNumberOrZero(tx.amountVal);
            const a = ensureCurMap(perCur, tx.amountCur);

            if (bucket === 'paymentsReceived') a.paymentsReceived += addSigned(bucket, gross);
            else if (bucket === 'paymentsSent') a.paymentsSent += addSigned(bucket, gross);
            else if (bucket === 'withdrawalsAndDebits') a.withdrawalsAndDebits += addSigned(bucket, gross);
            else if (bucket === 'depositsAndCredits') a.depositsAndCredits += addSigned(bucket, gross);
        }

        // Fees bucketed by fee currency (can differ)
        if (tx.feeCur)
        {
            const fee = toNumberOrZero(tx.feeVal);
            const a = ensureCurMap(perCur, tx.feeCur);
            if (Number.isFinite(fee) && fee !== 0) a.fees += fee; // PayPal typically returns negative fees
        }
    }

    return perCur;
}


function fmtAmount(n)
{
    const v = Number(n);
    if (!Number.isFinite(v)) return '0.00';
    return v.toFixed(2);
}

function formatMoney(val, cur)
{
    if (val === '' || val === null || val === undefined) return '';
    const n = Number(val);
    if (!Number.isFinite(n)) return `${val} ${cur}`.trim();
    return `${n.toFixed(2)} ${cur}`.trim();
}

function drawBalanceSummary(doc, opts)
{
    const year = opts.year;
    const month = opts.month;
    const balancesStart = opts.balancesStart;
    const balancesEnd = opts.balancesEnd;

    const startArr = extractBalancesArray(balancesStart);
    const endArr = extractBalancesArray(balancesEnd);

    const startAvail = pickAvailableByCurrency(startArr);
    const endAvail = pickAvailableByCurrency(endArr);

    const startWithheld = pickWithheldByCurrency(startArr);
    const endWithheld = pickWithheldByCurrency(endArr);

    const mm = String(month).padStart(2, '0');
    const dd = String(daysInMonthUtc(year, month)).padStart(2, '0');

    doc.fontSize(13).font('Helvetica-Bold').text(`Balance Summary (01/${mm}/${year} - ${dd}/${mm}/${year})`);
    doc.moveDown(0.5);

    const currencies = [...new Set([
        ...startAvail.keys(),
        ...endAvail.keys(),
        ...startWithheld.keys(),
        ...endWithheld.keys()
    ])].sort();

    if (currencies.length === 0)
    {
        doc.fontSize(10).font('Helvetica').text('No balance data returned.');
        doc.moveDown(1);
        return;
    }

    const x0 = doc.x;
    const tableWidth = 520;

    const colCur = 60;
    const colW = (tableWidth - colCur) / 4;

    // Header row (fixed box so columns line up perfectly)
    const headerH = 18;
    const headerY = doc.y;

    doc.save();
    doc.rect(x0, headerY, tableWidth, headerH).fill('#ffffff');
    doc.restore();

    doc.fontSize(10).font('Helvetica-Bold');

    doc.text('', x0, headerY + 4, { width: colCur, align: 'left' });
    doc.text('Available beginning', x0 + colCur, headerY + 4, { width: colW, align: 'right' });
    doc.text('Available ending', x0 + colCur + colW, headerY + 4, { width: colW, align: 'right' });
    doc.text('Withheld beginning', x0 + colCur + colW * 2, headerY + 4, { width: colW, align: 'right' });
    doc.text('Withheld ending', x0 + colCur + colW * 3, headerY + 4, { width: colW, align: 'right' });

    // underline
    doc.moveTo(x0, headerY + headerH).lineTo(x0 + tableWidth, headerY + headerH).stroke();

    // move cursor below header
    doc.y = headerY + headerH + 4;


    // Rows
    doc.fontSize(10).font('Helvetica');

    const rowH = 18;
    for (let i = 0; i < currencies.length; i++)
    {
        const cur = currencies[i];
        const y = doc.y;

        if (i % 2 === 0)
        {
            doc.save();
            doc.rect(x0, y, tableWidth, rowH).fill('#eeeeee');
            doc.restore();
        }

        const ab = startAvail.has(cur) ? fmtAmount(startAvail.get(cur)) : 'N/A';
        const ae = endAvail.has(cur) ? fmtAmount(endAvail.get(cur)) : 'N/A';

        const wb = startWithheld.has(cur) ? fmtAmount(startWithheld.get(cur)) : '0.00';
        const we = endWithheld.has(cur) ? fmtAmount(endWithheld.get(cur)) : '0.00';

        doc.font('Helvetica-Bold').text(cur, x0 + 6, y + 4, { width: colCur - 12, align: 'left' });

        doc.font('Helvetica').text(ab, x0 + colCur, y + 4, { width: colW, align: 'right' });
        doc.text(ae, x0 + colCur + colW, y + 4, { width: colW, align: 'right' });
        doc.text(wb, x0 + colCur + colW * 2, y + 4, { width: colW, align: 'right' });
        doc.text(we, x0 + colCur + colW * 3, y + 4, { width: colW, align: 'right' });

        doc.y = y + rowH;
    }

    doc.moveDown(1);
}

function pickTxnCurrency(tx)
{
    // Prefer gross currency; fallback to net; fallback to fee
    return tx.amountCur || tx.netCur || tx.feeCur || 'UNK';
}

function groupTransactionsByCurrency(normalized)
{
    const map = new Map();
    for (const t of normalized)
    {
        const cur = pickTxnCurrency(t);
        if (!map.has(cur)) map.set(cur, []);
        map.get(cur).push(t);
    }
    // Sort by date (string ISO sorts ok if always ISO)
    for (const arr of map.values())
    {
        arr.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }
    return map;
}

function buildTxnDescription(t)
{
    // Similar to statement: event name + note + ID
    // Many APIs don't give the exact statement "description" text, so we approximate.
    const parts = [];

    if (t.type) parts.push(String(t.type));
    if (t.note) parts.push(String(t.note));

    // Always include ID in its own line
    parts.push(`ID: ${t.transactionId}`);

    return parts.filter(Boolean).join('\n');
}

function drawTransactionHistoryPerCurrency(doc, normalized)
{
    const byCur = groupTransactionsByCurrency(normalized);
    const currencies = [...byCur.keys()].sort();

    for (const cur of currencies)
    {
        doc.addPage();

        doc.fontSize(14).font('Helvetica-Bold').text(`Transaction History - ${cur}`);
        doc.moveDown(0.5);

        // Table layout
        const x0 = doc.x;
        const tableWidth = 520;

        const colDate = 80;
        const colDesc = 210;
        const colName = 150;
        const colGross = 80;
        const colFee = 60;
        const colNet = 60;

        // Header
        const headerY = doc.y;
        doc.fontSize(10).font('Helvetica-Bold');

        doc.text('Date', x0, headerY, { width: colDate });
        doc.text('Description', x0 + colDate, headerY, { width: colDesc });
        doc.text('Name \\ Email', x0 + colDate + colDesc, headerY, { width: colName });
        doc.text('Gross', x0 + colDate + colDesc + colName, headerY, { width: colGross, align: 'right' });
        doc.text('Fee', x0 + colDate + colDesc + colName + colGross, headerY, { width: colFee, align: 'right' });
        doc.text('Net', x0 + colDate + colDesc + colName + colGross + colFee, headerY, { width: colNet, align: 'right' });

        doc.moveDown(0.3);
        doc.moveTo(x0, doc.y).lineTo(x0 + tableWidth, doc.y).stroke();
        doc.moveDown(0.2);

        doc.fontSize(9).font('Helvetica');

        const rows = byCur.get(cur);

        for (let i = 0; i < rows.length; i++)
        {
            const t = rows[i];

            // Build row content
            const dateShort = (t.date || '').slice(0, 10).split('-').reverse().join('/');
            const desc = buildTxnDescription(t);

            const nameEmailParts = [];
            if (t.payerName) nameEmailParts.push(t.payerName);
            if (t.payerEmail) nameEmailParts.push(t.payerEmail);
            const nameEmail = nameEmailParts.join('\n');

            const gross = formatMoney(t.amountVal, t.amountCur);
            const fee = formatMoney(t.feeVal, t.feeCur);
            const net = formatMoney(t.netVal, t.netCur);

            // Estimate row height based on multi-line cells
            const descH = doc.heightOfString(desc, { width: colDesc });
            const nameH = doc.heightOfString(nameEmail || ' ', { width: colName });
            const rowH = Math.max(18, descH, nameH) + 6;

            // Page break if needed (keep header on each new page)
            const bottom = doc.page.height - doc.page.margins.bottom;
            if (doc.y + rowH > bottom)
            {
                doc.addPage();

                doc.fontSize(14).font('Helvetica-Bold').text(`Transaction History - ${cur} (cont.)`);
                doc.moveDown(0.5);

                const hy = doc.y;
                doc.fontSize(10).font('Helvetica-Bold');
                doc.text('Date', x0, hy, { width: colDate });
                doc.text('Description', x0 + colDate, hy, { width: colDesc });
                doc.text('Name \\ Email', x0 + colDate + colDesc, hy, { width: colName });
                doc.text('Gross', x0 + colDate + colDesc + colName, hy, { width: colGross, align: 'right' });
                doc.text('Fee', x0 + colDate + colDesc + colName + colGross, hy, { width: colFee, align: 'right' });
                doc.text('Net', x0 + colDate + colDesc + colName + colGross + colFee, hy, { width: colNet, align: 'right' });

                doc.moveDown(0.3);
                doc.moveTo(x0, doc.y).lineTo(x0 + tableWidth, doc.y).stroke();
                doc.moveDown(0.2);

                doc.fontSize(9).font('Helvetica');
            }

            const y = doc.y;

            // Optional zebra background
            if (i % 2 === 0)
            {
                doc.save();
                doc.rect(x0, y, tableWidth, rowH).fill('#f4f4f4');
                doc.restore();
            }

            doc.fillColor('black');

            doc.text(dateShort, x0 + 4, y + 3, { width: colDate - 8 });
            doc.text(desc, x0 + colDate + 4, y + 3, { width: colDesc - 8 });
            doc.text(nameEmail, x0 + colDate + colDesc + 4, y + 3, { width: colName - 8 });

            doc.text(gross, x0 + colDate + colDesc + colName, y + 3, { width: colGross, align: 'right' });
            doc.text(fee, x0 + colDate + colDesc + colName + colGross, y + 3, { width: colFee, align: 'right' });
            doc.text(net, x0 + colDate + colDesc + colName + colGross + colFee, y + 3, { width: colNet, align: 'right' });

            // Border line under row
            doc.moveTo(x0, y + rowH).lineTo(x0 + tableWidth, y + rowH).strokeColor('#cccccc').stroke();
            doc.strokeColor('black');

            doc.y = y + rowH;
        }
    }
}

function bucketToLabel(bucket)
{
    if (bucket === 'paymentsReceived') return 'Payments received';
    if (bucket === 'paymentsSent') return 'Payments sent';
    if (bucket === 'withdrawalsAndDebits') return 'Withdrawals and Debits';
    if (bucket === 'depositsAndCredits') return 'Deposits and Credits';
    if (bucket === 'fees') return 'Fees';
    return bucket;
}

function statementLikeDescription(t)
{
    // Best-effort: if you later find a better field, swap it here.
    // For now use note if present; otherwise use type code.
    // Example output: "Payment Bill User Payment"
    if (t.note && String(t.note).trim().length > 0) return String(t.note).trim();
    if (t.type && String(t.type).trim().length > 0) return String(t.type).trim();
    return 'Transaction';
}

function buildCategoryBreakdown(normalized)
{
    // Map currency -> Map bucket -> Map description -> amount
    const byCur = new Map();

    for (const t of normalized)
    {
        const cur = pickTxnCurrency(t);
        const bucket = classifyTransaction(t);
        const desc = statementLikeDescription(t);

        const gross = toNumberOrZero(t.amountVal);

        if (!byCur.has(cur)) byCur.set(cur, new Map());
        const byBucket = byCur.get(cur);

        if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
        const byDesc = byBucket.get(bucket);

        byDesc.set(desc, (byDesc.get(desc) || 0) + gross);
    }

    return byCur;
}

function drawCategorySummaryPerCurrency(doc, normalized)
{
    const breakdown = buildCategoryBreakdown(normalized);
    const currencies = [...breakdown.keys()].sort();

    for (const cur of currencies)
    {
        doc.addPage();

        // Page title (force x)
        doc.fontSize(14).font('Helvetica-Bold').text(`Summary - ${cur}`, doc.page.margins.left, doc.y);
        doc.moveDown(0.8);

        const byBucket = breakdown.get(cur);

        const orderedBuckets = [
            'paymentsReceived',
            'paymentsSent',
            'withdrawalsAndDebits',
            'depositsAndCredits',
            'fees'
        ].filter(b => byBucket.has(b));

        for (const bucket of orderedBuckets)
        {
            ensureSpace(doc, 120);
            doc.x = doc.page.margins.left; // reset after possible addPage()

            const byDesc = byBucket.get(bucket);

            let total = 0;
            for (const v of byDesc.values()) total += v;
            if (Math.abs(total) < 0.0001) continue;

            ensureSpace(doc, 120);
            doc.x = doc.page.margins.left;

            const label = bucketToLabel(bucket);

            // Section title (force x)
            doc.fontSize(12).font('Helvetica-Bold').text(label, doc.page.margins.left, doc.y);
            doc.moveDown(0.3);

            const x0 = doc.page.margins.left;
            const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

            // You can tweak this if you want wider Description column:
            const colDesc = 380;
            const colVal = tableWidth - colDesc;

            const headerH = 18;
            const headerY = doc.y;

            // Header background
            doc.save();
            doc.rect(x0, headerY, tableWidth, headerH).fill('#ffffff');
            doc.restore();

            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Description', x0 + 6, headerY + 4, { width: colDesc - 12, align: 'left' });
            doc.text(cur, x0 + colDesc, headerY + 4, { width: colVal, align: 'right' });

            // Header underline
            doc.moveTo(x0, headerY + headerH).lineTo(x0 + tableWidth, headerY + headerH).stroke();
            doc.y = headerY + headerH;

            const entries = [...byDesc.entries()]
                .filter(([, v]) => Math.abs(v) > 0.0001)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

            const rowH = 18;

            doc.fontSize(10).font('Helvetica');

            for (let i = 0; i < entries.length; i++)
            {
                ensureSpace(doc, rowH + 6);
                doc.x = doc.page.margins.left; // reset after possible addPage()

                const [desc, val] = entries[i];
                const y = doc.y;

                if (i % 2 === 0)
                {
                    doc.save();
                    doc.rect(x0, y, tableWidth, rowH).fill('#eaf2ff');
                    doc.restore();
                }

                doc.fillColor('black');
                doc.text(desc, x0 + 6, y + 4, { width: colDesc - 12, align: 'left' });
                doc.text(fmtAmount(val), x0 + colDesc, y + 4, { width: colVal, align: 'right' });

                doc.moveTo(x0, y + rowH).lineTo(x0 + tableWidth, y + rowH).strokeColor('#cccccc').stroke();
                doc.strokeColor('black');

                doc.y = y + rowH;
            }

            // Total row
            ensureSpace(doc, rowH + 6);
            doc.x = doc.page.margins.left;

            const ty = doc.y;

            doc.save();
            doc.rect(x0, ty, tableWidth, rowH).fill('#ffffff');
            doc.restore();

            doc.fontSize(10).font('Helvetica-Bold');
            doc.text('Total', x0 + 6, ty + 4, { width: colDesc - 12, align: 'left' });
            doc.text(fmtAmount(total), x0 + colDesc, ty + 4, { width: colVal, align: 'right' });

            doc.moveTo(x0, ty + rowH).lineTo(x0 + tableWidth, ty + rowH).stroke();

            doc.y = ty + rowH + 10;
        }
    }
}


function drawActivitySummary(doc, opts)
{
    const year = opts.year;
    const month = opts.month;
    const startIso = opts.startIso;
    const endIso = opts.endIso;
    const normalized = opts.normalized;
    const balancesStart = opts.balancesStart;
    const balancesEnd = opts.balancesEnd;

    const perCur = buildActivitySummary(normalized);

    const startBalArr = extractBalancesArray(balancesStart);
    const endBalArr = extractBalancesArray(balancesEnd);

    const startAvail = pickAvailableByCurrency(startBalArr);
    const endAvail = pickAvailableByCurrency(endBalArr);

    const mm = String(month).padStart(2, '0');
    const dd = String(daysInMonthUtc(year, month)).padStart(2, '0');

    doc.fontSize(12).font('Helvetica-Bold');
    doc.text(`Activity Summary (01/${mm}/${year} - ${dd}/${mm}/${year})`);
    doc.moveDown(0.5);

    const currencies = [...new Set([...perCur.keys(), ...startAvail.keys(), ...endAvail.keys()])].sort();
    if (currencies.length === 0)
    {
        doc.fontSize(10).font('Helvetica').text('No data.');
        doc.moveDown(1);
        return;
    }

    for (const cur of currencies)
    {
        if (doc.y > 120) doc.addPage();
        const a = perCur.get(cur) || {
            paymentsReceived: 0,
            paymentsSent: 0,
            withdrawalsAndDebits: 0,
            depositsAndCredits: 0,
            fees: 0
        };

        const begin = startAvail.has(cur) ? startAvail.get(cur) : null;
        const end = endAvail.has(cur) ? endAvail.get(cur) : null;

        const x0 = doc.x;
        const tableWidth = 520;
        const labelW = 380;
        const valW = tableWidth - labelW;

        doc.fontSize(10).font('Helvetica-Bold').text(cur, x0 + labelW, doc.y, { width: valW, align: 'right' });
        doc.moveDown(0.3);

        const rows = [
            ['Beginning Available Balance', begin === null ? 'N/A' : fmtAmount(begin)],
            ['Payments received', fmtAmount(a.paymentsReceived)],
            ['Payments sent', fmtAmount(a.paymentsSent)],
            ['Withdrawals and Debits', fmtAmount(a.withdrawalsAndDebits)],
            ['Deposits and Credits', fmtAmount(a.depositsAndCredits)],
            ['Fees', fmtAmount(a.fees)],
            ['Ending Available Balance', end === null ? 'N/A' : fmtAmount(end)]
        ];

        const rowH = 18;
        for (let i = 0; i < rows.length; i++)
        {
            const y = doc.y;

            if (i % 2 === 0)
            {
                doc.save();
                doc.rect(x0, y, tableWidth, rowH).fill('#eeeeee');
                doc.restore();
            }

            doc.fontSize(10).font(i === 0 || i === rows.length - 1 ? 'Helvetica-Bold' : 'Helvetica');
            doc.fillColor('black');

            doc.text(rows[i][0], x0 + 6, y + 4, { width: labelW - 12, align: 'left' });
            doc.text(rows[i][1], x0 + labelW, y + 4, { width: valW, align: 'right' });

            doc.y = y + rowH;
        }

        doc.moveDown(0.8);
    }

    doc.fontSize(8).font('Helvetica').fillColor('gray');
    doc.text(`Balances fetched as of: start=${startIso} end=${endIso} (UTC)`);
    doc.fillColor('black');
    doc.moveDown(1);
}

function ensureSpace(doc, neededHeight)
{
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededHeight > bottom) doc.addPage();
}



function generatePdfReport({ year, month, startIso, endIso, transactions, balancesStart, balancesEnd, outputPath })
{
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(fs.createWriteStream(outputPath));

    // print company details few lines
    //Kelobyte Oy
    //Kosulansaarentie, 69
    //83940 nunnanlahti

    doc.text("Kelobyte Oy");
    doc.text("Kosulansaarentie, 69");
    doc.text("83940 nunnanlahti");
    doc.moveDown(2);

    doc.fontSize(18).font('Helvetica-Bold').text('PayPal Monthly Report');
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    doc.text(`Period: ${year}-${String(month).padStart(2, '0')}  (UTC range ${startIso} to ${endIso})`);
    doc.moveDown(1);

    const normalized = transactions.map(t => normalizeTransaction(t.transaction_details || t));
    const count = normalized.length;

    drawBalanceSummary(doc, {
        year,
        month,
        balancesStart,
        balancesEnd
    });

    drawActivitySummary(doc, {
        year,
        month,
        startIso,
        endIso,
        normalized,
        balancesStart,
        balancesEnd
    });

    drawTransactionHistoryPerCurrency(doc, normalized);

    drawCategorySummaryPerCurrency(doc, normalized);
    doc.end();
}

async function main()
{
    assertEnv();

    const { start, end } = monthRangeUtc(REPORT_YEAR, REPORT_MONTH);
    const startIso = toIsoUtc(start);
    const endIso = toIsoUtc(end);

    const token = await paypalAccessToken();

    const transactions = await fetchAllTransactions(token, startIso, endIso);
    const balancesStart = await fetchBalancesAsOf(token, startIso);
    const balancesEnd = await fetchBalancesAsOf(token, endIso);

    generatePdfReport({
        year: REPORT_YEAR,
        month: REPORT_MONTH,
        startIso,
        endIso,
        transactions,
        balancesStart,
        balancesEnd,
        outputPath: OUTPUT_PDF
    });

    console.log(`Wrote ${OUTPUT_PDF}`);
    console.log(`Transactions: ${transactions.length}`);

    if (balancesEnd.ok) console.log('Balances: OK');
    else console.log(`Balances: not available (HTTP ${balancesEnd.status})`);
}

main().catch(err =>
{
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
