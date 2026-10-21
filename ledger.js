// Writes the payment details into the live ledger's invoice remarks (ledger-web-app, /invoice_history),
// in the same format the owner uses by hand. An existing remark is replaced (old text saved to data/ledger-remark-backup.jsonl).
const { inr } = require('./billing');

const LEDGER_URL = (process.env.LEDGER_URL || 'https://ledger-web-app.onrender.com').replace(/\/+$/, '');
const num = (n) => Number(n).toFixed(2);
const AUTO_SIGN = '✅ Auto-updated via WhatsApp (Hermes)';   // the ledger page matches "Auto-updated via WhatsApp"
const withoutSign = (t) => String(t || '').replace(/\s*✅ Auto-updated via WhatsApp[^\n]*$/, '').trim();
const fs = require('fs');
const path = require('path');
const BACKUP_FILE = path.join(__dirname, 'data', 'ledger-remark-backup.jsonl');
function backup(row, oldRemark, newRemark) {
    try {
        fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
        fs.appendFileSync(BACKUP_FILE, JSON.stringify({ at: new Date().toISOString(), id: row.id, invoice_no: row.invoice_no, old: oldRemark, new: newRemark }) + '\n');
    } catch (_) { /* backup is best effort */ }
}

async function fetchJson(url, opts = {}) {
    const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(120000) });   // free hosting can take a while to wake up
    if (!resp.ok) throw new Error(`${opts.method || 'GET'} ${url.replace(LEDGER_URL, '')} -> HTTP ${resp.status}`);
    return resp.json();
}

function slipRemark(s) {
    return [
        s.to && `Recipient: ${s.to}`,
        `Amount: ${inr(s.amount).replace(/\.00$/, '')}`,
        s.status && `Status: ${s.status}`,
        s.date && `Date & Time: ${s.date}`,
        s.bank && `Debited From: ${s.bank}`,
        s.upi && `UPI Transaction ID: ${s.upi}`,
        s.toUpi && `To (UPI ID): ${s.toUpi}`
    ].filter(Boolean).join('   ');
}

// Find the ledger invoice for each matched invoice: same DS code and amount (within ₹1), newest first
function findInvoice(list, v, used) {
    const cands = list.filter(r => !used.has(r.id) && r.status !== 'cancelled' && Math.abs(Number(r.amount) - v.amount) < 1);
    return cands.find(r => String(r.ds_code || '').toUpperCase().replace(/O/g, '0') === v.id) || null;
}

// r = billing.reconcile() result. Returns { updated: [...], skipped: [...], missing: [...] } or { error }
async function updateRemarks(r) {
    if (!r || r.status !== 'MATCHED' || !r.slips.length) return { skippedAll: `not updated (${r ? r.status : 'no data'})` };
    const out = { updated: [], skipped: [], missing: [] };
    try {
        const list = (await fetchJson(`${LEDGER_URL}/api/invoice/list`)).invoices || [];
        const used = new Set();
        const found = r.invoices.map(v => { const row = findInvoice(list, v, used); if (row) used.add(row.id); return row; });
        for (const s of r.slips) {
            const ks = s.covers || [];
            const rows = ks.map(k => ({ v: r.invoices[k], row: found[k] }));
            const dist = rows.length > 1
                ? `\n\nWAS DISTRIBUTED BETWEEN:\n${rows.map(({ v, row }, i) => `${i + 1} ${(row && row.customer_name) || v.name.toUpperCase()}: ${num(v.amount)}${row ? ` (${String(row.invoice_no).replace(/\/\d{2}-\d{2}\*?$/, '')})` : ''}`).join('\n')}\nTotal: ${num(rows.reduce((a, x) => a + x.v.amount, 0))} (${rows.length} People)`
                : '';
            // The sign line makes the ledger page show this remark in a yellow "✅ WA" box
            const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
            const remark = `${slipRemark(s)}${dist}\n\n${AUTO_SIGN} · ${when} IST`;
            for (const { v, row } of rows) {
                if (!row) { out.missing.push(`${v.id} ${inr(v.amount)}`); continue; }
                const cur = String(row.remark || '').trim();
                if (withoutSign(cur) === withoutSign(remark)) { out.skipped.push(`${row.invoice_no} (same remark already)`); continue; }
                // The owner wants the transaction remark always replaced; the old text is kept in a local backup file
                if (cur) backup(row, cur, remark);
                await fetchJson(`${LEDGER_URL}/api/invoice/update/${row.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remark }) });
                out.updated.push(`${row.invoice_no}${cur ? ' (replaced)' : ''}`);
            }
        }
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

function ledgerLine(res) {
    if (!res) return '';
    if (res.skippedAll) return `📒 *Ledger*: ${res.skippedAll}`;
    const bits = [];
    if (res.updated.length) bits.push(`✅ remark added to ${res.updated.length}: ${res.updated.join(', ')}`);
    if (res.skipped.length) bits.push(`↩️ skipped ${res.skipped.length}: ${res.skipped.join(', ')}`);
    if (res.missing.length) bits.push(`⚠️ not found in ledger: ${res.missing.join(', ')}`);
    if (res.error) bits.push(`❌ error: ${res.error}`);
    return `📒 *Ledger*\n${bits.join('\n') || 'nothing to update'}`;
}

module.exports = { updateRemarks, ledgerLine, slipRemark };
