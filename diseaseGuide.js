// Disease guide: maps a medical report (or a stated condition) to the Asclepius product guide in
// data/disease_guide.json (exported from ledger_web/static/master_review_data_perfected.json).
const fs = require('fs');
const path = require('path');

const GUIDE_PATH = process.env.DISEASE_GUIDE_PATH || path.join(__dirname, 'data', 'disease_guide.json');
let guide = [];
try {
    guide = JSON.parse(fs.readFileSync(GUIDE_PATH, 'utf8'));
    console.log(`[DISEASE GUIDE] Loaded ${guide.length} conditions.`);
} catch (e) {
    console.warn('[DISEASE GUIDE] Could not load guide data:', e.message);
}

const REPORT_TERMS = /\b(hb|hemoglobin|haemoglobin|wbc|rbc|platelets?|hba1c|glucose|fasting|postprandial|cholesterol|triglycerides?|hdl|ldl|vldl|creatinine|urea|egfr|uric acid|bilirubin|sgpt|sgot|alt|ast|alkaline phosphatase|tsh|t3|t4|vitamin d|vitamin b12|esr|crp|ferritin|psa|mg\/dl|g\/dl|mmol\/l|iu\/ml|reference range|normal range|pathology|laborator(?:y|ies)|lab report|specimen|impression|ecg|echo|ultrasound|usg|biopsy|blood pressure|haematology|hematology|biochemistry|ct|mri|x-?ray|radiology|radiologist|scan|contrast|sonography|mammography|histopathology|cytology|patient|specimen|investigations?|findings|diagnosis|hepatomegaly|splenomegaly|cardiomegaly|lesion|bmi|spo2|pulse|haemoglobin|neutrophils|lymphocytes|eosinophils|mcv|mch|mchc|pcv|hct)\b/gi;

function looksLikeMedicalReport(text) {
    const found = new Set((String(text || '').match(REPORT_TERMS) || []).map(t => t.toLowerCase()));
    return found.size >= 3;
}

// Condition lookups that work even when the language model is unavailable
const LAB_RULES = [
    [/\b(hba1c|fasting (?:blood )?(?:sugar|glucose)|postprandial|blood sugar|random glucose)\b/i, /type 2 diabetes/i],
    [/\b(ldl|cholesterol|triglycerides?|vldl)\b/i, /dyslipidemia/i],
    [/\b(tsh|thyroid)\b/i, /hypothyroidism/i],
    [/\b(hemoglobin|haemoglobin|hb|ferritin|mcv)\b/i, /anemia|anaemia/i],
    [/\b(creatinine|egfr|urea|bun)\b/i, /kidney/i],
    [/\b(sgpt|sgot|alt|ast|bilirubin|ggt)\b/i, /liver|hepat|fatty/i],
    [/\buric acid\b/i, /gout/i],
    [/\b(blood pressure|bp)\b/i, /hypertension/i],
    [/\bvitamin d\b/i, /osteo|vitamin d/i]
];

function norm(s) { return String(s || '').toLowerCase(); }

function searchByText(text, max = 3) {
    const t = norm(text);
    const scored = guide.map(d => {
        let score = 0;
        const name = norm(d.name).replace(/\(.*?\)/g, '').trim();
        if (name && t.includes(name)) score += 6;
        for (const abbr of (d.name.match(/\(([A-Za-z0-9\- ]{2,10})\)/g) || [])) {
            const a = abbr.slice(1, -1).toLowerCase();
            if (new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) score += 4;
        }
        for (const tag of norm(d.tags).split(',').map(x => x.trim()).filter(x => x.length > 3)) {
            if (t.includes(tag)) score += 2;
        }
        for (const sym of (d.symptoms || []).map(norm)) {
            if (sym.length > 6 && t.includes(sym)) score += 1;
        }
        return { d, score };
    }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score).map(x => x.d);

    for (const [labRe, nameRe] of LAB_RULES) {
        if (labRe.test(text)) {
            const hit = guide.find(d => nameRe.test(d.name));
            if (hit && !scored.includes(hit)) scored.push(hit);
        }
    }
    return scored.slice(0, max);
}

// One line per condition so a language model can pick the relevant ones from a lab report
function catalogText() {
    return guide.map(d => `${d.id}|${d.name}`).join('\n');
}

function getDisease(id) {
    return guide.find(d => d.id === Number(id)) || null;
}

function uniqueLimited(lists, limit) {
    const seen = new Set();
    const out = [];
    for (const item of lists.flat()) {
        const key = norm(item).replace(/[^a-z0-9]/g, '').slice(0, 60);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(String(item).trim());
        if (out.length >= limit) break;
    }
    return out;
}

// Best product combination across the selected conditions: products shared by several conditions rank first
function bestCombination(diseases, maxProducts = 4) {
    const byProduct = new Map();
    diseases.forEach((d, dIdx) => {
        (d.products || []).forEach((p, pIdx) => {
            if (!p.product) return;
            const key = p.product.toUpperCase();
            if (!byProduct.has(key)) byProduct.set(key, { product: p.product, dosage: p.dosage, ingredients: p.ingredients, for: [], rationales: [], firstRank: dIdx * 10 + pIdx });
            const e = byProduct.get(key);
            e.for.push(d.name);
            if (p.rationale) e.rationales.push(p.rationale);
        });
    });
    return [...byProduct.values()]
        .sort((a, b) => (b.for.length - a.for.length) || (a.firstRank - b.firstRank))
        .slice(0, maxProducts);
}

function guideContext(diseases) {
    const combo = bestCombination(diseases);
    const lines = [];
    lines.push('CONDITIONS MATCHED IN THE GUIDE:');
    diseases.forEach(d => lines.push(`• ${d.name} (${d.category}) - ${d.simple}. ${d.about}`));
    lines.push('\nBEST PRODUCT COMBINATION (use ONLY these, with the exact dosage):');
    combo.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.product} - dosage: ${p.dosage || 'as per product label'}${p.ingredients ? ` | key ingredients: ${p.ingredients}` : ''} | supports: ${p.for.join(', ')}${p.rationales[0] ? ` | why: ${p.rationales[0]}` : ''}`);
    });
    const dos = [...uniqueLimited(diseases.map(d => d.diet || []), 7), ...uniqueLimited(diseases.map(d => d.exercise || []), 4)];
    lines.push('\nDO (diet, exercise, lifestyle):');
    dos.forEach(x => lines.push(`- ${x}`));
    const tips = uniqueLimited(diseases.map(d => d.tip ? [d.tip] : []), 3);
    tips.forEach(x => lines.push(`- Ayurvedic tip: ${x}`));
    lines.push('\nDON\'T (things to avoid):');
    uniqueLimited(diseases.map(d => d.avoid || []), 10).forEach(x => lines.push(`- ${x}`));
    const how = uniqueLimited(diseases.map(d => d.how_to_take ? [d.how_to_take] : []), 1);
    if (how.length) lines.push(`\nHOW TO TAKE: ${how[0]}`);
    const disc = uniqueLimited(diseases.map(d => d.disclaimer ? [d.disclaimer] : []), 3);
    if (disc.length) lines.push(`\nGUIDE DISCLAIMERS: ${disc.join(' | ')}`);
    return lines.join('\n');
}

module.exports = { looksLikeMedicalReport, searchByText, catalogText, getDisease, bestCombination, guideContext, count: () => guide.length };
