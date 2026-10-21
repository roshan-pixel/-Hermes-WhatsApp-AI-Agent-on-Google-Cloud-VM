// Payment slip <-> invoice reconciliation for watched members (pure functions, no I/O).
// OCR splits an invoice table into separate columns (a DS id + name list and an amount list), so the invoice amounts
// are picked, in order, as the numbers whose sum equals the total paid, and paired with the DS ids in the same order.
// Handles any number of invoices and payment slips (e.g. 4 invoices + 1 slip, or 2 slips for 2 different ids).

const lines = (t) => String(t || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const money = (l) => {
    // OCR reads the ₹ sign as ★, =, %, * and similar, so drop any leading symbols
    const m = String(l).replace(/\s/g, '').replace(/^[^0-9A-Za-z]+/, '').match(/^(?:rs\.?|inr)?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{2}|\d{3,7})$/i);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
};
// OCR also reads the ₹ sign as a leading 7 or Z ("₹6,844.64" -> "76,844.64"): the value without it, tried only when needed
const moneyAlt = (l) => {
    const s = String(l).replace(/\s/g, '').replace(/^[^0-9A-Za-z]+/, '');
    return /^[7Zz]\d/.test(s) ? money(s.slice(1)) : null;
};
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const title = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SLIP_RE = /upi transaction|upi ref|\butr\b|google transaction|transaction id|txn id|pay again|paid to|payment successful|\bcompleted\b|\bsuccessful\b/i;
const INVOICE_RE = /tax invoice|\binvoice\b|gstin|\bhsn\b|bill no/i;
const isSlip = (ocr) => SLIP_RE.test(ocr) && !INVOICE_RE.test(ocr);

function parseSlip(ocr, file) {
    const L = lines(ocr);
    const after = (re) => {
        const i = L.findIndex(l => re.test(l));
        if (i < 0) return '';
        const same = L[i].replace(re, '').replace(/^[\s:#.-]+/, '').trim();
        return same || L[i + 1] || '';
    };
    const upiLine = after(/upi transaction id|upi ref(erence)?\s*(no|id)?|\butr(\s*no)?\b/i);
    const amtLine = L.find(l => money(l) !== null || moneyAlt(l) !== null);
    return {
        file,
        amount: amtLine ? (money(amtLine) ?? moneyAlt(amtLine)) : null,
        amountAlt: amtLine && money(amtLine) !== null ? moneyAlt(amtLine) : null,
        status: title((ocr.match(/\b(completed|successful|success|failed|pending)\b/i) || [])[1] || ''),
        date: ((ocr.match(/\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4},?\s*\d{1,2}:\d{2}\s*[ap]m/i) || ocr.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:,?\s*\d{1,2}:\d{2}\s*([ap]m)?)?/i) || [])[0] || '').trim(),
        from: after(/^from\b\s*:?/i),
        to: after(/^to\b\s*:?/i),
        upi: (upiLine.match(/\d{10,16}/) || ocr.match(/\b\d{12}\b/) || [])[0] || '',
        txn: after(/google transaction id|phonepe transaction id|^transaction id|txn id/i),
        bank: L.find(l => /\bbank\b.*\d{4}\s*$/i.test(l) && !/^from\b/i.test(l)) || '',
        toUpi: (L.find(l => /@[a-z]+$/i.test(l) && !/^from\b|on google pay|okaxis|cy-\d/i.test(l)) || '').replace(/^to\s*:?\s*/i, '').replace(/^\.+/, '••••••'),
        app: /google pay|gpay/i.test(ocr) ? 'Google Pay' : /phonepe/i.test(ocr) ? 'PhonePe' : /paytm/i.test(ocr) ? 'Paytm' : /bhim/i.test(ocr) ? 'BHIM' : ''
    };
}

function parseInvoiceLines(parts) {
    const ids = [], nums = [], alts = [];
    for (const l of parts.flatMap(p => lines(p.ocr))) {
        const labelled = l.match(/\bds\s*(?:id|code|no)\b\s*[:#-]?\s*([A-Z0-9 ]{5,14})$/i);
        const compact = (labelled ? labelled[1] : l).replace(/\s+/g, '');
        if (labelled || (/^[0-9A-Z]{8,10}$/i.test(compact) && /\d/.test(compact) && /[A-Z]/i.test(compact) && money(l) === null)) {
            // DS ids are hex (0-9, A-F): OCR reads 0 as O
            ids.push({ id: compact.toUpperCase().replace(/O/g, '0'), name: [] });
            continue;
        }
        const v = money(l), a = moneyAlt(l);
        if (v !== null || a !== null) { nums.push(v ?? a); alts.push(v !== null ? a : null); continue; }
        if (ids.length && /^[A-Z][A-Z .'-]+$/i.test(l) && l.replace(/[^A-Z]/gi, '').length > 1) ids[ids.length - 1].name.push(l);
    }
    return { ids, nums, alts };
}

// Choose n numbers (keeping their order) whose sum is closest to target
function pickAmounts(nums, n, target) {
    if (!n || nums.length < n || nums.length > 30) return null;
    let best = null;
    (function pick(start, chosen, sum) {
        if (best && Math.abs(best.sum - target) < 0.01) return;
        if (chosen.length === n) { if (!best || Math.abs(sum - target) < Math.abs(best.sum - target)) best = { idx: chosen.slice(), sum }; return; }
        for (let i = start; i <= nums.length - (n - chosen.length); i++) { chosen.push(i); pick(i + 1, chosen, sum + nums[i]); chosen.pop(); }
    })(0, [], 0);
    return best;
}

// Split the invoices between the slips so every slip's amount is covered exactly (under ₹1)
function allocate(slips, amounts) {
    if (slips.length < 2 || amounts.length > 12 || slips.length > 4) return null;
    const owner = new Array(amounts.length);
    const left = slips.map(s => s.amount);
    return (function place(i) {
        if (i === amounts.length) return left.every(x => Math.abs(x) < 1) ? slips.map((_, s) => owner.map((o, k) => o === s ? k : -1).filter(k => k >= 0)) : null;
        for (let s = 0; s < slips.length; s++) {
            if (left[s] - amounts[i] < -1) continue;
            owner[i] = s; left[s] -= amounts[i];
            const r = place(i + 1);
            left[s] += amounts[i];
            if (r) return r;
        }
        return null;
    })(0);
}

function reconcile(parts) {
    const slipParts = parts.filter(p => isSlip(p.ocr));
    const slips = slipParts.map(p => parseSlip(p.ocr, p.filename)).filter(s => s.amount);
    const { ids, nums, alts } = parseInvoiceLines(parts.filter(p => !slipParts.includes(p)));
    if (!slips.length && !ids.length) return null;

    // Try the plain reading first; if it does not match, retry with the fewest "₹ read as 7/Z" corrections
    const flips = [...slips.map((s, i) => s.amountAlt !== null ? { slip: i, v: s.amountAlt } : null), ...alts.map((a, i) => a !== null ? { num: i, v: a } : null)].filter(Boolean).slice(0, 8);
    const combos = [...Array(1 << flips.length).keys()].sort((a, b) => bits(a) - bits(b));
    let first = null;
    for (const mask of combos) {
        const S = slips.map(s => ({ ...s }));
        const N = nums.slice();
        flips.forEach((f, b) => { if (mask & (1 << b)) { if (f.slip !== undefined) S[f.slip].amount = f.v; else N[f.num] = f.v; } });
        const r = match(S, ids, N);
        if (!first) first = r;
        if (r.status === 'MATCHED') return r;
    }
    return first;
}
const bits = (x) => { let c = 0; for (; x; x >>= 1) c += x & 1; return c; };

function match(slips, ids, nums) {
    const paid = slips.reduce((a, s) => a + s.amount, 0);
    const n = ids.length;
    // The table layout wins when it adds up (one amount per invoice, or amount + one other value such as PV);
    // otherwise search for the amounts whose sum equals the payment; otherwise show the layout as a MISMATCH
    const sumOf = (ix) => ix.reduce((a, i) => a + nums[i], 0);
    const layouts = n ? [nums.length === 2 * n && ids.map((_, i) => 2 * i), nums.length === n && nums.map((_, i) => i)].filter(Boolean) : [];
    let idx = slips.length ? layouts.find(ix => Math.abs(sumOf(ix) - paid) < 1) || null : null;
    const best = !idx && n && slips.length ? pickAmounts(nums, n, paid) : null;
    if (!idx && best && Math.abs(best.sum - paid) < 1) idx = best.idx;
    if (!idx) idx = layouts[0] || (best && best.idx) || null;

    const invoices = ids.map((x, k) => {
        const i = idx ? idx[k] : -1;
        const next = idx && idx[k + 1] !== undefined ? idx[k + 1] : nums.length;
        return { id: x.id, name: title(x.name.join(' ')), amount: i >= 0 ? nums[i] : null, extra: i >= 0 ? nums.slice(i + 1, next) : [] };
    });
    const total = invoices.reduce((a, v) => a + (v.amount || 0), 0);
    const diff = Math.round((paid - total) * 100) / 100;
    const status = !slips.length ? 'NO SLIP' : !n ? 'NO INVOICE' : !idx ? 'UNCLEAR' : Math.abs(diff) < 1 ? 'MATCHED' : 'MISMATCH';
    const split = status === 'MATCHED' ? allocate(slips, invoices.map(v => v.amount)) : null;
    if (slips.length === 1 && status === 'MATCHED') slips[0].covers = invoices.map((_, k) => k);
    if (split) split.forEach((ks, s) => { slips[s].covers = ks; });
    return { slips, invoices, paid, total, diff, status };
}

const ICON = { MATCHED: '✅', MISMATCH: '❌', 'NO SLIP': '⚠️', 'NO INVOICE': '⚠️', UNCLEAR: '⚠️' };
const STATUS_NOTE = {
    MATCHED: 'Payment matches the invoices.',
    MISMATCH: 'Payment does NOT match the invoice total. Please check.',
    'NO SLIP': 'No payment slip found in these files.',
    'NO INVOICE': 'No invoice (DS id) found in these files.',
    UNCLEAR: 'Could not read the invoice amounts clearly. Please check the attached images.'
};

function whatsappText(r, who) {
    const out = [`🧾 *Payment check — ${who}*`, `${ICON[r.status]} *${r.status}* · ${STATUS_NOTE[r.status]}`, ''];
    if (r.slips.length) {
        out.push(`💰 Paid *${inr(r.paid)}*${r.invoices.length ? ` · Invoices *${inr(r.total)}*` : ''}${r.slips.length && r.invoices.length && r.status !== 'UNCLEAR' ? ` · ${r.status === 'MISMATCH' ? (r.diff < 0 ? 'Short by' : 'Extra paid') : 'Diff'} ${inr(Math.abs(r.diff))}` : ''}`, '');
    }
    r.slips.forEach((s, i) => {
        out.push(`💳 *Payment ${r.slips.length > 1 ? i + 1 : 'slip'}* — *${inr(s.amount)}*`);
        const meta = [s.status, s.app, s.date].filter(Boolean).join(' · ');
        if (meta) out.push(meta);
        if (s.from) out.push(`From: ${s.from}`);
        if (s.to) out.push(`To: ${s.to}`);
        if (s.upi) out.push(`UPI ref: ${s.upi}`);
        if (s.txn) out.push(`Txn ID: ${s.txn}`);
        if (s.covers) out.push(`Covers: invoice${s.covers.length > 1 ? 's' : ''} ${s.covers.map(k => k + 1).join(', ')}`);
        out.push('');
    });
    if (r.invoices.length) {
        out.push(`📄 *Invoices (${r.invoices.length})*`);
        r.invoices.forEach((v, k) => {
            out.push(`${k + 1}. *${v.id}* · ${v.name || 'name unclear'}`);
            out.push(`    ${v.amount !== null ? `*${inr(v.amount)}*` : 'amount unclear'}${v.extra.length ? ` · other: ${v.extra.map(x => x.toFixed(2)).join(', ')}` : ''}`);
        });
        if (r.invoices.every(v => v.amount !== null)) out.push('', `➕ ${r.invoices.map(v => inr(v.amount)).join(' + ')} = *${inr(r.total)}*`);
    }
    return out.join('\n').trim();
}

function emailHtml(r, who, meta) {
    const color = r.status === 'MATCHED' ? '#0f7b3f' : r.status === 'MISMATCH' ? '#b42318' : '#b54708';
    const bg = r.status === 'MATCHED' ? '#e7f6ec' : r.status === 'MISMATCH' ? '#fdecea' : '#fff4e5';
    const th = 'style="text-align:left;padding:8px 10px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151;text-transform:uppercase;letter-spacing:.03em"';
    const td = 'style="padding:8px 10px;border-bottom:1px solid #eef0f2;font-size:14px;color:#111827;vertical-align:top"';
    const tdr = 'style="padding:8px 10px;border-bottom:1px solid #eef0f2;font-size:14px;color:#111827;text-align:right;white-space:nowrap"';
    const slipRows = r.slips.map((s, i) => `<tr><td ${td}>${i + 1}</td><td ${tdr}><b>${inr(s.amount)}</b></td><td ${td}>${esc([s.status, s.app].filter(Boolean).join(' · '))}<br><span style="color:#6b7280">${esc(s.date)}</span></td><td ${td}>${esc(s.from)}<br><span style="color:#6b7280">to ${esc(s.to)}</span></td><td ${td}>UPI: ${esc(s.upi || '-')}<br><span style="color:#6b7280">Txn: ${esc(s.txn || '-')}</span></td><td ${td}>${s.covers ? s.covers.map(k => k + 1).join(', ') : '-'}</td></tr>`).join('');
    const invRows = r.invoices.map((v, k) => `<tr><td ${td}>${k + 1}</td><td ${td}><b>${esc(v.id)}</b></td><td ${td}>${esc(v.name || 'unclear')}</td><td ${tdr}><b>${v.amount !== null ? inr(v.amount) : 'unclear'}</b></td><td ${td}>${v.extra.map(x => x.toFixed(2)).join(', ') || '-'}</td></tr>`).join('');
    const table = (head, rows) => `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;margin:6px 0 18px">${head}${rows}</table>`;
    return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:0 auto;color:#111827">
<h2 style="margin:0 0 4px;font-size:20px">Payment check — ${esc(who)}</h2>
<div style="color:#6b7280;font-size:13px;margin-bottom:14px">Received ${esc(meta.received)} IST · ${meta.files} file(s) attached</div>
<div style="background:${bg};color:${color};border-radius:8px;padding:12px 14px;font-size:15px;margin-bottom:16px"><b>${ICON[r.status]} ${r.status}</b> — ${STATUS_NOTE[r.status]}</div>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;font-size:14px">
<tr><td style="padding:3px 18px 3px 0;color:#6b7280">Total paid</td><td style="padding:3px 0"><b>${inr(r.paid)}</b> (${r.slips.length} slip${r.slips.length === 1 ? '' : 's'})</td></tr>
<tr><td style="padding:3px 18px 3px 0;color:#6b7280">Invoice total</td><td style="padding:3px 0"><b>${r.invoices.length ? inr(r.total) : '-'}</b> (${r.invoices.length} invoice${r.invoices.length === 1 ? '' : 's'})</td></tr>
<tr><td style="padding:3px 18px 3px 0;color:#6b7280">Difference</td><td style="padding:3px 0;color:${color}"><b>${r.slips.length && r.invoices.length ? inr(Math.abs(r.diff)) : '-'}</b></td></tr>
</table>
${r.slips.length ? `<h3 style="font-size:15px;margin:0">Payment slips</h3>${table(`<tr><th ${th}>#</th><th ${th}>Amount</th><th ${th}>Status / date</th><th ${th}>From / to</th><th ${th}>References</th><th ${th}>Covers invoice</th></tr>`, slipRows)}` : ''}
${r.invoices.length ? `<h3 style="font-size:15px;margin:0">Invoices</h3>${table(`<tr><th ${th}>#</th><th ${th}>DS id</th><th ${th}>Name</th><th ${th}>Amount</th><th ${th}>Other values</th></tr>`, invRows + `<tr><td ${td} colspan="3"><b>Total</b></td><td ${tdr}><b>${inr(r.total)}</b></td><td ${td}></td></tr>`)}` : ''}
${meta.ledger ? `<h3 style="font-size:15px;margin:0 0 6px">Live ledger</h3><div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;font-size:14px;white-space:pre-wrap;margin-bottom:18px">${esc(meta.ledger)}</div>` : ''}
${meta.text ? `<h3 style="font-size:15px;margin:0 0 6px">Message</h3><div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;font-size:14px;white-space:pre-wrap;margin-bottom:18px">${esc(meta.text)}</div>` : ''}
<div style="color:#9ca3af;font-size:12px;border-top:1px solid #e5e7eb;padding-top:10px">Read automatically by Hermes from the attached images. The raw OCR text is attached as ocr-text.txt. Please verify amounts against the original slips.</div>
</div>`;
}

module.exports = { reconcile, whatsappText, emailHtml, inr };
