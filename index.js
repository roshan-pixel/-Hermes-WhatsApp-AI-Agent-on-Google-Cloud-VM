require('dotenv').config();
delete process.env.DBUS_SESSION_BUS_ADDRESS;
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { queryChatMemory, createSequentialQueue } = require('./chatMemory');
const { sendEmail, GMAIL_USER } = require('./emailService');

const AI_PROVIDER = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();

// DeepSeek Settings
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// Gemini Settings
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// Hermes Settings (via OpenRouter)
const HERMES_API_KEY = process.env.HERMES_API_KEY || '';
const HERMES_BASE_URL = process.env.HERMES_BASE_URL || 'https://openrouter.ai/api/v1';
const HERMES_MODEL = process.env.HERMES_MODEL || 'nousresearch/hermes-3-llama-3.1-8b';

// Google Cloud Platform Settings (Vision, Speech-to-Text & Cloud Storage)
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
const GOOGLE_SPEECH_API_KEY = process.env.GOOGLE_SPEECH_API_KEY || process.env.GOOGLE_VISION_API_KEY || '';
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'hermes-whatsapp-vault-390608';
// Tencent Cloud COS (50 GB package) - primary vault when credentials are set
const COS_SECRET_ID = process.env.COS_SECRET_ID || '';
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || '';
const COS_BUCKET = process.env.COS_BUCKET || 'hermes-whatsapp-vault-1498387033';
const COS_REGION = process.env.COS_REGION || 'ap-singapore';
const COS_ENABLED = Boolean(COS_SECRET_ID && COS_SECRET_KEY);

// Pre-signed GET link so files in the private bucket open in a browser (default 30 days)
const COS_URL_TTL_SECONDS = (parseInt(process.env.COS_URL_TTL_DAYS, 10) || 30) * 86400;
function signedCosUrl(objectKey) {
    const crypto = require('crypto');
    const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
    const pathname = `/${objectKey}`;
    const start = Math.floor(Date.now() / 1000) - 60;
    const signTime = `${start};${start + COS_URL_TTL_SECONDS}`;
    const signKey = crypto.createHmac('sha1', COS_SECRET_KEY).update(signTime).digest('hex');
    const httpString = `get
${pathname}


`;
    const stringToSign = `sha1
${signTime}
${crypto.createHash('sha1').update(httpString).digest('hex')}
`;
    const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
    return `https://${host}${pathname}?q-sign-algorithm=sha1&q-ak=${COS_SECRET_ID}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=&q-url-param-list=&q-signature=${signature}`;
}

// Short links: WhatsApp gets http://<server>:3000/f/<id>, which redirects to a fresh signed COS URL
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SHORT_LINKS_PATH = path.join(__dirname, 'short-links.json');
let shortLinks = {};
try { shortLinks = JSON.parse(fs.readFileSync(SHORT_LINKS_PATH, 'utf8')); } catch (_) { /* first run */ }
function makeShortLink(objectKey) {
    const id = require('crypto').randomBytes(5).toString('base64url');
    shortLinks[id] = objectKey;
    try { fs.writeFileSync(SHORT_LINKS_PATH, JSON.stringify(shortLinks)); } catch (e) { console.warn('[SHORT LINK] could not persist:', e.message); }
    return `${PUBLIC_BASE_URL}/f/${id}`;
}

// Vault browser: /vault?t=<token> lists everything in the COS bucket (newest first) with working links.
const VAULT_TOKEN_PATH = path.join(__dirname, 'vault-token.txt');
let VAULT_TOKEN = process.env.VAULT_TOKEN || '';
if (!VAULT_TOKEN) {
    try { VAULT_TOKEN = fs.readFileSync(VAULT_TOKEN_PATH, 'utf8').trim(); } catch (_) { /* generate below */ }
}
if (!VAULT_TOKEN) {
    VAULT_TOKEN = require('crypto').randomBytes(9).toString('base64url');
    try { fs.writeFileSync(VAULT_TOKEN_PATH, VAULT_TOKEN, { mode: 0o600 }); } catch (e) { console.warn('[VAULT] could not persist token:', e.message); }
}
const VAULT_URL = `${PUBLIC_BASE_URL}/vault?t=${VAULT_TOKEN}`;

async function listCosObjects() {
    const crypto = require('crypto');
    const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
    const start = Math.floor(Date.now() / 1000) - 60;
    const signTime = `${start};${start + 600}`;
    const signKey = crypto.createHmac('sha1', COS_SECRET_KEY).update(signTime).digest('hex');
    const httpString = `get\n/\n\nhost=${host}\n`;
    const stringToSign = `sha1\n${signTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`;
    const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
    const authorization = `q-sign-algorithm=sha1&q-ak=${COS_SECRET_ID}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
    const resp = await fetch(`https://${host}/`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`COS list ${resp.status}`);
    const xml = await resp.text();
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(m => ({
        key: (m[1].match(/<Key>([^<]*)<\/Key>/) || [])[1] || '',
        size: parseInt((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1], 10) || 0,
        modified: (m[1].match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1] || ''
    })).filter(o => o.key && !o.key.endsWith('/') && !o.key.startsWith('tmp-test/') && o.key !== 'healthcheck.txt')
       .sort((a, b) => b.modified.localeCompare(a.modified));
}

async function renderVaultPage() {
    const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtSize = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    const items = await listCosObjects();
    const rows = items.map(o => {
        const url = `${PUBLIC_BASE_URL}/vault/file?t=${VAULT_TOKEN}&k=${encodeURIComponent(o.key)}`;
        const isImg = /\.(jpe?g|png|webp)$/i.test(o.key);
        return `<a class="item" href="${esc(url)}" target="_blank" rel="noopener">${isImg ? `<img loading="lazy" src="${esc(url)}" alt="">` : '<div class="ico">📄</div>'}<div class="meta"><b>${esc(o.key.split('/').pop())}</b><span>${esc(o.key.split('/')[0])} · ${fmtSize(o.size)}</span></div></a>`;
    }).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloud Vault</title>` +
        `<style>body{margin:0;font:15px system-ui,sans-serif;background:#0f172a;color:#e2e8f0}h1{padding:20px 16px 4px;margin:0;font-size:22px}p{margin:0 16px 16px;color:#94a3b8}` +
        `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:0 16px 24px}.item{display:flex;gap:10px;align-items:center;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:10px;text-decoration:none;color:inherit}` +
        `.item:hover{border-color:#38bdf8}.item img,.ico{width:56px;height:56px;border-radius:6px;object-fit:cover;flex:none;background:#0f172a;display:flex;align-items:center;justify-content:center;font-size:26px}` +
        `.meta{display:flex;flex-direction:column;min-width:0}.meta b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta span{color:#94a3b8;font-size:12px}</style></head>` +
        `<body><h1>📁 Cloud Vault</h1><p>${items.length} file(s) in Tencent COS · tap a file to open it</p><div class="grid">${rows || '<p>No files yet.</p>'}</div></body></html>`;
}

// Stream a COS object through this server (same trusted HTTPS domain), inline and with Range support (iOS PDF/video viewers).
async function proxyCosObject(req, res, key) {
    try {
        const headers = {};
        if (req.headers.range) headers.Range = req.headers.range;
        const upstream = await fetch(signedCosUrl(key), { headers, signal: AbortSignal.timeout(120000) });
        if (!upstream.ok && upstream.status !== 206) {
            res.writeHead(upstream.status === 404 ? 404 : 502, { 'Content-Type': 'text/plain' });
            return res.end(upstream.status === 404 ? 'File not found' : 'Storage unavailable');
        }
        const out = {
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${path.basename(key)}"`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=300'
        };
        for (const h of ['content-length', 'content-range']) {
            const v = upstream.headers.get(h);
            if (v) out[h] = v;
        }
        res.writeHead(upstream.status, out);
        require('stream').Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
        console.error('[FILE PROXY ERROR]:', e.message);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('File temporarily unavailable');
    }
}

// PUT an object to COS using the q-sign (HMAC-SHA1) header signature. Key must contain only URL-safe characters.
async function uploadToCOS(buffer, objectKey, contentType) {
    const crypto = require('crypto');
    const host = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`;
    const pathname = `/${objectKey}`;
    const start = Math.floor(Date.now() / 1000) - 60;
    const signTime = `${start};${start + 3600}`;
    const signKey = crypto.createHmac('sha1', COS_SECRET_KEY).update(signTime).digest('hex');
    const httpString = `put
${pathname}

host=${host}
`;
    const stringToSign = `sha1
${signTime}
${crypto.createHash('sha1').update(httpString).digest('hex')}
`;
    const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
    const authorization = `q-sign-algorithm=sha1&q-ak=${COS_SECRET_ID}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
    const resp = await fetch(`https://${host}${pathname}`, {
        method: 'PUT',
        headers: { 'Authorization': authorization, 'Content-Type': contentType || 'application/octet-stream' },
        body: buffer,
        signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) throw new Error(`COS ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    return `https://${host}${pathname}`;
}

// Google Storage & Drive Vault Settings
const GOOGLE_DRIVE_KEY_PATH = process.env.GOOGLE_DRIVE_KEY_PATH || path.join(__dirname, 'google-drive-key.json');
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
const GCS_KEY_PATH = process.env.GCS_KEY_PATH || path.join(__dirname, 'google-storage-key.json');

let googleDriveKey = null;
if (fs.existsSync(GOOGLE_DRIVE_KEY_PATH)) {
    try {
        googleDriveKey = JSON.parse(fs.readFileSync(GOOGLE_DRIVE_KEY_PATH, 'utf8'));
        console.log(`[GOOGLE DRIVE] Loaded Service Account: ${googleDriveKey.client_email}`);
    } catch (e) {
        console.warn('[GOOGLE DRIVE] Could not load service account key:', e.message);
    }
}

let googleStorageKey = null;
if (fs.existsSync(GCS_KEY_PATH)) {
    try {
        googleStorageKey = JSON.parse(fs.readFileSync(GCS_KEY_PATH, 'utf8'));
        console.log(`[CLOUD STORAGE] Loaded Service Account: ${googleStorageKey.client_email}`);
    } catch (e) {
        console.warn('[CLOUD STORAGE] Could not load service account key:', e.message);
    }
}

async function getGCSAccessToken() {
    const key = googleStorageKey || googleDriveKey;
    if (!key) return null;
    try {
        const crypto = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const claim = Buffer.from(JSON.stringify({
            iss: key.client_email,
            scope: 'https://www.googleapis.com/auth/devstorage.full_control https://www.googleapis.com/auth/cloud-platform',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now
        })).toString('base64url');

        const signer = crypto.createSign('RSA-SHA256');
        signer.update(`${header}.${claim}`);
        const signature = signer.sign(key.private_key, 'base64url');
        const jwt = `${header}.${claim}.${signature}`;

        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
        });

        const data = await resp.json();
        return data.access_token || null;
    } catch (e) {
        console.error('[CLOUD STORAGE AUTH ERROR]:', e.message);
        return null;
    }
}

/**
 * Attempts to retrieve Google Cloud OAuth token from GCE metadata server if running on GCP VM
 */
async function getGCPAccessToken() {
    try {
        const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
            headers: { 'Metadata-Flavor': 'Google' },
            signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
            const data = await res.json();
            return data.access_token;
        }
    } catch (e) {
        // Not running on GCE or metadata server unreachable
    }
    return null;
}

const OCR_MAX_CHARS = 4000;
const HISTORY_MSG_MAX_CHARS = 400;
const REPLY_MAX_TOKENS = 350;
const REPLY_MAX_TOKENS_FULL = 4500; // replies to a long quoted message / translations (Hindi needs many more tokens than English)
const QUOTED_FULL_INSTRUCTION = `\n\n[FULL-LENGTH RULES: If the user asks to translate, transcribe, restate, explain or continue the quoted message (for example "in Hindi"), reproduce ALL of it completely, every section, bullet and number, in the requested language. Do not summarize, shorten or skip anything, and do not add commentary.]`;
const REPLY_MAX_TOKENS_DOC = 3000; // extraction replies need room for the full details
const DOC_DETAIL_INSTRUCTION = `

[EXTRACTION DETAIL RULES: This is a document extraction. Give the COMPLETE useful content, not a short summary: every party/person name, ID number, date, amount, address, clause, term, condition and signature detail found in the text, organized under clear *bold* section headings with • bullets. Keep the original wording and numbers. Fix only obvious OCR typos. Cover all pages. Do not stop early or shorten; the user wants most of the information.]`;

/**
 * Cleans raw OCR output (collapses whitespace/noise, dedupes lines) and truncates it
 * so it cannot burn LLM tokens.
 */
function cleanOcrText(raw) {
    if (!raw) return '';
    const seen = new Set();
    const lines = [];
    const rawLines = String(raw).split(/\r?\n/);

    // Pass 1: Collapse standalone currency symbols (e.g. "₹", "$") onto the next line if it starts with numbers
    for (let i = 0; i < rawLines.length; i++) {
        let cur = rawLines[i].replace(/[^\S\n]+/g, ' ').replace(/[|_~=\-]{4,}/g, ' ').trim();
        if (/^[₹$€£¥]$/.test(cur) && i + 1 < rawLines.length) {
            const next = rawLines[i + 1].trim();
            if (/^\d/.test(next)) {
                rawLines[i + 1] = cur + next;
                continue;
            }
        }
        if (cur.length < 2) continue;
        // Keep lines with letters, digits, or currency symbols (\p{Sc}); drop noise
        const meaningful = (cur.match(/[\p{L}\p{N}\p{Sc}]/gu) || []).length;
        if (meaningful === 0 || (cur.length > 4 && meaningful / cur.length < 0.35)) continue;
        const key = cur.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(cur);
    }
    const joined = lines.join('\n');
    return joined.length > OCR_MAX_CHARS ? joined.slice(0, OCR_MAX_CHARS).trimEnd() + ' …[truncated]' : joined;
}

/**
 * Compact form of a user message for chatHistory: media/OCR dumps become a short summary
 * marker instead of persisting into every subsequent turn.
 */
function compactForHistory(msg) {
    const text = String(msg || '');
    if (text.startsWith('[DOCUMENT TEXT EXTRACTED')) {
        const docName = (text.match(/^\[DOCUMENT TEXT EXTRACTED from "([^"]*)"/) || [])[1] || 'document';
        return `[User sent document "${docName}"; text: "${text.slice(0, 600).replace(/\s+/g, ' ')}…"]`;
    }
    const burstCount = (text.match(/^\[MEDIA BURST: (\d+) /) || [])[1];
    if (burstCount) return `[User sent ${burstCount} photos/documents at once. One combined summary was given.]`;
    if (text.startsWith('[IMAGE RECEIVED')) {
        const caption = (text.match(/User text accompanying the media: "([\s\S]*?)"$/) || [])[1];
        const scene = (text.match(/- Labels \/ Scene: (.*)/) || [])[1];
        const ocrMatch = text.match(/Detected Text \(OCR[^)]*\):\s*"([\s\S]*?)"/) ||
                         text.match(/\[IMAGE RECEIVED - MULTIMODAL VISION ANALYSIS[^\]]*\]:\s*([\s\S]*?)(?:\n\n|\n\[|\(No caption|$)/) ||
                         text.match(/\[IMAGE RECEIVED - LOCAL HIGH-ACCURACY OCR TRANSCRIPTION[^\]]*\]:\s*([\s\S]*?)(?:\n\n|\n\[|\(No caption|$)/);
        const ocrSnippet = ocrMatch && ocrMatch[1] ? ocrMatch[1].replace(/\s+/g, ' ').trim().slice(0, 300) : '';
        return `[User sent a photo${scene ? ` (${scene.split(',').slice(0, 4).join(',').trim()})` : ''}${ocrSnippet ? `; text: "${ocrSnippet}…"` : ''}${caption ? `; caption: "${caption.slice(0, 120)}"` : ''}.]`;
    }
    if (text.startsWith('[REPLIED-TO / QUOTED MESSAGE')) {
        const quotedPreview = (text.match(/Content: """([\s\S]*?)"""/) || [])[1] || '';
        const userReply = (text.match(/\[USER REPLY TO THE QUOTED MESSAGE ABOVE\]:\s*"?([\s\S]*?)"?(?:\n\n\((?:IMPORTANT|NOTE):|$)/) || [])[1] || '';
        const cleanQuoted = quotedPreview.trim().slice(0, 140).replace(/\r?\n+/g, ' ');
        const quoteDisp = quotedPreview.trim().length > 140 ? cleanQuoted + '…' : cleanQuoted;
        const cleanUser = userReply.trim().slice(0, 160).replace(/\r?\n+/g, ' ');
        return `[User replied to: "${quoteDisp}"]: "${cleanUser || text.slice(0, 100)}"`;
    }
    if (text.length <= HISTORY_MSG_MAX_CHARS) return text;
    // Keep any email addresses that truncation would otherwise drop (needed for recipient recall)
    const dropped = (text.slice(HISTORY_MSG_MAX_CHARS).match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || []).slice(0, 2);
    return text.slice(0, HISTORY_MSG_MAX_CHARS) + '…' + (dropped.length ? ` [emails: ${dropped.join(', ')}]` : '');
}

/**
 * Calls Google Cloud Vision API to extract labels, full text OCR, objects, and web context.
 */
async function analyzeImageWithVision(base64Data, mimeType = 'image/jpeg') {
    try {
        let apiUrl = 'https://vision.googleapis.com/v1/images:annotate';
        const headers = { 'Content-Type': 'application/json' };

        if (GOOGLE_VISION_API_KEY) {
            apiUrl += `?key=${GOOGLE_VISION_API_KEY}`;
        } else {
            const accessToken = (await getGCSAccessToken()) || (await getGCPAccessToken());
            if (accessToken) {
                headers['Authorization'] = `Bearer ${accessToken}`;
            } else {
                console.warn('[Vision API] No Google Cloud Vision API key or GCE metadata token available.');
                return null;
            }
        }

        const requestBody = {
            requests: [
                {
                    image: { content: base64Data },
                    features: [
                        { type: 'LABEL_DETECTION', maxResults: 10 },
                        { type: 'DOCUMENT_TEXT_DETECTION' },
                        { type: 'OBJECT_LOCALIZATION', maxResults: 10 },
                        { type: 'SAFE_SEARCH_DETECTION' },
                        { type: 'WEB_DETECTION', maxResults: 5 }
                    ],
                    imageContext: {
                        // Hint Indian English and Hindi so currency symbols like ₹ (U+20B9) and local number formats are recognized accurately rather than misinterpreted as digits like '3'
                        languageHints: ['en-IN', 'hi', 'en']
                    }
                }
            ]
        };

        const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(15000)
        });

        if (!resp.ok) {
            const errText = await resp.text();
            console.error(`[Vision API Error ${resp.status}]:`, errText);
            return null;
        }

        const data = await resp.json();
        const annotation = data.responses?.[0];
        if (!annotation) return null;

        const labels = (annotation.labelAnnotations || []).map(l => l.description).join(', ');
        const text = cleanOcrText(annotation.fullTextAnnotation?.text || annotation.textAnnotations?.[0]?.description || '');
        const objects = (annotation.localizedObjectAnnotations || []).map(o => o.name).join(', ');
        const webBestGuess = (annotation.webDetection?.bestGuessLabels || []).map(b => b.label).join(', ');
        const webEntities = (annotation.webDetection?.webEntities || []).filter(e => e.description).slice(0, 5).map(e => e.description).join(', ');

        const parts = [];
        if (text) {
            parts.push(`- Detected Text (OCR, cleaned/truncated): "${text}"`);
        }
        if (labels) {
            parts.push(`- Labels / Scene: ${labels}`);
        }
        if (objects) {
            parts.push(`- Identified Objects: ${objects}`);
        }
        if (webBestGuess) {
            parts.push(`- Best Web Guess / Entity: ${webBestGuess}`);
        } else if (webEntities) {
            parts.push(`- Relevant Web Topics: ${webEntities}`);
        }

        if (parts.length === 0) {
            return `[IMAGE RECEIVED]: An image was received, but no specific text or known objects were recognized.`;
        }

        return `[IMAGE RECEIVED - ANALYZED BY GOOGLE CLOUD VISION API]:\n${parts.join('\n')}`;
    } catch (err) {
        console.error('[Vision API Exception]:', err.message);
        return null;
    }
}

/**
 * Local Offline OCR Engine powered by Tesseract
 * Bulletproof fallback when cloud vision APIs hit high demand or network spikes.
 */
// Tencent Cloud OCR (GeneralBasicOCR). Uses the same API key pair as COS unless TENCENT_SECRET_* are set.
const TENCENT_OCR_ID = process.env.TENCENT_SECRET_ID || COS_SECRET_ID;
const TENCENT_OCR_KEY = process.env.TENCENT_SECRET_KEY || COS_SECRET_KEY;
const TENCENT_OCR_ENABLED = Boolean(TENCENT_OCR_ID && TENCENT_OCR_KEY) && process.env.TENCENT_OCR !== 'off';
async function tencentOcrRaw(base64Data, extra = {}) {
    try {
        const crypto = require('crypto');
        const host = process.env.TENCENT_OCR_HOST || 'ocr.intl.tencentcloudapi.com';
        const service = 'ocr', action = 'GeneralBasicOCR';
        const payload = JSON.stringify({ ...(base64Data ? { ImageBase64: base64Data } : {}), LanguageType: 'auto', ...extra });
        const ts = Math.floor(Date.now() / 1000);
        const date = new Date(ts * 1000).toISOString().slice(0, 10);
        const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
        const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();
        const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n\ncontent-type;host;x-tc-action\n${sha(payload)}`;
        const scope = `${date}/${service}/tc3_request`;
        const stringToSign = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${sha(canonical)}`;
        const signKey = hmac(hmac(hmac('TC3' + TENCENT_OCR_KEY, date), service), 'tc3_request');
        const signature = crypto.createHmac('sha256', signKey).update(stringToSign).digest('hex');
        const resp = await fetch(`https://${host}`, {
            method: 'POST',
            headers: {
                'Authorization': `TC3-HMAC-SHA256 Credential=${TENCENT_OCR_ID}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
                'Content-Type': 'application/json; charset=utf-8',
                'X-TC-Action': action,
                'X-TC-Version': '2018-11-19',
                'X-TC-Timestamp': String(ts),
                'X-TC-Region': process.env.TENCENT_OCR_REGION || 'ap-singapore'
            },
            body: payload,
            signal: AbortSignal.timeout(15000)
        });
        const data = (await resp.json()).Response || {};
        if (data.Error) {
            console.warn(`[Tencent OCR] ${data.Error.Code}: ${data.Error.Message}`);
            return null;
        }
        return (data.TextDetections || []).map(t => t.DetectedText).join('\n').trim();
    } catch (err) {
        console.warn('[Tencent OCR Warn]:', err.message);
    }
    return null;
}

async function analyzeImageWithTencentOCR(base64Data) {
    const text = await tencentOcrRaw(base64Data);
    if (text && text.length > 10) {
        return `[IMAGE RECEIVED - TENCENT CLOUD OCR TRANSCRIPTION]:\n${cleanOcrText(text)}`;
    }
    return null;
}

// Extract readable text from a received document (PDF via Tencent OCR page by page, DOCX/XLSX/PPTX via unzip, plain text).
const DOC_MAX_PDF_PAGES = parseInt(process.env.DOC_MAX_PDF_PAGES, 10) || 8;
// PDF text: embedded text layer first (pdftotext). Scanned PDFs are OCR'd by Tencent: small files by passing the COS link
// (no upload of the file contents), large files by rendering pages to JPEG (pdftoppm) and sending those.
const PDF_LINK_OCR_MAX_BYTES = 6 * 1024 * 1024; // Tencent rejects larger files fetched by URL
async function extractPdfText(buffer, base64Data, cloudUrl) {
    const base = path.join(os.tmpdir(), `pdf_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const pdfPath = `${base}.pdf`;
    const lastPage = String(DOC_MAX_PDF_PAGES);
    await fs.promises.writeFile(pdfPath, buffer);
    const ocrInBatches = async (count, ocrPage) => {
        const pages = [];
        for (let i = 0; i < count; i += 3) {
            const batch = Array.from({ length: Math.min(3, count - i) }, (_, k) => i + k + 1);
            const texts = await Promise.all(batch.map(ocrPage));
            texts.forEach((text, k) => { if (text) pages.push(`--- Page ${batch[k]} ---\n${text}`); });
        }
        return pages.length ? pages.join('\n\n') : null;
    };
    try {
        try {
            const { stdout } = await execFileAsync('pdftotext', ['-layout', '-l', lastPage, pdfPath, '-'], { timeout: 20000, maxBuffer: 20 * 1024 * 1024 });
            if (stdout.replace(/\s/g, '').length >= 80) return stdout.trim();
            if (!TENCENT_OCR_ENABLED) return null;

            let pageCount = DOC_MAX_PDF_PAGES;
            try {
                const info = (await execFileAsync('pdfinfo', [pdfPath], { timeout: 10000 })).stdout.match(/^Pages:\s+(\d+)/m);
                if (info) pageCount = Math.min(parseInt(info[1], 10), DOC_MAX_PDF_PAGES);
            } catch (_) { /* keep default */ }

            if (cloudUrl && buffer.length <= PDF_LINK_OCR_MAX_BYTES) {
                console.log(`[DOC EXTRACT] Scanned PDF: OCR via COS link (${pageCount} pages)`);
                const viaLink = await ocrInBatches(pageCount, (page) => tencentOcrRaw(null, { ImageUrl: cloudUrl, IsPdf: true, PdfPageNumber: page }));
                if (viaLink) return viaLink;
            }

            console.log(`[DOC EXTRACT] Scanned PDF: rendering ${pageCount} pages for OCR`);
            await execFileAsync('pdftoppm', ['-jpeg', '-r', '110', '-l', String(pageCount), pdfPath, base], { timeout: 90000 });
            const prefix = `${path.basename(base)}-`;
            const pageFiles = (await fs.promises.readdir(os.tmpdir())).filter(f => f.startsWith(prefix) && f.endsWith('.jpg')).sort();
            try {
                return await ocrInBatches(pageFiles.length, async (page) => {
                    const img = (await fs.promises.readFile(path.join(os.tmpdir(), pageFiles[page - 1]))).toString('base64');
                    return tencentOcrRaw(img);
                });
            } finally {
                for (const f of pageFiles) fs.promises.unlink(path.join(os.tmpdir(), f)).catch(() => {});
            }
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            console.warn('[DOC EXTRACT] poppler-utils not installed, sending PDF directly to Tencent OCR');
        }
        if (!TENCENT_OCR_ENABLED || base64Data.length > 9 * 1024 * 1024) return null;
        return await ocrInBatches(DOC_MAX_PDF_PAGES, (page) => tencentOcrRaw(base64Data, { IsPdf: true, PdfPageNumber: page }));
    } finally {
        fs.promises.unlink(pdfPath).catch(() => {});
    }
}

async function extractDocumentText(base64Data, mimeType, filename, cloudUrl) {
    const mime = (mimeType || '').toLowerCase();
    const name = (filename || '').toLowerCase().trim();
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        if (mime.includes('pdf') || name.endsWith('.pdf')) {
            return await extractPdfText(buffer, base64Data, cloudUrl);
        }
        if (name.endsWith('.docx') || name.endsWith('.xlsx') || name.endsWith('.pptx') || mime.includes('officedocument')) {
            const inner = name.endsWith('.xlsx') ? 'xl/sharedStrings.xml' : name.endsWith('.pptx') ? 'ppt/slides/slide*.xml' : 'word/document.xml';
            const tmp = path.join(os.tmpdir(), `doc_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(name) || '.zip'}`);
            await fs.promises.writeFile(tmp, buffer);
            try {
                const { stdout } = await execFileAsync('unzip', ['-p', tmp, inner], { timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
                return stdout.replace(/<\/(w:p|a:p|si)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() || null;
            } finally {
                fs.promises.unlink(tmp).catch(() => {});
            }
        }
        if (mime.startsWith('text/') || /\.(txt|csv|md|json)$/.test(name)) {
            return buffer.toString('utf8').trim() || null;
        }
    } catch (err) {
        console.warn('[DOC EXTRACT Warn]:', err.message);
    }
    return null;
}

// ─── Disease guide: medical report -> best product combination with do's and don'ts ───
const diseaseGuide = require('./diseaseGuide');
const REPORT_MARK = '[REPORT GUIDANCE]';
const REPORT_GUIDANCE_RULES = `[REPORT GUIDANCE RULES]
You are writing a WhatsApp reply for a wellness-product guide, based ONLY on the report text above and the matched guide data above.
1. Start with a short "📋 Report summary": list the abnormal values (value vs normal range, marked high/low). Do not invent values that are not in the report.
2. "🩺 What it may indicate": name the matched conditions in plain words. Say "may indicate / is consistent with", never "you have". This is guidance, not a diagnosis.
3. "💊 Best product combination": recommend ONLY the products listed under BEST PRODUCT COMBINATION, with their exact dosage and timing. Never invent products, ingredients, doses or claims. Never say a product cures, treats or reverses a disease; say it "supports" wellness.
4. "✅ Do" and "❌ Don't": use the DO and DON'T lists above (pick the most relevant, short bullets).
5. "⚠️ See a doctor": always tell them to continue prescribed medicines (never stop or replace them), to show this plan to their doctor before starting, and to seek urgent medical care for red-flag signs (chest pain, breathlessness, very high or low sugar, fainting, severe pain, bleeding, very abnormal results). If the report itself looks critical, say this first.
6. Use *single asterisk* bold and • bullets only, no tables or markdown headers. Reply in the user's language (Hindi/Hinglish if they wrote Hindi). Include all the useful detail but keep each bullet to one line.
7. End with one line: "This is general wellness guidance, not a medical diagnosis or a substitute for your doctor's advice."`;

async function buildReportGuidance(reportText) {
    if (!diseaseGuide.count()) return null;
    let diseases = [];
    let abnormal = [];
    let urgent = '';
    try {
        const tmpId = `guide-select:${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const raw = await generateAIReply(tmpId,
            `REPORT TEXT:\n${String(reportText).slice(0, 16000)}\n\nCONDITION LIST (id|name):\n${diseaseGuide.catalogText()}\n\n` +
            `Choose the 1 to 3 conditions from the list that the report's abnormal findings most directly point to. If nothing in the report is abnormal or relevant, return an empty ids array. ` +
            `Return ONLY JSON like {"ids":[3,7],"abnormal":["HbA1c 8.4% (high, normal 4-5.6)"],"urgent":""}. "urgent" is a short red-flag note only if a value is dangerously abnormal, otherwise an empty string.`,
            'You are a careful clinical triage assistant. Return ONLY valid JSON.', 600);
        chatHistory.delete(tmpId);
        const parsed = JSON.parse((String(raw).match(/\{[\s\S]*\}/) || ['{}'])[0]);
        diseases = (parsed.ids || []).map(id => diseaseGuide.getDisease(id)).filter(Boolean).slice(0, 3);
        abnormal = Array.isArray(parsed.abnormal) ? parsed.abnormal.slice(0, 15) : [];
        urgent = typeof parsed.urgent === 'string' ? parsed.urgent : '';
    } catch (e) {
        console.warn('[REPORT GUIDANCE] condition selection failed, using keyword match:', e.message);
    }
    if (!diseases.length) diseases = diseaseGuide.searchByText(reportText, 3);
    if (!diseases.length) return null;
    console.log(`[REPORT GUIDANCE] Matched: ${diseases.map(d => d.name).join(', ')}`);
    return `${REPORT_MARK}\n` +
        (abnormal.length ? `ABNORMAL FINDINGS (from the report): ${abnormal.join('; ')}\n` : '') +
        (urgent ? `RED FLAG: ${urgent}\n` : '') +
        `${diseaseGuide.guideContext(diseases)}\n\n${REPORT_GUIDANCE_RULES}`;
}

const DISEASE_QUERY_RE = /\b(products?|medicines?|dawai|dawa|upay|ilaj|treatment|guide|suggest|recommend|kya le|kya lu|kaun sa)\b/i;

async function describeDocument(base64Data, mimeType, filename, cloudUrl) {
    const startedAt = Date.now();
    const text = await extractDocumentText(base64Data, mimeType, filename, cloudUrl);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!text) {
        console.log(`[DOCUMENT] No text extracted from "${filename || 'document'}" after ${seconds}s.`);
        return null;
    }
    console.log(`[DOCUMENT] Extracted ${text.length} chars from "${filename || 'document'}" in ${seconds}s.`);
    return `[DOCUMENT TEXT EXTRACTED from "${filename || 'Document'}"]:\n${text.slice(0, 12000)}${text.length > 12000 ? '\n...[truncated]' : ''}`;
}

async function analyzeImageWithTesseract(base64Data) {
    let tmpPath = null;
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        tmpPath = path.join(os.tmpdir(), `ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
        await fs.promises.writeFile(tmpPath, buffer);
        const { stdout } = await execFileAsync('tesseract', [tmpPath, 'stdout', '--oem', '1', '-l', 'eng+hin'], { timeout: 10000 });
        const text = (stdout || '').trim();
        if (text && text.length > 10) {
            return `[IMAGE RECEIVED - LOCAL HIGH-ACCURACY OCR TRANSCRIPTION]:\n${cleanOcrText(text)}`;
        }
    } catch (err) {
        console.warn('[Tesseract OCR Warn]:', err.message);
    } finally {
        if (tmpPath) {
            fs.promises.unlink(tmpPath).catch(() => {});
        }
    }
    return null;
}

/**
 * Multimodal Vision & OCR Engine powered by Google Gemini Vision
 * Features multi-model resilience (gemini-3.5-flash -> gemini-3-flash-preview) against 503 high demand spikes.
 */
async function analyzeImageWithGemini(base64Data, mimeType = 'image/jpeg') {
    if (!GEMINI_API_KEY) return null;
    const candidateModels = [GEMINI_MODEL, 'gemini-3-flash-preview'].filter(Boolean);
    const uniqueModels = [...new Set(candidateModels)];

    for (const model of uniqueModels) {
        try {
            console.log(`[Vision Engine] Trying Gemini model: ${model}...`);
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: "Thoroughly analyze and transcribe this image. If it contains slides, presentations, documents, forms, receipts, or screenshots, extract all visible text verbatim, including main titles, headings, speaker/presenter names, slide bullets, rules, legal acts, dates, and amounts (especially Indian Rupee ₹ figures). Structure the output clearly." },
                            { inline_data: { mime_type: mimeType, data: base64Data } }
                        ]
                    }],
                    generationConfig: {
                        maxOutputTokens: 2048,
                        thinkingConfig: { thinkingBudget: 0 }
                    }
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (resp.ok) {
                const data = await resp.json();
                const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
                if (text) {
                    const cleaned = text.length > 3500 ? text.slice(0, 3500) + ' …[truncated]' : text;
                    return `[IMAGE RECEIVED - MULTIMODAL VISION ANALYSIS]:\n${cleaned}`;
                }
            } else {
                const errText = await resp.text();
                console.warn(`[Gemini Vision ${model} Status ${resp.status}]:`, errText.slice(0, 160));
                if (resp.status === 503 || resp.status === 429 || resp.status === 404) {
                    continue; // try next candidate model
                }
            }
        } catch (e) {
            console.warn(`[Gemini Vision ${model} Error]:`, e.message);
        }
    }
    return null;
}

/**
 * Multi-layer Vision Engine:
 * 1. Gemini Multimodal Vision (rich multimodal comprehension + OCR)
 * 2. Local Tesseract OCR (100% offline, zero network failure, high accuracy text/receipt extraction)
 * 3. Google Cloud Vision API fallback
 */
async function getImageVisionDescription(base64Data, mimeType = 'image/jpeg') {
    // OCR chain: Tencent Cloud OCR first, local Tesseract as fallback (Google Vision and Gemini vision removed)
    if (TENCENT_OCR_ENABLED) {
        console.log('[Vision Engine] Trying Tencent Cloud OCR...');
        const tencentResult = await analyzeImageWithTencentOCR(base64Data);
        if (tencentResult) {
            console.log('[Vision Engine] Tencent Cloud OCR successfully extracted text.');
            return tencentResult;
        }
        console.log('[Vision Engine] Tencent OCR returned no text. Falling back to Local Tesseract OCR...');
    }

    const tesseractResult = await analyzeImageWithTesseract(base64Data);
    if (tesseractResult) {
        console.log('[Vision Engine] Local Tesseract OCR successfully extracted text.');
        return tesseractResult;
    }

    return '[IMAGE RECEIVED]: An image file was received, but automated text extraction could not detect distinct characters.';
}

/**
 * Calls Google Cloud Speech-to-Text API to transcribe incoming voice notes and audio.
 * Handles WhatsApp Opus (.ogg) and AAC/MP3 audio formats, configured for Hindi (hi-IN) and English (en-IN/en-US).
 */
async function transcribeAudioWithSpeech(base64Data, mimeType = 'audio/ogg') {
    try {
        let apiUrl = 'https://speech.googleapis.com/v1/speech:recognize';
        const headers = { 'Content-Type': 'application/json' };

        if (GOOGLE_SPEECH_API_KEY) {
            apiUrl += `?key=${GOOGLE_SPEECH_API_KEY}`;
        } else {
            const accessToken = await getGCPAccessToken();
            if (accessToken) {
                headers['Authorization'] = `Bearer ${accessToken}`;
            } else {
                console.warn('[Speech API] No Google Cloud Speech-to-Text API key or GCE metadata token available.');
                return null;
            }
        }

        let encoding = 'OGG_OPUS';
        let sampleRateHertz = 48000; // WhatsApp voice notes are Opus @ 48kHz

        const cleanMime = (mimeType || '').toLowerCase();
        if (cleanMime.includes('mp4') || cleanMime.includes('m4a') || cleanMime.includes('aac')) {
            encoding = 'MP3';
            sampleRateHertz = 16000;
        }

        const requestBody = {
            config: {
                encoding: encoding,
                sampleRateHertz: sampleRateHertz,
                languageCode: 'hi-IN',
                alternativeLanguageCodes: ['en-IN', 'en-US'],
                enableAutomaticPunctuation: true,
                model: 'default'
            },
            audio: {
                content: base64Data
            }
        };

        const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(20000)
        });

        if (!resp.ok) {
            const errText = await resp.text();
            console.error(`[Speech API Error ${resp.status}]:`, errText);
            return null;
        }

        const data = await resp.json();
        const results = data.results || [];
        if (results.length === 0) {
            console.log('[Speech API] No speech transcript detected — trying Gemini fallback.');
            return null;  // null triggers Gemini fallback
        }

        const transcript = results
            .map(r => r.alternatives?.[0]?.transcript || '')
            .filter(Boolean)
            .join(' ')
            .trim();

        if (!transcript) return null;

        return `[VOICE NOTE / AUDIO RECEIVED - TRANSCRIBED BY GOOGLE CLOUD SPEECH-TO-TEXT]: "${transcript}"`;
    } catch (err) {
        console.error('[Speech API Exception]:', err.message);
        return null;
    }
}

/**
 * Fallback audio transcription using Gemini Multimodal if Google Cloud Speech API fails.
 * Uses GEMINI_API_KEY or falls back to GOOGLE_VISION_API_KEY (same GCP project).
 */
async function transcribeAudioWithGemini(base64Data, mimeType = 'audio/ogg') {
    // Use GEMINI_API_KEY first, then Vision key as fallback (same GCP project)
    const apiKey = GEMINI_API_KEY || GOOGLE_VISION_API_KEY;
    if (!apiKey) return null;

    // WhatsApp sends audio/ogg;codecs=opus — Gemini needs clean audio/ogg
    const cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim() || 'audio/ogg';

    const modelsToTry = [GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-flash-latest'].filter(Boolean);

    for (const model of modelsToTry) {
        try {
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: 'Transcribe this voice note verbatim. The speaker may use Hindi, Hinglish, or English. Return only the spoken words, nothing else.' },
                                { inline_data: { mime_type: cleanMime, data: base64Data } }
                            ]
                        }],
                        generationConfig: { maxOutputTokens: 400, temperature: 0 }
                    }),
                    signal: AbortSignal.timeout(20000)
                }
            );
            if (resp.ok) {
                const data = await resp.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text && text.length > 1) {
                    console.log(`[Gemini Audio] Transcribed via ${model}.`);
                    return `[VOICE NOTE / AUDIO RECEIVED - TRANSCRIBED BY GEMINI]: "${text}"`;
                }
            } else {
                const errText = await resp.text().catch(() => '');
                console.warn(`[Gemini Audio] ${model} returned ${resp.status}:`, errText.substring(0, 100));
            }
        } catch (e) {
            console.warn(`[Gemini Audio] ${model} error:`, e.message);
        }
    }
    return null;
}

/**
 * Multi-layer Audio Engine: Google Cloud Speech-to-Text (48kHz Opus) → Gemini fallback
 */
async function getAudioTranscription(base64Data, mimeType = 'audio/ogg') {
    // Google Cloud Speech-to-Text (primary — confirmed working @ 48kHz)
    console.log('[Audio Engine] Trying Google Cloud Speech-to-Text (OGG_OPUS 48kHz)...');
    const speechResult = await transcribeAudioWithSpeech(base64Data, mimeType);
    if (speechResult) return speechResult;

    // Gemini Multimodal (fallback)
    console.log('[Audio Engine] Speech API empty — trying Gemini Multimodal fallback...');
    const geminiResult = await transcribeAudioWithGemini(base64Data, mimeType);
    if (geminiResult) return geminiResult;

    return '[VOICE NOTE / AUDIO RECEIVED]: A voice message was received, but automated transcription was unavailable.';
}

/**
 * Retrieves a Google OAuth2 access token for Google Drive API using RS256 JWT
 */
async function getGoogleDriveAccessToken() {
    if (!googleDriveKey) return null;
    try {
        const crypto = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const claim = Buffer.from(JSON.stringify({
            iss: googleDriveKey.client_email,
            scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/devstorage.full_control',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now
        })).toString('base64url');

        const signer = crypto.createSign('RSA-SHA256');
        signer.update(`${header}.${claim}`);
        const signature = signer.sign(googleDriveKey.private_key, 'base64url');
        const jwt = `${header}.${claim}.${signature}`;

        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
        });

        const data = await resp.json();
        return data.access_token || null;
    } catch (e) {
        console.error('[GOOGLE DRIVE AUTH ERROR]:', e.message);
        return null;
    }
}

/**
 * Uploads a file buffer directly to Google Drive via multipart upload
 */
async function uploadToGoogleDrive(buffer, originalFilename, mimeType = 'application/octet-stream') {
    const accessToken = await getGoogleDriveAccessToken();
    if (!accessToken) return null;

    try {
        const boundary = 'hermes_drive_boundary_' + Date.now();
        const cleanName = originalFilename || `file_${Date.now()}`;
        const cleanMime = (mimeType || 'application/octet-stream').split(';')[0];

        const metadata = {
            name: cleanName,
            mimeType: cleanMime,
            description: 'Uploaded by Hermes WhatsApp AI Agent'
        };

        if (GOOGLE_DRIVE_FOLDER_ID) {
            metadata.parents = [GOOGLE_DRIVE_FOLDER_ID];
        }

        const multipartBody = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${cleanMime}\r\n\r\n`),
            buffer,
            Buffer.from(`\r\n--${boundary}--`)
        ]);

        const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink';

        const uploadResp = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: multipartBody,
            signal: AbortSignal.timeout(60000)
        });

        if (!uploadResp.ok) {
            const errText = await uploadResp.text();
            console.warn(`[GOOGLE DRIVE UPLOAD WARN ${uploadResp.status}]:`, errText);
            return null;
        }

        const fileResult = await uploadResp.json();
        console.log(`[GOOGLE DRIVE] Uploaded successfully: "${fileResult.name}" (ID: ${fileResult.id})`);

        // Attempt to make file readable via link
        try {
            await fetch(`https://www.googleapis.com/drive/v3/files/${fileResult.id}/permissions?supportsAllDrives=true`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ role: 'reader', type: 'anyone' })
            });
        } catch (_) {}

        return {
            id: fileResult.id,
            name: fileResult.name,
            driveUrl: fileResult.webViewLink || `https://drive.google.com/file/d/${fileResult.id}/view?usp=sharing`
        };
    } catch (e) {
        console.error('[GOOGLE DRIVE ERROR]:', e.message);
        return null;
    }
}

/**
 * Multi-destination Storage Vault: Archives incoming media (images, audio, docs)
 * to local disk, Google Drive, and Google Cloud Storage bucket
 */
async function saveMediaToCloudStorage(base64Data, mimeType, sender, originalFilename = null) {
    try {
        const now = new Date();
        const dateFolder = now.toISOString().split('T')[0];
        const timestamp = now.getTime();

        let ext = 'bin';
        const cleanMime = (mimeType || '').toLowerCase();
        if (cleanMime.includes('jpeg') || cleanMime.includes('jpg')) ext = 'jpg';
        else if (cleanMime.includes('png')) ext = 'png';
        else if (cleanMime.includes('webp')) ext = 'webp';
        else if (cleanMime.includes('ogg')) ext = 'ogg';
        else if (cleanMime.includes('mp4') || cleanMime.includes('m4a')) ext = 'mp4';
        else if (cleanMime.includes('pdf')) ext = 'pdf';

        const cleanSender = String(sender).replace(/[^\w]/g, '_');
        const fileName = `${dateFolder}/${cleanSender}_${timestamp}.${ext}`;
        const localFilePath = path.join(__dirname, 'saved-media', fileName);
        const buffer = Buffer.from(base64Data, 'base64');

        let gcsUrl = null;
        let cosSignedUrl = null;
        let driveUrl = null;

        // 1. Google Drive Upload (Option B)
        // Drive uploads always fail with 403 storageQuotaExceeded for a service account; the Tencent vault is the store. Set GOOGLE_DRIVE_UPLOAD=1 to try again.
        if (googleDriveKey && process.env.GOOGLE_DRIVE_UPLOAD === '1') {
            console.log(`[GOOGLE DRIVE] Attempting upload for ${originalFilename || fileName}...`);
            const driveResult = await uploadToGoogleDrive(buffer, originalFilename || path.basename(fileName), cleanMime);
            if (driveResult && driveResult.driveUrl) {
                driveUrl = driveResult.driveUrl;
                console.log(`[GOOGLE DRIVE LINK]: ${driveUrl}`);
            }
        }

        // 2. Tencent COS upload (primary cloud vault)
        if (COS_ENABLED) {
            try {
                await uploadToCOS(buffer, fileName, cleanMime.split(';')[0]);
                cosSignedUrl = signedCosUrl(fileName);
                gcsUrl = makeShortLink(fileName);
                console.log(`[TENCENT COS] Successfully uploaded to cos://${COS_BUCKET}/${fileName}`);
                if (!String(sender).startsWith('report_')) mailAssistant.rememberFile(sender, { key: fileName, url: gcsUrl, mime: cleanMime.split(';')[0], name: originalFilename || '', ts: timestamp });
            } catch (e) {
                console.warn('[TENCENT COS] Upload failed:', e.message);
            }
        }

        // 3. Google Cloud Storage Bucket Upload (fallback when COS is not configured)
        if (!COS_ENABLED && GCS_BUCKET_NAME) {
            // Prefer service account key token (has Storage Admin); fall back to GCE metadata token
            const accessToken = (await getGCSAccessToken()) || (await getGCPAccessToken());
            if (accessToken) {
                const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET_NAME}/o?uploadType=media&name=${encodeURIComponent(fileName)}`;
                const uploadResp = await fetch(uploadUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': cleanMime.split(';')[0]
                    },
                    body: buffer,
                    signal: AbortSignal.timeout(30000)
                });

                if (uploadResp.ok) {
                    gcsUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${fileName}`;
                    console.log(`[CLOUD STORAGE] Successfully uploaded to gs://${GCS_BUCKET_NAME}/${fileName}`);
                } else {
                    const errText = await uploadResp.text();
                    console.warn(`[CLOUD STORAGE] Upload response status ${uploadResp.status}:`, errText);
                }
            } else {
                console.log(`[CLOUD VAULT] GCE metadata token not present (local dev). Local fallback copy will be kept`);
            }
        }

        // Files go straight to the cloud; keep a local copy only when no cloud upload succeeded
        let localPath = null;
        if (!(COS_ENABLED && gcsUrl)) {
            fs.mkdirSync(path.dirname(localFilePath), { recursive: true });
            fs.writeFileSync(localFilePath, buffer);
            localPath = localFilePath;
            console.log(`[CLOUD VAULT] Cloud upload unavailable, saved local archive: ${localFilePath} (~${Math.round(buffer.length / 1024)} KB)`);
        }

        return {
            saved: true,
            fileName: fileName,
            localPath: localPath,
            gcsUrl: gcsUrl,
            cosSignedUrl: cosSignedUrl,
            driveUrl: driveUrl
        };
    } catch (e) {
        console.error('[CLOUD VAULT ERROR]:', e.message);
        return null;
    }
}

const OWNER_NAME = process.env.OWNER_NAME || 'My Owner';
const BOT_NAME = process.env.BOT_NAME || 'Hermes AI';
const WHATSAPP_STYLE_RULES = `\n\nRESPONSE STYLE (strict): Write like a sharp, highly capable executive assistant on WhatsApp. ` +
    `1) Jump straight into the answer. NEVER open with "Certainly!", "Sure!", "Sure thing!", "Of course!", "Great question!", "Here is what you asked for", and NEVER say "As an AI". NEVER close with "Let me know if you need anything else!" or any similar filler. ` +
    `2) Keep paragraphs clean and readable, separated by blank lines. ` +
    `3) Use *single asterisks* for bold keywords. NEVER use **double asterisks**, markdown headers (#), tables, or code fences. ` +
    `4) For lists use "•" bullets, each starting with a fitting emoji or bullet, one idea per line. ` +
    `5) For photos/documents/scans/slides, extract and present all key information cleanly following the format below.`;

// Shared layout for every photo/document (single or part of a burst).
const PHOTO_CARD_FORMAT = `RESPONSE FORMAT FOR PHOTOS & DOCUMENTS:\n` +
    `1. For initial photo/document shares, provide a clean, structured overview formatted for WhatsApp:\n` +
    `📸 *<Punchy Title or Subject of Photo/Slide/Document>*\n\n` +
    `• *Key Details:*\n` +
    `  • <extracted heading, rule, degree, speaker name, or critical line>\n` +
    `  • <transcribed facts, figures, dates, or criteria>\n\n` +
    `👉 *Takeaway / Summary:* <one-line conclusion or answer to user's question>\n\n` +
    `2. Extraction / Full Details Requests:\n` +
    `If the user asks to "Extract", "Read", "Transcribe", "Details", "Kya likha hai", or asks specific questions about the image content, DO NOT truncate or deny. Provide the full extracted text, speaker names, legal acts, slide bullets, and data points cleanly and completely.\n\n` +
    `3. Accuracy & Integrity:\n` +
    `NEVER claim an image is blank or unreadable when analysis data is present. For legal acts, regulations, official degrees, or financial transactions (especially Indian Rupee ₹ amounts), transcribe names, terms, and numbers with exact precision.`;

// Rejects if a slow call exceeds ms so one stuck image can't freeze the per-chat queue.
function withTimeout(promise, ms, label, fallback) {
    let timer;
    const guard = new Promise(resolve => {
        timer = setTimeout(() => {
            console.warn(`[TIMEOUT] ${label} exceeded ${ms}ms — continuing with fallback.`);
            resolve(fallback);
        }, ms);
    });
    return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

/**
 * Final delivery sanitizer: enforces WhatsApp-native formatting and strips AI boilerplate.
 */
function sanitizeWhatsAppReply(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text.replace(/\r\n/g, '\n');

    out = out.replace(/```[a-z]*\n?/gi, '');                          // code fences
    out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, h) => `*${h.replace(/\*+/g, '').trim()}*`); // headers
    out = out.replace(/\*\*\*(.+?)\*\*\*/gs, '*$1*');                 // ***bold italic***
    out = out.replace(/\*\*(.+?)\*\*/gs, '*$1*');                     // **bold**
    out = out.replace(/__(.+?)__/gs, '*$1*');                         // __bold__
    out = out.replace(/^[ \t]*[-*+][ \t]+(?=\S)/gm, '• ');           // -, *, + bullets
    out = out.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '');               // horizontal rules

    // Leading pleasantries / robotic openers
    const openers = /^\s*(?:(?:certainly|sure(?: thing)?|of course|absolutely|great question|no problem|got it)[!.,:\-–—]*\s*|here(?:'s| is| are) (?:what you asked for|the (?:information|answer|details) you (?:requested|asked for))[^\n.:!]*[.:!]?\s*|as an ai(?: language model| assistant)?[^\n.,]*[.,]\s*)+/i;
    out = out.replace(openers, '');
    out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, h) => `*${h.replace(/\*+/g, '').trim()}*`); // header exposed by opener strip

    // Trailing boilerplate lines
    const closers = /(?:\n+[ \t]*(?:[^\n]*\b(?:let me know if (?:you|there)[^\n]*|feel free to (?:ask|reach out)[^\n]*|hope (?:this|that) helps[^\n]*|is there anything else[^\n]*|anything else i can (?:help|do)[^\n]*|happy to help (?:further|with anything)[^\n]*)))+[ \t]*$/i;
    out = out.replace(closers, '');
    out = out.replace(/(?:^|(?<=[.!?]\s))(?:let me know if you need anything else|feel free to ask(?: me)? anything(?: else)?|hope this helps)[!. ]*$/i, '');

    out = out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (out && /^[a-z]/.test(out) && out !== text.trim()) out = out[0].toUpperCase() + out.slice(1);
    return out || text.trim();
}
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 

    `You are ${BOT_NAME}, an intelligent personal assistant managing WhatsApp messages for ${OWNER_NAME} while they are away or busy. ` +
    `Be friendly, polite, concise, and helpful. If someone needs urgent contact with ${OWNER_NAME}, let them know their message has been recorded and ${OWNER_NAME} will get back to them as soon as possible. ` +
    `Answer general questions accurately. Keep WhatsApp replies brief and natural, avoiding overly lengthy walls of text unless explicitly requested. ` +
    `IMPORTANT CAPABILITY - GOOGLE DRIVE & CLOUD VAULT: You have a fully integrated Google Drive vault. When a user sends any media (image, document, audio) it is AUTOMATICALLY saved to Google Drive and Google Cloud Storage by the system backend. ` +
    `When you see [GOOGLE DRIVE LINK] in the context, it means the file WAS successfully saved. Confirm this to the user and share the link. ` +
    `When you see [CLOUD STORAGE LINK] instead, the file was saved to Google Cloud Storage backup. ` +
    `NEVER say you cannot access Drive or cannot save files — you absolutely can and do this automatically for every media received. ` +
    `EMAIL: Mail is handled by a separate mail assistant that shows a preview card and sends only after Roshan replies Yes. You never write email drafts yourself, never say a mail was sent, attached or delivered, and never claim you lack email access. If he asks about a mail, tell him to say for example "make a mail to name@x.com about ...".` +
    WHATSAPP_STYLE_RULES;

const OWNER_PROMPT = `You are ${BOT_NAME}, ${OWNER_NAME}'s world-class executive assistant. You are talking directly to ${OWNER_NAME}, the owner. ` +
    `Always use second person ("you"/"your"). NEVER use "he/him/his" or ${OWNER_NAME}'s name to refer to the person you're talking to, and never say he is away, busy, or that a message "will be passed on". ` +
    `Understand natural Hinglish, Hindi, and English (and voice-note transcripts with typos) and reply in the language he used. ` +
    `Give the answer or result first, instantly; no preamble, no restating the question, no filler. Ask at most one short clarifying question, only when truly blocked. ` +
    `Act on requests (emails, saving media, summaries, extractions) rather than describing how. Recalled background context is silent: never recite it. ` +
    `When he sends photos, slides, or documents, inspect the vision analysis and extract key facts, titles, speaker names, legal acts, or figures immediately. ` +
    `If he asks to "Extract", "Read", or follow up on an image, fulfill the request completely with full structured transcription. NEVER claim an image is blank if vision data is present. ` +
    `Google Drive/Cloud Vault: media he sends is automatically saved; when you see [GOOGLE DRIVE LINK] or [CLOUD STORAGE LINK], confirm it was saved and share the link. ` +
    `EMAIL: Mail is handled by a separate mail assistant that shows a preview card and sends only after Roshan replies Yes. You never write email drafts yourself, never say a mail was sent, attached or delivered, and never claim you lack email access. If he asks about a mail, tell him to say for example "make a mail to name@x.com about ...".` +
    WHATSAPP_STYLE_RULES;

const chatHistory = new Map();
const MAX_HISTORY = 10;

let currentQR = null;
let currentQRDataUrl = null;
let currentQRSVG = null;
let clientStatus = 'STARTING';

function getCurrentISTContext() {
    const now = new Date();
    const istOptions = { timeZone: 'Asia/Kolkata', hour12: true, hour: 'numeric', minute: 'numeric' };
    const timeStr = now.toLocaleTimeString('en-US', istOptions);
    const dateStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    const istHour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric' }), 10);
    
    let period = '';
    let advice = '';
    if (istHour >= 5 && istHour < 12) {
        period = 'Morning';
        advice = 'Morning hours: waking up, breakfast/nashta, starting day/college/office. Not night.';
    } else if (istHour >= 12 && istHour < 17) {
        period = 'Afternoon';
        advice = 'Afternoon hours: lunch (khana khaya?), office work, daytime banter.';
    } else if (istHour >= 17 && istHour < 20) {
        period = 'Evening';
        advice = 'Evening hours: evening tea/snacks, heading home, 6 PM curfew awareness.';
    } else if (istHour >= 20 && istHour < 23) {
        period = 'Night / Dinner time';
        advice = 'Night time (Dinner / relaxing): dinner (khana khaya?), unwinding after office. It is NOT morning, and NOT late-night sleep time yet.';
    } else {
        period = 'Late Night';
        advice = 'Late night / sleep hours (unwinding, sleepy, intimate talk or asking why she is awake late).';
    }

    return `\n[REAL-TIME CLOCK CONTEXT]: Current Time: ${dateStr}, ${timeStr} IST (${period}). ${advice}\n`;
}

async function getDeepSeekReply(chatId, userMessage, customSystemPrompt = null, maxTokens = REPLY_MAX_TOKENS) {
    if (!DEEPSEEK_API_KEY) {
        return "I am online, but my DeepSeek API key is not configured.";
    }

    const history = [...(chatHistory.get(chatId) || [])];
    history.push({ role: 'user', content: userMessage });

    const activePrompt = customSystemPrompt || SYSTEM_PROMPT;
    const messages = [
        { role: 'system', content: activePrompt },
        ...history.slice(-MAX_HISTORY)
    ];

    try {
        const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: DEEPSEEK_MODEL,
                messages: messages,
                max_tokens: maxTokens,
                temperature: 0.7
            })
        });

        if (!resp.ok) {
            const errText = await resp.text();
            console.error(`[DeepSeek Error ${resp.status}]:`, errText);
            return "Sorry, I had a momentary issue processing that message.";
        }

        const data = await resp.json();
        const replyText = data.choices?.[0]?.message?.content?.trim() || "Message received!";
        if (data.usage) {
            console.log(`[DeepSeek tokens] in=${data.usage.prompt_tokens} out=${data.usage.completion_tokens} cached=${data.usage.prompt_cache_hit_tokens || 0} (${String(chatId).split(':')[0].replace(/[0-9]{6,}.*/, 'chat')})`);
        }
        
        history[history.length - 1] = { role: 'user', content: compactForHistory(userMessage) };
        history.push({ role: 'assistant', content: replyText });
        chatHistory.set(chatId, history.slice(-MAX_HISTORY));

        return replyText;
    } catch (err) {
        console.error('[DeepSeek Fetch Exception]:', err.message);
        return "Sorry, I couldn't reach DeepSeek at the moment.";
    }
}

async function getGeminiReply(chatId, userMessage, customSystemPrompt = null, maxTokens = REPLY_MAX_TOKENS) {
    if (!GEMINI_API_KEY) {
        return "I am currently online, but my Gemini API key has not been configured yet.";
    }

    const history = [...(chatHistory.get(chatId) || [])];
    history.push({ role: 'user', parts: [{ text: userMessage }] });

    const activePrompt = customSystemPrompt || SYSTEM_PROMPT;
    const contents = [
        { role: 'user', parts: [{ text: `[System Instruction: ${activePrompt}]` }] },
        { role: 'model', parts: [{ text: "Understood." }] },
        ...history.slice(-MAX_HISTORY)
    ];

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: contents,
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: Math.max(maxTokens, 1024),
                    thinkingConfig: { thinkingBudget: 0 }
                }
            })
        });

        if (!resp.ok) {
            const errText = await resp.text();
            console.error(`[Gemini Error ${resp.status}]:`, errText);
            return "Sorry, I had a momentary issue processing that message.";
        }

        const data = await resp.json();
        const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
        const replyText = candidate ? candidate.trim() : "Thank you for your message. I'll pass it along!";
        
        history[history.length - 1] = { role: 'user', parts: [{ text: compactForHistory(userMessage) }] };
        history.push({ role: 'model', parts: [{ text: replyText }] });
        chatHistory.set(chatId, history.slice(-MAX_HISTORY));

        return replyText;
    } catch (err) {
        console.error('[Gemini Fetch Exception]:', err.message);
        return "Sorry, I couldn't reach my AI brain at the moment.";
    }
}

async function getHermesReply(chatId, userMessage, customSystemPrompt = null, maxTokens = REPLY_MAX_TOKENS) {
    if (!HERMES_API_KEY) {
        return "I am currently online, but my Hermes API key has not been configured yet.";
    }

    const history = [...(chatHistory.get(chatId) || [])];
    history.push({ role: 'user', content: userMessage });

    const activePrompt = customSystemPrompt || SYSTEM_PROMPT;
    const messages = [
        { role: 'system', content: activePrompt },
        ...history.slice(-MAX_HISTORY)
    ];

    try {
        const resp = await fetch(`${HERMES_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${HERMES_API_KEY}`
            },
            body: JSON.stringify({
                model: HERMES_MODEL,
                messages: messages,
                max_tokens: maxTokens,
                temperature: 0.7
            })
        });

        if (!resp.ok) {
            const errText = await resp.text();
            console.error(`[Hermes Error ${resp.status}]:`, errText);
            return "Sorry, I encountered an issue connecting to Hermes.";
        }

        const data = await resp.json();
        const replyText = data.choices?.[0]?.message?.content?.trim() || "Message received!";
        
        history[history.length - 1] = { role: 'user', content: compactForHistory(userMessage) };
        history.push({ role: 'assistant', content: replyText });
        chatHistory.set(chatId, history.slice(-MAX_HISTORY));

        return replyText;
    } catch (err) {
        console.error('[Hermes Fetch Exception]:', err.message);
        return "Sorry, I couldn't reach the Hermes model.";
    }
}

async function generateAIReply(chatId, userMessage, customSystemPrompt = null, maxTokens = REPLY_MAX_TOKENS) {
    let reply = null;
    const isError = txt => !txt || txt.startsWith('Sorry,') || txt.includes('momentary issue') || txt.includes("couldn't reach");

    if (AI_PROVIDER === 'deepseek') {
        reply = await getDeepSeekReply(chatId, userMessage, customSystemPrompt, maxTokens);
        if (isError(reply) && GEMINI_API_KEY) {
            console.log(`[AI FALLBACK] Primary provider (DeepSeek) returned error. Falling back to Gemini (${GEMINI_MODEL})...`);
            const fallback = await getGeminiReply(chatId, userMessage, customSystemPrompt, maxTokens);
            if (fallback && !isError(fallback)) reply = fallback;
        }
    } else if (AI_PROVIDER === 'gemini') {
        reply = await getGeminiReply(chatId, userMessage, customSystemPrompt, maxTokens);
        if (isError(reply) && DEEPSEEK_API_KEY) {
            console.log(`[AI FALLBACK] Primary provider (Gemini) returned error. Falling back to DeepSeek (${DEEPSEEK_MODEL})...`);
            const fallback = await getDeepSeekReply(chatId, userMessage, customSystemPrompt, maxTokens);
            if (fallback && !isError(fallback)) reply = fallback;
        }
    } else {
        reply = await getHermesReply(chatId, userMessage, customSystemPrompt, maxTokens);
    }
    return reply || "I received your message and will update you shortly.";
}

/**
 * Robust media downloader that bypasses wwebjs downloadMedia() failures.
 * Strategy:
 *  1. Try wwebjs msg.downloadMedia() (standard path)
 *  2. If that throws / returns empty — use pupPage.evaluate to read the
 *     already-decrypted blob from WhatsApp Web's MediaBlobCache or render URL
 *  3. If blob read also fails, return null (graceful degradation)
 */
async function robustDownloadMedia(client, msg) {
    // Ensure _serialized exists before first attempt
    if (msg.id && !msg.id._serialized) {
        const r = msg.id.remote;
        const remoteStr = (r && typeof r === 'object')
            ? (r._serialized || r.$1 || String(r))
            : (r || '');
        msg.id._serialized = msg.id.$1
            || (remoteStr ? `${msg.id.fromMe ? 'true' : 'false'}_${remoteStr}_${msg.id.id}` : undefined);
    }

    // --- Attempt 1: Standard wwebjs downloadMedia() ---
    try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
            console.log('[MEDIA] Standard downloadMedia() succeeded.');
            return media;
        }
    } catch (e1) {
        console.warn('[MEDIA] Standard downloadMedia() failed:', e1 && (e1.message || String(e1)));
    }

    // --- Attempt 2: Browser-side blob extraction via pupPage.evaluate ---
    // WhatsApp Web keeps decrypted media blobs in memory; try reading them directly.
    console.log('[MEDIA] Attempting browser-side blob extraction fallback...');
    try {
        const blobResult = await client.pupPage.evaluate(async (msgId) => {
            try {
                const WA = window.require;
                const Store = WA('WAWebCollections');
                const MediaDecrypt = WA('WAWebMediaDecryptors') || WA('WAWebDownloadManager');

                // Try multiple ways to find the message
                let waMsg = Store.Msg.get(msgId);
                if (!waMsg) {
                    waMsg = Store.Msg.models && Store.Msg.models.find(m =>
                        m && m.id && (m.id._serialized === msgId || m.id.$1 === msgId || m.id.id === msgId)
                    );
                }
                if (!waMsg) {
                    const res = await Store.Msg.getMessagesById([msgId]);
                    waMsg = res && res.messages && res.messages[0];
                }
                if (!waMsg) return { error: 'msg_not_found', msgId };

                // Try to get the media URL already loaded in the browser
                const mediaData = waMsg.mediaData || waMsg.clientUrl || waMsg.thumbnailDirectPath;

                // Check if there's a blob URL already in the renderer
                let blobUrl = null;
                if (waMsg.mediaData && waMsg.mediaData.mediaBlob) {
                    try { blobUrl = URL.createObjectURL(waMsg.mediaData.mediaBlob); } catch (e) { blobUrl = null; } // not a real Blob (e.g. a video you sent yourself): fall through to the direct download
                } else if (waMsg.clientUrl && waMsg.clientUrl.startsWith('blob:')) {
                    blobUrl = waMsg.clientUrl;
                }

                if (blobUrl) {
                    const resp = await fetch(blobUrl);
                    const arrayBuf = await resp.arrayBuffer();
                    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
                    return {
                        data: base64,
                        mimetype: waMsg.mimetype || 'application/octet-stream',
                        filename: waMsg.filename || null
                    };
                }

                // Try WAWebDownloadManager to trigger download and get blob
                const DownloadManager = (() => {
                    try { return WA('WAWebDownloadManager'); } catch(e) { return null; }
                })();
                if (DownloadManager && DownloadManager.downloadAndMaybeDecrypt) {
                    let blob = null;
                    try { blob = await DownloadManager.downloadAndMaybeDecrypt({ msg: waMsg, signal: null }); } catch (e) { blob = null; }
                    if (blob) {
                        const arrayBuf = await blob.arrayBuffer();
                        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));
                        return {
                            data: base64,
                            mimetype: waMsg.mimetype || 'application/octet-stream',
                            filename: waMsg.filename || null
                        };
                    }
                }

                return { needsDecrypt: true, directPath: waMsg.directPath, mediaKey: waMsg.mediaKey, mimetype: waMsg.mimetype || 'image/jpeg', filename: waMsg.filename || null, type: waMsg.type || 'image' };
            } catch (err) {
                return { error: String(err), stack: err && err.stack };
            }
        }, msg.id._serialized || msg.id.$1 || msg.id.id);

        if (blobResult && blobResult.data) {
            console.log('[MEDIA] Browser blob extraction succeeded.');
            return blobResult;
        }

        // --- Attempt 3: Node.js CDN fetch + AES-256-CBC decrypt ---
        if (blobResult && blobResult.needsDecrypt && blobResult.directPath && blobResult.mediaKey) {
            console.log('[MEDIA] Attempting Node.js CDN fetch + AES decrypt...');
            try {
                const crypto = require('crypto');
                const https = require('https');

                const cdnUrl = blobResult.directPath.startsWith('http')
                    ? blobResult.directPath
                    : 'https://mmg.whatsapp.net' + blobResult.directPath;

                console.log('[MEDIA] CDN URL:', cdnUrl.substring(0, 100) + '...');

                const encryptedBuf = await new Promise((resolve, reject) => {
                    const chunks = [];
                    const req = https.get(cdnUrl, { timeout: 30000 }, (res) => {
                        if (res.statusCode !== 200) { reject(new Error(`CDN HTTP ${res.statusCode}`)); return; }
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve(Buffer.concat(chunks)));
                        res.on('error', reject);
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('CDN timeout')); });
                });

                console.log(`[MEDIA] CDN fetch OK: ${encryptedBuf.length} bytes. Decrypting...`);

                const infoMap = {
                    image: 'WhatsApp Image Keys', video: 'WhatsApp Video Keys',
                    audio: 'WhatsApp Audio Keys', ptt: 'WhatsApp Audio Keys',
                    document: 'WhatsApp Document Keys', sticker: 'WhatsApp Image Keys'
                };
                const mType = blobResult.type || (blobResult.mimetype || '').split('/')[0] || 'image';
                const infoStr = infoMap[mType] || 'WhatsApp Image Keys';
                const mediaKeyBuf = Buffer.from(blobResult.mediaKey, 'base64');

                let hkdfKey;
                if (crypto.hkdfSync) {
                    hkdfKey = Buffer.from(crypto.hkdfSync('sha256', mediaKeyBuf, Buffer.alloc(32), Buffer.from(infoStr), 112));
                } else {
                    hkdfKey = await new Promise((res, rej) =>
                        crypto.hkdf('sha256', mediaKeyBuf, Buffer.alloc(32), Buffer.from(infoStr), 112,
                            (e, k) => e ? rej(e) : res(Buffer.from(k)))
                    );
                }

                const iv = hkdfKey.slice(0, 16);
                const cipherKey = hkdfKey.slice(16, 48);
                const ciphertext = encryptedBuf.slice(0, encryptedBuf.length - 10);

                const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
                decipher.setAutoPadding(true);
                const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

                console.log(`[MEDIA] AES decrypt OK: ${decrypted.length} bytes.`);
                return {
                    data: decrypted.toString('base64'),
                    mimetype: blobResult.mimetype || 'image/jpeg',
                    filename: blobResult.filename || null
                };
            } catch (e3) {
                console.error('[MEDIA] CDN fetch/decrypt failed:', e3 && (e3.message || String(e3)));
            }
        } else if (blobResult) {
            console.warn('[MEDIA] Browser returned:', JSON.stringify(blobResult));
        }

    } catch (e2) {
        console.warn('[MEDIA] Browser blob evaluation failed:', e2 && (e2.message || String(e2)));
    }

    return null;
}

console.log('--------------------------------------------------');
console.log(`Starting ${BOT_NAME} on WhatsApp Web (Multi-Device)...`);
console.log(`Active Brain: ${AI_PROVIDER.toUpperCase()} (${AI_PROVIDER === 'deepseek' ? DEEPSEEK_MODEL : (AI_PROVIDER === 'gemini' ? GEMINI_MODEL : HERMES_MODEL)})`);
console.log('--------------------------------------------------');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
    (fs.existsSync('/usr/local/bin/google-chrome-stable') ? '/usr/local/bin/google-chrome-stable' :
    (fs.existsSync('/home/sgarm/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome') ? '/home/sgarm/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome' : undefined));

// A previous Chrome still running on the same profile corrupts the WhatsApp login (WhatsApp then logs the device out),
// so stop any leftover instance before starting a new one.
try {
    require('child_process').execFileSync('pkill', ['-f', '--', `--user-data-dir=${path.join(__dirname, '.wwebjs_auth', 'session')}`], { stdio: 'ignore' });
    console.log('[CLEANUP] Stopped a leftover Chrome using the WhatsApp profile');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
} catch (_) { /* none running */ }

// Clean up any stale Chromium locks left from previous restarts/crashes
const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
['SingletonLock', 'SingletonSocket', 'SingletonCookie'].forEach(f => {
    try {
        const p = path.join(sessionDir, f);
        if (fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) {
            fs.unlinkSync(p);
            console.log(`[CLEANUP] Removed stale ${f}`);
        }
    } catch(e) {}
});

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    puppeteer: {
        headless: true,
        dumpio: true,
        protocolTimeout: 180000,
        executablePath: CHROME_PATH,
        args: [
            '--disable-breakpad',
            '--disable-crash-reporter',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--password-store=basic',
            '--use-mock-keychain'
        ]
    }
});

client.on('qr', async (qr) => {
    clientStatus = 'QR_READY';
    currentQR = qr;
    console.log('\n================== SCAN THIS QR CODE ==================');
    console.log('Open WhatsApp on your phone -> Settings -> Linked Devices -> Link a Device:\n');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('RAW_QR:' + qr);
    console.log('========================================================\n');
    try {
        currentQRDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
        currentQRSVG = await QRCode.toString(qr, { type: 'svg', margin: 2 });
        fs.writeFileSync('/home/ubuntu/hermes-whatsapp-agent/current_qr.txt', qr);
        fs.writeFileSync('/home/ubuntu/hermes-whatsapp-agent/current_qr.svg', currentQRSVG);
    } catch (err) {
        console.error('Error generating QR image:', err);
    }
});

client.on('ready', async () => {
    clientStatus = 'CONNECTED';
    console.log(`\n[SUCCESS] ${BOT_NAME} is connected and actively listening for WhatsApp messages 24/7!`);
    try {
        await client.sendPresenceUnavailable();
        console.log('[PRESENCE] WhatsApp presence set to UNAVAILABLE (anti-ban reactive mode).');
    } catch(e) {}
    setTimeout(() => reportBot.resolveMemberLids().catch(e => console.warn('[REPORT BOT] id lookup failed:', e.message)), 20000);
});

// Reactive presence: stop typing indicator and go offline right after a reply is sent.
async function goOffline(chat) {
    if (chat && chat.clearState) await chat.clearState().catch(() => {});
    try { await client.sendPresenceUnavailable(); } catch(e) {}
}

// Health check watchdog: detects genuine browser disconnects.
let watchdogFailCount = 0;
const WATCHDOG_MAX_FAILURES = 10;

setInterval(async () => {
    if (clientStatus !== 'CONNECTED') {
        watchdogFailCount = 0;
        return;
    }
    try {
        if (!client.pupBrowser || !client.pupBrowser.isConnected()) {
            throw new Error('Chromium browser disconnected');
        }
        const pages = await client.pupBrowser.pages().catch(() => []);
        const activePage = pages.find(p => !p.isClosed() && p.url().includes('whatsapp.com'));
        if (!activePage) {
            throw new Error('No active WhatsApp page found');
        }
        if (client.pupPage !== activePage) {
            client.pupPage = activePage;
        }
        if (watchdogFailCount > 0) {
            console.log(`[WATCHDOG] Connection verified. Counter reset.`);
            watchdogFailCount = 0;
        }
    } catch(err) {
        watchdogFailCount++;
        console.warn(`[WATCHDOG] Warning #${watchdogFailCount}/${WATCHDOG_MAX_FAILURES}: ${err.message}`);
        if (watchdogFailCount >= WATCHDOG_MAX_FAILURES) {
            console.error('[WATCHDOG] Confirmed connection loss. Triggering clean restart...');
            process.exit(1);
        }
    }
}, 30000);

client.on('authenticated', () => {
    clientStatus = 'AUTHENTICATED';
    console.log('[AUTH] WhatsApp session authenticated successfully.');
});

client.on('auth_failure', (msg) => {
    clientStatus = 'AUTH_FAILURE';
    console.error('[AUTH ERROR] Authentication failure:', msg);
});

// Graceful shutdown (pm2 restart/stop): let WhatsApp Web close and flush the saved login before exiting
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[SHUTDOWN] ${sig} received, closing WhatsApp client...`);
        try { await Promise.race([client.destroy(), new Promise(r => setTimeout(r, 6000))]); } catch (_) { /* ignore */ }
        process.exit(0);
    });
}

client.on('disconnected', (reason) => {
    clientStatus = 'DISCONNECTED';
    console.warn('[DISCONNECTED] Client was disconnected:', reason);
});

// ─── PROACTIVE SCHEDULER: DISABLED ───
// All automated/scheduled proactive messages (6:00 AM morning & 3:00 PM lunch) have been completely removed.
// The bot now operates strictly in reactive mode: it ONLY replies when messages are received.

const pendingBuffers = new Map(); // sender -> { timeout, texts: [], lastMsg }
const lastMediaStore = new Map();  // sender -> { storageInfo, timestamp } — remembers last upload for 10 minutes

// Per-chat sequential queue: burst uploads (e.g. 6 photos) are processed fully and in order, never in parallel.
const enqueueChatTask = createSequentialQueue();
const seenMessageIds = new Set();

// Your own messages (e.g. the broadcast you send to yourself) do not trigger 'message', only 'message_create'
client.on('message_create', (msg) => {
    try { if (msg && msg.fromMe) broadcaster.record(msg); } catch (_) { /* ignore */ }
});

client.on('message', (msg) => {
    if (!msg || !msg.from) return;
    const msgId = msg.id && msg.id._serialized;
    if (msgId) {
        if (seenMessageIds.has(msgId)) return; // duplicate event -> no duplicate reply
        seenMessageIds.add(msgId);
        if (seenMessageIds.size > 500) seenMessageIds.delete(seenMessageIds.values().next().value);
    }
    // While /broadcast is waiting for the message, the owner's next message (text/video/photo) is the broadcast itself
    if (!msg.fromMe && broadcaster.isAwaiting(msg.from) && broadcaster.collect(msg)) return;
    // Remember what the owner sends (text, video, photo) so /broadcast can forward it later
    if (!msg.fromMe && ['254975783530728@lid', '257487752175866@lid', '918529911832@c.us', '918058363027@c.us'].includes(msg.from)) {
        broadcaster.record(msg);
    }
    // Photos/documents are buffered per sender so a burst gets ONE combined reply.
    if (!msg.fromMe && msg.hasMedia && ['image', 'document'].includes(msg.type)) {
        bufferMediaBurst(msg);
        return;
    }
    // Follow-up text while photos are still buffering: attach it to the burst as the guiding question
    // (instant commands like reset/help still run immediately).
    if (!msg.fromMe && !msg.hasMedia && msg.body && mediaBursts.has(msg.from) && !isInstantCommand(msg.body)) {
        const burst = mediaBursts.get(msg.from);
        burst.query = burst.query ? `${burst.query} ${msg.body}` : msg.body;
        scheduleBurstFlush(msg.from, burst);
        return;
    }
    enqueueChatTask(msg.from, () => handleIncomingMessage(msg)).catch(err => {
        console.error('[QUEUE] Message handler failed:', err && (err.stack || err.message || err));
    });
});

// ─── MEDIA BURST DEBOUNCER: sender -> { msgs, timer } ───
const MEDIA_BURST_DEBOUNCE_MS = 2500;
const mediaBursts = new Map();

const RESET_RE = /^\s*(\/?reset|clear(\s+all)?|restart|clean|forget|new\s*chat|nayi\s*shuruat|bhool\s*jao)[.!?,]*\s*$/i;
const DRIVE_RE = /^\s*(\/?drive|\/?vault|gdrive|cloud\s*vault)[.!?,]*\s*$/i;
const HELP_RE = /^\s*(\/?help|\/?commands?|\/?menu)[.!?,]*\s*$/i;
const STATUS_RE = /^\s*(\/?status|\/?ping|\/?health)[.!?,]*\s*$/i;
const DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/1g_P5pR04n6VDqO1iZQGYfJf-Pvj8T05r';

function isInstantCommand(text) {
    return [RESET_RE, DRIVE_RE, HELP_RE, STATUS_RE, /^\s*\/(broadcast|confirm|cancel|report|done)\b/i].some(re => re.test(text || ''));
}

function formatUptime(totalSeconds) {
    const s = Math.floor(totalSeconds);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return `${d ? d + 'd ' : ''}${h}h ${m}m`;
}

function scheduleBurstFlush(sender, burst) {
    clearTimeout(burst.timer);
    burst.timer = setTimeout(() => {
        mediaBursts.delete(sender);
        const msgs = burst.msgs;
        const query = burst.query || '';
        const task = msgs.length === 1
            ? () => handleIncomingMessage(msgs[0], { query })
            : () => handleIncomingMessage(msgs[msgs.length - 1], { burst: msgs, query });
        enqueueChatTask(sender, task).catch(err => {
            console.error('[QUEUE] Media burst handler failed:', err && (err.stack || err.message || err));
        });
    }, MEDIA_BURST_DEBOUNCE_MS);
}

function bufferMediaBurst(msg) {
    const sender = msg.from;
    let burst = mediaBursts.get(sender);
    if (!burst) {
        burst = { msgs: [], timer: null, query: '' };
        mediaBursts.set(sender, burst);
    }
    burst.msgs.push(msg);
    scheduleBurstFlush(sender, burst);
}

// Downloads, vaults and analyzes one burst item; never throws so Promise.all can't fail the whole burst.
async function processBurstItem(m, sender) {
    try {
        const media = await withTimeout(robustDownloadMedia(client, m), 45000, 'Media download', null);
        const caption = (m.body || '').trim();
        if (!media || !media.data) return { desc: '[media could not be downloaded]', storageInfo: null };
        const storageInfo = await withTimeout(saveMediaToCloudStorage(media.data, media.mimetype, sender, media.filename), 30000, 'Cloud vault save', null);
        let desc;
        if ((media.mimetype || '').toLowerCase().startsWith('image/')) {
            desc = await withTimeout(getImageVisionDescription(media.data, media.mimetype), 35000, 'Vision analysis',
                '[IMAGE RECEIVED]: vision analysis timed out.');
        } else {
            desc = await withTimeout(describeDocument(media.data, media.mimetype, media.filename, storageInfo?.cosSignedUrl || null), 120000, 'Document extraction', null)
                || `[DOCUMENT]: "${media.filename || 'Document'}" (${media.mimetype}) received and archived (no readable text found).`;
        }
        if (caption) desc += `\n[USER CAPTION ON THIS ITEM]: "${caption}"`;
        return { desc, storageInfo };
    } catch (err) {
        console.error('[BURST ITEM ERROR]:', err && (err.message || err));
        return { desc: '[media processing failed]', storageInfo: null };
    }
}

// ─── Mizoram Bonanza report assistant (/report): report-only, members of the Mizoram Bonanza list ───
async function extractReportText(media) {
    const mime = (media.mimetype || '').toLowerCase();
    if (mime.startsWith('image/')) {
        const viaTencent = TENCENT_OCR_ENABLED ? await tencentOcrRaw(media.data) : null;
        if (viaTencent && viaTencent.length > 10) return viaTencent;
        const viaTesseract = await analyzeImageWithTesseract(media.data);
        return viaTesseract ? viaTesseract.replace(/^\[[^\]]*\]:\n?/, '') : null;
    }
    if (mime.includes('pdf') || /\.pdf$/i.test(media.filename || '')) {
        return extractDocumentText(media.data, media.mimetype, media.filename, null); // in memory only, never stored
    }
    return null;
}

const reportBotDeps = {
    client,
    generateAIReply,
    chatHistory,
    sanitizeWhatsAppReply,
    extractReportText,
    buildReportGuidance,
    diseaseGuide,
    REPORT_MARK,
    downloadMedia: (m) => withTimeout(robustDownloadMedia(client, m), 45000, 'Media download', null),
    // members' report files (jpg/png/pdf) are archived in the Tencent COS vault under report_<name>_<id>
    saveToVault: (media, who) => saveMediaToCloudStorage(media.data, media.mimetype, `report_${who}`, media.filename || null)
};
let reportBot = require('./reportBot').createReportBot(reportBotDeps);

// Mail assistant (mailAssistant.js): drafts persist in data/mail-state.json, so a reload or restart keeps them
const mailDeps = {
    generateAIReply,
    chatHistory,
    sendEmail,
    // vault file -> real mail attachment
    fetchFile: async (key) => {
        const r = await fetch(signedCosUrl(key), { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`storage HTTP ${r.status}`);
        return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || '' };
    },
    fromAddress: GMAIL_USER,
    ownerName: 'Roshan'
};
let mailAssistant = require('./mailAssistant').createMailAssistant(mailDeps);
mailAssistant.seedFromShortLinks(shortLinks, PUBLIC_BASE_URL);
function reloadMailAssistant() {
    delete require.cache[require.resolve('./mailAssistant')];
    mailAssistant = require('./mailAssistant').createMailAssistant(mailDeps);
    console.log('[MAIL] Reloaded.');
}
// Swap in new reportBot.js code without restarting (a restart kills the WhatsApp browser and can unlink the session)
function reloadReportBot() {
    const old = reportBot;
    delete require.cache[require.resolve('./reportBot')];
    const fresh = require('./reportBot').createReportBot(reportBotDeps);
    fresh.setSessions(old.getSessions());
    old.stop();
    reportBot = fresh;
    fresh.resolveMemberLids().catch(e => console.warn('[REPORT BOT] id lookup failed:', e.message));
    console.log('[REPORT BOT] Reloaded.');
}

const ADMIN_TOKEN_PATH = path.join(__dirname, 'data', 'admin-token.txt');
let ADMIN_TOKEN = '';
try { ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_PATH, 'utf8').trim(); } catch (_) { /* generate below */ }
if (!ADMIN_TOKEN) {
    ADMIN_TOKEN = require('crypto').randomBytes(16).toString('base64url');
    try { fs.mkdirSync(path.dirname(ADMIN_TOKEN_PATH), { recursive: true }); fs.writeFileSync(ADMIN_TOKEN_PATH, ADMIN_TOKEN, { mode: 0o600 }); } catch (e) { console.warn('[ADMIN] could not persist token:', e.message); }
}
const broadcaster = require('./broadcast').createBroadcaster({
    client,
    MessageMedia: require('whatsapp-web.js').MessageMedia,
    downloadMedia: (m) => withTimeout(robustDownloadMedia(client, m), 60000, 'Media download', null),
    listMembers: () => reportBot.listMembers()
});

async function handleIncomingMessage(msg, opts = {}) {
    if (msg.from === 'status@broadcast') return;
    if (msg.from.endsWith('@g.us')) return;
    if (msg.fromMe) return;

    const hasMedia = Boolean(msg.hasMedia);
    // opts.query = follow-up text typed while the media burst was still buffering
    const incomingText = [(msg.body || '').trim(), (opts.query || '').trim()].filter(Boolean).join(' ');
    if (!hasMedia && incomingText.length === 0) return;

    const sender = msg.from;

    // ─── STRICT WHITELIST: Only reply to known contacts ───
    const allowedLIDs = [
        '257487752175866@lid', // User Tester (8058363027 / Jhotwara Wellness)
        '254975783530728@lid', // Roshan Airtel
        '237413007929354@lid'  // Dilip Singh (father)
    ];
    const allowedNumbers = [
        '8529911832', '918529911832', // Roshan
        '9549477444', '919549477444', // Dilip Singh (father)
        '7976765590', '917976765590', // Mother
        '8058363027', '918058363027'  // Whitelisted user
    ];

    let contactNum = '';
    let contactName = '';
    let chatTitle = '';

    try {
        const chat = await msg.getChat();
        chatTitle = chat.name || chat.formattedTitle || '';
    } catch(e) {}

    try {
        const contact = await msg.getContact();
        contactName = contact.name || contact.pushname || '';
        contactNum = (contact.number || contact.id?.user || '').replace(/[^\d]/g, '');
    } catch(e) {}

    if (!contactNum && sender.endsWith('@lid')) {
        try {
            const res = await client.getContactLidAndPhone(sender);
            if (res && res[0] && res[0].pn) {
                contactNum = res[0].pn.replace(/[^\d]/g, '');
            }
        } catch(e) {}
    }

    // Identity is decided ONLY by phone number / WhatsApp id. Names (WhatsApp profile names are chosen by the sender) never grant access.
    // OWNER of Hermes: +91 8058363027 (the only person with owner powers: full assistant, /broadcast, email, drive, admin).
    const isOwner = sender === '257487752175866@lid' ||
                    sender.includes('8058363027') ||
                    contactNum.includes('8058363027');
    const isRoshan = isOwner;   // owner persona/prompt (name kept for the existing code paths)

    const isDilip = sender === '237413007929354@lid' ||
                    sender.includes('9549477444') ||
                    contactNum.includes('9549477444');

    const isMother = sender.includes('7976765590') ||
                     contactNum.includes('7976765590');

    const isUserTester = isOwner;

    const isAllowed = isOwner || isDilip || isMother;

    // Owner-only: whitelist commands live in reportBot.js (hot-reloadable): "add <number> [as Name] to the whitelist", or a contact card then "whitelist"
    if (isOwner && !hasMedia && incomingText && await reportBot.ownerText(msg, incomingText)) {
        await goOffline(null);
        return;
    }

    // Owner-only broadcast to the Mizoram Bonanza members (/broadcast -> preview, /confirm -> send, /cancel)
    const isOwnerStrict = isOwner;
    if (isOwnerStrict && !hasMedia && broadcaster.isCommand(incomingText) &&
        (!/^\/cancel\b/i.test(incomingText.trim()) || broadcaster.hasActive())) {
        await broadcaster.handle(msg, sender, incomingText);
        await goOffline(null);
        return;
    }

    // Report assistant: members of the Mizoram Bonanza list get ONLY this (strict guard rail); the owner's contacts
    // can try it with /report and stay in it until /done or the session expires.
    // contactNum falls back to the id's own digits when WhatsApp hides the phone number, so only learn a real, different number
    if (sender.endsWith('@lid') && contactNum && contactNum !== sender.split('@')[0]) reportBot.learnLid(sender, contactNum);
    const reportMember = !isOwner && reportBot.isMember(contactNum, sender);
    if (reportMember || (isAllowed && (/^\/report\b/i.test(incomingText) || reportBot.hasSession(sender)))) {
        await reportBot.handle(msg, { sender, phone: contactNum, incomingText, hasMedia, items: opts.burst || [msg] });
        await goOffline(null);
        return;
    }

    if (!isAllowed) {
        console.log(`[FILTERED / IGNORED]: Message from ${sender} (Chat: "${chatTitle}", Contact: "${contactName}") - Not in allowed whitelist.`);
        return;
    }

    // ─── INSTANT RESET: zero LLM, zero media processing ───
    if (!hasMedia && RESET_RE.test(incomingText)) {
        chatHistory.delete(sender);
        mailAssistant.dropDraft(sender);
        lastMediaStore.delete(sender);
        await msg.reply('🧹');
        await goOffline(null);
        return;
    }
    if (!hasMedia && DRIVE_RE.test(incomingText)) {
        await msg.reply(`📁 *Your Cloud Vault*\n${COS_ENABLED ? VAULT_URL : DRIVE_FOLDER_URL}`);
        await goOffline(null);
        return;
    }
    if (!hasMedia && HELP_RE.test(incomingText)) {
        await msg.reply(
            `🤖 *Hermes Command Cheat Sheet*\n\n` +
            `⚡ *Instant commands*\n` +
            `• *reset* / clear / new chat — wipe chat memory\n` +
            `• *drive* / vault — open your Google Drive vault\n` +
            `• *status* / ping — uptime & services\n` +
            `• *help* / menu — this list\n\n` +
            `📸 *Photos & documents*\n` +
            `• Send one or many — I reply with one summary card\n` +
            `• Add a question right after (e.g. "total kitna hai?") and I'll answer it\n` +
            `• Say *save to drive* to get the vault links\n\n` +
            `✉️ *Email*\n` +
            `• "Email <name> about ..." — I draft it and ask you to confirm before sending`);
        await goOffline(null);
        return;
    }
    if (!hasMedia && STATUS_RE.test(incomingText)) {
        const primary = AI_PROVIDER === 'gemini' ? `Gemini (${GEMINI_MODEL})`
            : AI_PROVIDER === 'hermes' ? `Hermes (${HERMES_MODEL})`
            : `DeepSeek (${DEEPSEEK_MODEL})`;
        const yn = ok => ok ? '✅' : '❌';
        await msg.reply(
            `🟢 *Hermes is online*\n\n` +
            `⏱ Uptime: ${formatUptime(process.uptime())}\n` +
            `🧠 AI: ${primary}${GEMINI_API_KEY && AI_PROVIDER !== 'gemini' ? ` → backup Gemini (${GEMINI_MODEL})` : ''}\n\n` +
            `*Services*\n` +
            `${yn(true)} WhatsApp\n` +
            `${yn(DEEPSEEK_API_KEY)} DeepSeek\n` +
            `${yn(GEMINI_API_KEY)} Gemini\n` +
            `${yn(GOOGLE_VISION_API_KEY)} Cloud Vision\n` +
            `${yn(googleDriveKey)} Google Drive vault\n` +
            `${yn(COS_ENABLED || GCS_BUCKET_NAME)} Cloud Storage (${COS_ENABLED ? 'Tencent COS' : 'Google'})`);
        await goOffline(null);
        return;
    }

    // ─── QUOTED / REPLIED MESSAGE CONTEXT (User slid/swiped right on a previous message) ───
    let quotedContext = '';
    let quotedBody = '';
    if (msg.hasQuotedMsg) {
        try {
            const quoted = await withTimeout(msg.getQuotedMessage(), 6000, 'Quoted message fetch', null);
            if (quoted) {
                const isBot = quoted.fromMe;
                const senderLabel = isBot ? (BOT_NAME || 'Hermes AI') : (isRoshan ? 'Roshan' : 'User');
                quotedBody = (quoted.body || '').trim();
                if (quoted.hasMedia && !quotedBody) {
                    quotedBody = `[${quoted.type || 'media'} attachment]`;
                }
                if (quotedBody) {
                    const cleanQuoted = quotedBody.replace(/"""/g, "'''");
                    const truncatedQuoted = cleanQuoted.length > 12000 ? cleanQuoted.slice(0, 12000) + '… [truncated]' : cleanQuoted;
                    quotedContext = `[REPLIED-TO / QUOTED MESSAGE (The user specifically slid/replied to this message)]:\n` +
                        `From: ${senderLabel}\n` +
                        `Content: """\n${truncatedQuoted}\n"""`;
                    console.log(`[QUOTED MESSAGE] Attached quoted context from ${senderLabel} (~${truncatedQuoted.length} chars)`);
                }
            }
        } catch (quotedErr) {
            console.warn('[QUOTED MESSAGE WARN]:', quotedErr && (quotedErr.message || quotedErr));
        }
    }

    let customPrompt = null;
    if (isRoshan) {
        customPrompt = OWNER_PROMPT;
    } else if (isDilip) {
        customPrompt = `You are replying on behalf of Roshan to Dilip Singh (+91 9549477444) on WhatsApp.

CRITICAL INSTRUCTIONS:
1. Tone: Strictly formal, polite, respectful, and professional. Use respectful Hindi/English ("aap", "ji").
2. Never use any informal words, slang, casual banter, teasing, emojis, or sweet nicknames.
3. Content: Keep answers concise, formal, and helpful. If he is asking for Roshan or needs something, politely let him know that his message has been noted and Roshan will connect with him shortly.
4. WhatsApp Length: 1 to 2 short formal sentences maximum.`;
    } else if (isMother) {
        customPrompt = `You are replying on behalf of Roshan to his Mother (+91 7976765590) on WhatsApp.

CRITICAL INSTRUCTIONS:
1. Tone: Warm, loving, respectful, and caring. Use respectful Hindi/English ("aap", "ji", "maa").
2. Never use informal slang, teasing, or casual banter. Be gentle, polite, and affectionate like a good son.
3. Content: Keep replies concise, kind, and helpful. If she is asking about Roshan or something he needs to handle, let her know the message has been noted and Roshan will call or respond to her soon.
4. WhatsApp Length: 1 to 2 short warm sentences maximum.`;
    }

    // ─── MULTI-PHOTO BURST: analyze all in parallel, reply ONCE with a combined card ───
    if (opts.burst && opts.burst.length > 1) {
        const burst = opts.burst;
        console.log(`[BURST] Aggregating ${burst.length} media items from ${sender}...`);
        const results = await Promise.all(burst.map(m => processBurstItem(m, sender)));

        const lastStored = [...results].reverse().find(r => r.storageInfo);
        const urls = results.map(r => r.storageInfo && (r.storageInfo.driveUrl || r.storageInfo.gcsUrl)).filter(Boolean);
        if (lastStored) lastMediaStore.set(sender, { storageInfo: lastStored.storageInfo, urls, timestamp: Date.now() });

        const userQuestion = incomingText
            ? `\nThe user also asked: "${incomingText}" — answer it directly about these items in the Combined Takeaway.\n`
            : '';
        const itemsText = results.map((r, i) => `--- ITEM ${i + 1} ---\n${r.desc}`).join('\n\n');
        const burstPrompt = (quotedContext ? `${quotedContext}\n(Note: The user specifically replied/slid on the above message along with these new items. Answer in reference to both!)\n\n` : '') +
            `[MEDIA BURST: ${burst.length} photos/documents received at once]\n${itemsText}\n${userQuestion}\n` +
            `Reply with ONE combined WhatsApp card covering all ${burst.length} items (max ~200 words, never paste raw OCR, *single asterisks* only):\n` +
            `📸 *Received ${burst.length} Photos / Documents*\n` +
            `• *Item 1:* <key details/figures>\n` +
            `• *Item 2:* <key details/figures>\n` +
            `... one line per item through Item ${burst.length}\n\n` +
            `👉 *Combined Takeaway:* <one consolidated conclusion or action>`;

        try {
            const chat = await msg.getChat().catch(() => null);
            if (chat && chat.sendStateTyping) await chat.sendStateTyping().catch(() => {});
            const timeContext = getCurrentISTContext();
            const reply = sanitizeWhatsAppReply(await generateAIReply(sender, /\[DOCUMENT TEXT EXTRACTED/.test(burstPrompt) ? burstPrompt + DOC_DETAIL_INSTRUCTION : burstPrompt, (customPrompt || SYSTEM_PROMPT) + timeContext, /\[DOCUMENT TEXT EXTRACTED/.test(burstPrompt) ? REPLY_MAX_TOKENS_DOC : 500));
            console.log(`[BURST REPLY to ${sender}]: ${reply}`);
            let finalReply = reply;
            if (urls.length && /\b(save|store|upload|backup|daal|rakh)\b.{0,40}\b(drive|gdrive|vault|cloud)\b/i.test(opts.query || '')) {
                finalReply += `\n\n✅ Saved ${urls.length} files to your Cloud Vault:\n` + urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
            }
            await msg.reply(finalReply);
            await goOffline(chat);
        } catch (err) {
            console.error('[BURST REPLY ERROR]:', err);
            await goOffline(null);
        }
        return;
    }

    // ─── MULTI-MEDIA ENGINE: Vision, Speech-to-Text & Cloud Storage Vault ───
    let mediaContext = '';
    let storageInfo = null;

    if (hasMedia) {
        try {
            console.log(`[MEDIA] Downloading media attachment from ${sender}...`);
            const media = await withTimeout(robustDownloadMedia(client, msg), 45000, 'Media download', null);
            if (media && media.data) {
                const mime = (media.mimetype || '').toLowerCase();
                const isImage = mime.startsWith('image/');
                const isAudio = mime.startsWith('audio/') || msg.type === 'ptt' || msg.type === 'audio';
                const isDoc = !isImage && !isAudio;

                // 1. Google Cloud Storage Vault: Save backup
                storageInfo = await withTimeout(saveMediaToCloudStorage(media.data, media.mimetype, sender, media.filename), 30000, 'Cloud vault save', null);

                // 2. Intelligent Multimodal Processing
                if (isImage) {
                    console.log(`[VISION] Analyzing image (${media.mimetype}, ~${Math.round(media.data.length / 1024)} KB) with Vision Engine...`);
                    mediaContext = await withTimeout(getImageVisionDescription(media.data, media.mimetype), 35000, 'Vision analysis',
                        '[IMAGE RECEIVED]: An image file was received, but vision analysis timed out.');
                    console.log(`[VISION RESULT]:\n${mediaContext}`);
                } else if (isAudio) {
                    console.log(`[SPEECH] Transcribing voice note (${media.mimetype}, ~${Math.round(media.data.length / 1024)} KB) with Speech-to-Text API...`);
                    mediaContext = await withTimeout(getAudioTranscription(media.data, media.mimetype), 40000, 'Audio transcription',
                        '[VOICE NOTE RECEIVED]: A voice note was received, but transcription timed out.');
                    console.log(`[SPEECH RESULT]:\n${mediaContext}`);
                } else if (isDoc) {
                    const docName = media.filename || 'Document';
                    console.log(`[DOCUMENT] Received document/file: "${docName}" (${media.mimetype}).`);
                    const extractedDoc = await withTimeout(describeDocument(media.data, media.mimetype, docName, storageInfo?.cosSignedUrl || null), 120000, 'Document extraction', null);
                    if (extractedDoc) {
                        mediaContext = extractedDoc;
                    } else if (storageInfo && storageInfo.driveUrl) {
                        mediaContext = `[DOCUMENT RECEIVED & SAVED TO GOOGLE DRIVE]: A document named "${docName}" was received and successfully uploaded to Google Drive. Direct Link: ${storageInfo.driveUrl}`;
                    } else {
                        mediaContext = `[DOCUMENT RECEIVED]: A document named "${docName}" was received and securely archived in the Cloud Storage Vault.`;
                    }
                }

                if (/^\[(IMAGE RECEIVED|DOCUMENT TEXT EXTRACTED)/.test(mediaContext) && diseaseGuide.looksLikeMedicalReport(mediaContext)) {
                    const reportGuidance = await withTimeout(buildReportGuidance(mediaContext), 90000, 'Report guidance', null);
                    if (reportGuidance) mediaContext += `\n\n${reportGuidance}`;
                }

                if (storageInfo && storageInfo.driveUrl) {
                    mediaContext += `\n[GOOGLE DRIVE LINK]: ${storageInfo.driveUrl}`;
                } else if (storageInfo && storageInfo.gcsUrl) {
                    mediaContext += `\n[CLOUD STORAGE LINK]: ${storageInfo.gcsUrl}`;
                }

                if (storageInfo && storageInfo.fileName && mediaContext) mailAssistant.setFileText(sender, storageInfo.fileName, mediaContext);

                // Remember this upload and vision context for this sender for 10 minutes
                // so "save to drive" or "extract" sent as a separate follow-up message works
                lastMediaStore.set(sender, {
                    storageInfo,
                    mediaContext,
                    urls: [storageInfo?.driveUrl || storageInfo?.gcsUrl].filter(Boolean),
                    // kept so an "extract" follow-up can re-read a document whose text was not extracted yet
                    docInfo: isDoc && storageInfo?.cosSignedUrl ? { url: storageInfo.cosSignedUrl, mime: media.mimetype, name: media.filename || 'Document' } : null,
                    extracted: /^\[DOCUMENT TEXT EXTRACTED/.test(mediaContext),
                    timestamp: Date.now()
                });
                console.log(`[LAST MEDIA STORE] Cached media & vision analysis for ${sender} (driveUrl: ${storageInfo?.driveUrl || 'none'})`);
            } else {
                console.warn('[MEDIA WARNING]: downloadMedia() returned empty or undefined media.');
            }
        } catch (mediaErr) {
            console.error('[MEDIA/STORAGE ERROR]:', mediaErr && (mediaErr.stack || mediaErr.message || mediaErr));
        }
    }

    let finalPrompt = incomingText;
    if (mediaContext && mediaContext.includes(REPORT_MARK)) {
        finalPrompt = `${mediaContext}\n\n${incomingText ? `User text accompanying the report: "${incomingText}".` : '(No caption provided.)'} Follow the REPORT GUIDANCE RULES.`;
    } else if (mediaContext) {
        if (incomingText) {
            finalPrompt = `${mediaContext}\n\n${PHOTO_CARD_FORMAT}\n\nUser text accompanying the media: "${incomingText}". Please answer their question and extract all relevant details thoroughly.`;
        } else {
            finalPrompt = `${mediaContext}\n\n${PHOTO_CARD_FORMAT}\n\n(No caption provided. Provide a clean overview and extract key details, names, titles, and rules accurately.)`;
        }
    } else if (!hasMedia) {
        // Support follow-up questions / extraction on recently received media
        const cached = lastMediaStore.get(sender);
        const isRecentMedia = cached && cached.mediaContext && (Date.now() - cached.timestamp) < 15 * 60 * 1000;
        const isExtractionOrImageQuery = /\b(extract|read|transcribe|batao|kya hai|kya likha hai|padho|details|points|slide|text|nikalo|samjhao|explain|summary|what|who|kaun|kab|degree|act|rule|amount|rupee|photo|image|picture|pic|screenshot|screen)\b/i.test(incomingText) ||
            Boolean(quotedBody && /photo|image|attachment|📸|document|slide/i.test(quotedBody));

        if (isRecentMedia && isExtractionOrImageQuery) {
            if (cached.docInfo && !cached.extracted) {
                try {
                    console.log(`[DOCUMENT] Follow-up extraction for "${cached.docInfo.name}" - re-reading from cloud vault...`);
                    const resp = await fetch(cached.docInfo.url, { signal: AbortSignal.timeout(30000) });
                    if (!resp.ok) throw new Error(`vault download ${resp.status}`);
                    const buf = Buffer.from(await resp.arrayBuffer());
                    const extractedText = await withTimeout(describeDocument(buf.toString('base64'), cached.docInfo.mime, cached.docInfo.name, cached.docInfo.url), 120000, 'Document extraction', null);
                    if (extractedText) {
                        cached.mediaContext = `${extractedText}
[CLOUD STORAGE LINK]: ${cached.storageInfo?.gcsUrl || cached.docInfo.url}`;
                        cached.extracted = true;
                    }
                } catch (e) {
                    console.warn('[DOCUMENT] Follow-up extraction failed:', e.message);
                }
            }
            if (cached.mediaContext.includes(REPORT_MARK)) {
                finalPrompt = `${cached.mediaContext}\n\n[USER FOLLOW-UP ON THE REPORT ABOVE]:\n"${incomingText}"\n\nAnswer using the report, the matched guide data and the REPORT GUIDANCE RULES.`;
            } else
            finalPrompt = `${cached.mediaContext}\n\n[USER FOLLOW-UP ON THE RECENT IMAGE/DOCUMENT]:\n"${incomingText}"\n\n${PHOTO_CARD_FORMAT}\n\n[SYSTEM INSTRUCTION: The user is asking about or requesting extraction from the verified image/document above. Provide a thorough, accurate, and structured response addressing their query directly. If they asked to extract or transcribe, provide all slide/document contents cleanly and completely. Ignore any past assistant claims that the image was unreadable.]`;
        }
        if (finalPrompt === incomingText && DISEASE_QUERY_RE.test(incomingText)) {
            const hits = diseaseGuide.searchByText(incomingText, 2);
            if (hits.length) {
                console.log(`[DISEASE GUIDE] Typed query matched: ${hits.map(d => d.name).join(', ')}`);
                finalPrompt = `${REPORT_MARK}\n${diseaseGuide.guideContext(hits)}\n\n${REPORT_GUIDANCE_RULES}\n\n[USER MESSAGE]:\n"${incomingText}"\n(No lab report was shared; base the reply on the condition the user described. Skip the "Report summary" section.)`;
            }
        }
    } else if (hasMedia) {
        if (incomingText) {
            finalPrompt = `[MEDIA RECEIVED (Image/Audio)]: User sent a media file with caption: "${incomingText}".`;
        } else {
            finalPrompt = `[MEDIA RECEIVED (Image/Audio)]: User sent a media file (photo/voice note). Please respond naturally acknowledging that they shared media.`;
        }
    }

    if (quotedContext) {
        finalPrompt = `${quotedContext}\n\n[USER REPLY TO THE QUOTED MESSAGE ABOVE]:\n"${finalPrompt}"\n\n(IMPORTANT: The user specifically slid on / quoted the message above to reply directly to it. Answer their question or fulfill their request directly in reference to that quoted message!)`;
    }

    // ─── SAVE-TO-DRIVE / CLOUD VAULT INTENT: Short-circuit reply ───
    // Supports English & Hinglish: "save to drive", "save this", "drive me save kar do", "save kar lo", etc.
    const saveToDriveIntent = /\b(save|store|upload|add|put|backup|keep|daal|rakh)\b.{0,40}\b(drive|google drive|gdrive|vault|cloud)\b/i.test(incomingText) ||
                              /\b(drive|google drive|gdrive|vault|cloud)\b.{0,30}\b(save|store|upload|backup|daal|rakh|me)\b/i.test(incomingText) ||
                              /^(save|drive|store|vault|backup)\b/i.test(incomingText.trim()) ||
                              /\b(save\s*(it|this|that|screenshot|ss|photo|pic|image|file)?)\b/i.test(incomingText.trim());

    // Resolve which storageInfo to use: current message's media OR last cached media (within 10 min)
    let effectiveStorageInfo = storageInfo;
    let effectiveUrls = storageInfo ? [storageInfo.driveUrl || storageInfo.gcsUrl].filter(Boolean) : [];
    if (!effectiveStorageInfo && !hasMedia) {
        const cached = lastMediaStore.get(sender);
        if (cached && (Date.now() - cached.timestamp) < 10 * 60 * 1000) {
            effectiveStorageInfo = cached.storageInfo;
            effectiveUrls = cached.urls || (cached.storageInfo ? [cached.storageInfo.driveUrl || cached.storageInfo.gcsUrl].filter(Boolean) : []);
            console.log(`[CACHED MEDIA] Using cached storageInfo/urls (${effectiveUrls.length} file(s)) for ${sender} from ${Math.round((Date.now() - cached.timestamp)/1000)}s ago`);
        }
    }

    if (saveToDriveIntent && (hasMedia || effectiveStorageInfo)) {
        let directReply = '';
        if (effectiveUrls.length === 1) {
            directReply = `✅ Saved to your Cloud Vault!\n\n🔗 ${effectiveUrls[0]}`;
        } else if (effectiveUrls.length > 1) {
            directReply = `✅ Saved ${effectiveUrls.length} files to your Cloud Vault!\n\n` +
                effectiveUrls.map((u, i) => `${i + 1}. ${u}`).join('\n');
        } else if (effectiveStorageInfo && effectiveStorageInfo.saved) {
            directReply = `✅ Archived securely on the cloud server.`;
        } else {
            directReply = `⚠️ Couldn't find a recent screenshot or media file to save. Please send or resend the image!`;
        }
        console.log(`[SAVE-TO-DRIVE SHORTCUT] Sending reply: ${directReply.substring(0, 80)}`);
        try {
            const chat = await msg.getChat().catch(() => null);
            if (chat && chat.sendStateTyping) await chat.sendStateTyping().catch(() => {});
            await msg.reply(directReply);
            await goOffline(chat);
        } catch (err) {
            console.error('[SAVE-TO-DRIVE REPLY ERROR]:', err);
            await goOffline(null);
        }
        return;
    }

    // ─── MAIL (mailAssistant.js): drafts, edits, CC/BCC, attachments; sends only on an explicit "Yes" ───
    if (isAllowed && await mailAssistant.handle(msg, { sender, text: incomingText, quotedBody, newFileKey: hasMedia && storageInfo ? storageInfo.fileName : null })) {
        await goOffline(null);
        return;
    }

    console.log(`
[INCOMING from ${isDilip ? 'Dilip Singh (' + sender + ')' : sender}]: ${finalPrompt}`);

    // Context enrichment: IST Clock + Past Memory Graph
    const timeContext = getCurrentISTContext();
    const memoryContext = queryChatMemory(incomingText, { allowed: !hasMedia && !isDilip && !isMother });
    const fullPrompt = (customPrompt || SYSTEM_PROMPT) + timeContext + (memoryContext ? memoryContext : '');

    try {
        const chat = await msg.getChat().catch(() => null);
        if (chat && chat.sendStateTyping) {
            await chat.sendStateTyping().catch(() => {});
        }

        const isDocExtraction = /\[(DOCUMENT TEXT EXTRACTED|REPORT GUIDANCE)/.test(finalPrompt);
        // Replying to a long message, or asking to translate / transcribe / explain it, needs the full text, not a 350-token answer
        const longQuoted = Boolean(quotedBody) && !/^\[.+ attachment\]$/i.test(quotedBody) && quotedBody.length > 500;
        const wantsFullOutput = /(hindi|हिंदी|हिन्दी|translate|anuvad|transcribe|transcript|extract|in detail|full|poora|pura|vistar|explain|samjha)/i.test(incomingText);
        const fullQuotedReply = Boolean(quotedContext) && (longQuoted || wantsFullOutput);
        const promptToSend = isDocExtraction && !finalPrompt.includes(REPORT_MARK) ? finalPrompt + DOC_DETAIL_INSTRUCTION
            : fullQuotedReply ? finalPrompt + QUOTED_FULL_INSTRUCTION
            : finalPrompt;
        const replyTokens = fullQuotedReply ? REPLY_MAX_TOKENS_FULL : (isDocExtraction ? REPLY_MAX_TOKENS_DOC : REPLY_MAX_TOKENS);
        let reply = sanitizeWhatsAppReply(await generateAIReply(sender, promptToSend, fullPrompt, replyTokens));
        // A chat answer must never claim a mail went out (only mailAssistant sends mail)
        reply = mailAssistant.guardChatReply(sender, reply);
        console.log(`[REPLY to ${isDilip ? 'Dilip Singh (Formal)' : sender}]: ${reply}`);
        await msg.reply(reply);

        await goOffline(chat);
    } catch (err) {
        console.error('[REPLY ERROR]:', err);
        await goOffline(null);
    }
}


const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (pathname === '/pair-code') {
        let phone = (parsedUrl.query.phone || '918529911832').replace(/[^\d]/g, '');
        if (phone.length === 10) phone = '91' + phone;
        if (clientStatus === 'CONNECTED') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'WhatsApp is already linked. Log out first to pair another number.' }));
        }
        try {
            console.log(`[PAIRING CODE] Requesting fresh code for phone: ${phone}...`);
            const pairCode = await client.requestPairingCode(phone);
            console.log(`[PAIRING CODE] SUCCESS! Generated Code: ${pairCode}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, code: pairCode, phone: phone }));
        } catch (err) {
            console.warn('[PAIRING CODE] First attempt threw error (' + err.message + '), reloading page and retrying...');
            try {
                if (client.pupPage && !client.pupPage.isClosed()) {
                    await client.pupPage.reload({ waitUntil: 'domcontentloaded' });
                    await client.pupPage.waitForFunction(() => window.AuthStore && window.AuthStore.PairingCodeLinkUtils, { timeout: 15000 });
                    await new Promise(r => setTimeout(r, 1000));
                    const retryCode = await client.requestPairingCode(phone);
                    console.log(`[PAIRING CODE] RETRY SUCCESS! Code: ${retryCode}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, code: retryCode, phone: phone }));
                }
            } catch (re) {
                console.error('[PAIRING CODE RETRY FAILED]:', re.message);
            }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: (!err.message || err.message.length < 4) ? "WhatsApp rejected the pairing request (CompanionHelloError). Wait ~1 hour without retrying, or scan the QR code instead." : err.message }));
        }
    }

    // Admin channel (read the token over SSH from data/admin-token.txt)
    if (pathname.startsWith('/admin/')) {
        if (parsedUrl.query.t !== ADMIN_TOKEN) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Forbidden'); }
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        try {
            if (pathname === '/admin/reload-report') { reloadReportBot(); return send(200, { ok: true, members: reportBot.memberCount() }); }
            if (pathname === '/admin/reload-mail') { reloadMailAssistant(); return send(200, { ok: true }); }
            if (pathname === '/admin/chats') {
                const q = String(parsedUrl.query.q || '').toLowerCase();
                const chats = await client.getChats();
                return send(200, chats.filter(c => !c.isGroup && (c.name || '').toLowerCase().includes(q)).slice(0, 10).map(c => ({ id: c.id._serialized, name: c.name })));
            }
            if (pathname === '/admin/chat-info') {
                const chat = await client.getChatById(String(parsedUrl.query.chat));
                const msgs = await chat.fetchMessages({ limit: 15 });
                const now = Date.now() / 1000;
                return send(200, { total: msgs.length, messages: msgs.map(m => ({ type: m.type, fromMe: m.fromMe, quoted: !!m.hasQuotedMsg, hasMedia: !!m.hasMedia, ageMin: Math.round((now - m.timestamp) / 60), textLen: (m.body || '').length })) });
            }
            if (pathname === '/admin/diag-modules') {
                // lists WhatsApp Web module names containing a word (read-only)
                const q = String(parsedUrl.query.q || '').toLowerCase();
                const names = await client.pupPage.evaluate((needle) => {
                    try {
                        const dbg = window.require('__debug');
                        const map = (dbg && dbg.modulesMap) || {};
                        return Object.keys(map).filter(n => n.toLowerCase().includes(needle)).slice(0, 60);
                    } catch (e) { return ['ERR ' + String(e.message || e).slice(0, 100)]; }
                }, q);
                return send(200, names);
            }
            if (pathname === '/admin/diag-send3') {
                // the real broadcast send for ONE member, run inside the page so a failure returns the full in-page stack
                const phone = String(parsedUrl.query.phone || '').replace(/[^0-9]/g, '');
                const latest = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'broadcast-latest.json'), 'utf8'));
                const variant = String(parsedUrl.query.variant || '');
                const out = await client.pupPage.evaluate(async (num, media, caption, variant) => {
                    try {
                        const chat = await window.WWebJS.getChat(num + '@c.us', { getAsModel: false });
                        if (variant === 'a' && chat.id && typeof chat.id.isLid === 'function' && chat.id.isLid()) {
                            // build the message as a phone-number chat: sender = your phone-number id
                            Object.defineProperty(chat.id, 'isLid', { value: () => false, configurable: true });
                        }
                        if (variant === 'b') {
                            // make the "me" lookups all return the phone-number user
                            const U = window.require('WAWebUserPrefsMeUser');
                            const pn = U.getMaybeMePnUser();
                            window.__origMeLid = window.__origMeLid || U.getMaybeMeLidUser;
                            U.getMaybeMeLidUser = () => pn;
                        }
                        const msg = await window.WWebJS.sendMessage(chat, '', { media, caption });
                        return { ok: true, id: msg && msg.id && msg.id._serialized, variant };
                    } catch (e) {
                        return { ok: false, message: String(e && e.message || e), stack: String(e && e.stack || '').split(String.fromCharCode(10)).slice(0, 12).join(' <- ').slice(0, 1800) };
                    }
                }, phone, latest.media, latest.text, variant);
                return send(200, out);
            }
            if (pathname === '/admin/diag-me') {
                const out = await client.pupPage.evaluate(async () => {
                    const r = {};
                    const step = async (name, fn) => { try { const v = await fn(); r[name] = v === undefined ? 'undefined' : v; } catch (e) { r[name] = 'ERR: ' + String(e && e.message || e).slice(0, 140); } };
                    const U = window.require('WAWebUserPrefsMeUser');
                    await step('exports', async () => Object.keys(U).join(','));
                    await step('getMaybeMeLidUser', async () => { const x = U.getMaybeMeLidUser(); return x ? x._serialized : null; });
                    await step('getMaybeMePnUser', async () => { const x = U.getMaybeMePnUser(); return x ? x._serialized : null; });
                    for (const k of Object.keys(U)) {
                        if (/lid/i.test(k) && typeof U[k] === 'function' && k !== 'getMaybeMeLidUser') {
                            await step('call ' + k, async () => { const x = await U[k](); return x && x._serialized ? x._serialized : String(x).slice(0, 80); });
                        }
                    }
                    await step('Conn.lid', async () => { const c = window.require('WAWebConnModel').Conn; return c.lid ? (c.lid._serialized || String(c.lid)) : null; });
                    await step('Conn.wid', async () => { const c = window.require('WAWebConnModel').Conn; return c.wid ? c.wid._serialized : null; });
                    await step('Conn.platform', async () => window.require('WAWebConnModel').Conn.platform);
                    return r;
                });
                return send(200, out);
            }
            if (pathname === '/admin/diag-send2') {
                // runs the steps of WhatsApp Web's send routine for a number WITHOUT sending anything
                const phone = String(parsedUrl.query.phone || '').replace(/[^0-9]/g, '');
                const out = await client.pupPage.evaluate(async (num) => {
                    const r = {};
                    const step = async (name, fn) => { try { const v = await fn(); r[name] = v === undefined ? 'ok' : v; } catch (e) { r[name] = 'ERR: ' + String(e && e.message || e).slice(0, 160); } };
                    let wid, lidWid, chat;
                    await step('createWid', async () => { wid = window.require('WAWebWidFactory').createWid(num + '@c.us'); return wid._serialized; });
                    await step('enforceLidAndPn', async () => { const x = await window.WWebJS.enforceLidAndPnRetrieval(wid); lidWid = x.lid; return { lid: x.lid && x.lid._serialized }; });
                    await step('getChat(phone id)', async () => { chat = await window.WWebJS.getChat(num + '@c.us', { getAsModel: false }); return !!chat; });
                    await step('chat.id', async () => chat && chat.id && chat.id._serialized);
                    await step('getIsNewsletter', async () => window.require('WAWebChatGetters').getIsNewsletter(chat));
                    await step('getChat(lid id)', async () => { const c2 = await window.WWebJS.getChat(lidWid._serialized, { getAsModel: false }); return !!c2 && (c2.id && c2.id._serialized); });
                    await step('getChatModel', async () => { const m = await window.WWebJS.getChatModel(chat, { isChannel: false }); return !!m; });
                    await step('processMediaData', async () => {
                        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
                        const res = await window.WWebJS.processMediaData({ mimetype: 'image/png', data: png, filename: 'x.png' }, {});
                        return Object.keys(res || {}).join(',');
                    });
                    await step('meUser', async () => { const u = window.require('WAWebUserPrefsMeUser'); const me = (u.getMaybeMePnUser && u.getMaybeMePnUser()) || (u.getMaybeMeLidUser && u.getMaybeMeLidUser()); return me && me._serialized; });
                    return r;
                }, phone);
                return send(200, out);
            }
            if (pathname === '/admin/diag-send') {
                // step-by-step check of how WhatsApp Web resolves a phone number (no message is sent)
                const phone = String(parsedUrl.query.phone || '').replace(/[^0-9]/g, '');
                const out = await client.pupPage.evaluate(async (num) => {
                    const r = {};
                    const step = async (name, fn) => { try { const v = await fn(); r[name] = v === undefined ? 'ok(undefined)' : v; } catch (e) { r[name] = 'ERR: ' + String(e && e.message || e).slice(0, 140); } };
                    let wid;
                    await step('createWid', async () => { wid = window.require('WAWebWidFactory').createWid(num + '@c.us'); return wid && wid._serialized; });
                    await step('queryWidExists', async () => { const x = await window.require('WAWebQueryExistsJob').queryWidExists(wid); return x ? { wid: x.wid && x.wid._serialized, lid: x.lid && x.lid._serialized } : null; });
                    await step('enforceLidAndPn', async () => { const x = await window.WWebJS.enforceLidAndPnRetrieval(wid); return { lid: x.lid && x.lid._serialized, phone: x.phone && x.phone._serialized }; });
                    await step('chatInStore', async () => !!window.require('WAWebCollections').Chat.get(wid));
                    await step('findOrCreateLatestChat', async () => { const x = await window.require('WAWebFindChatAction').findOrCreateLatestChat(wid); return !!(x && x.chat); });
                    return r;
                }, phone);
                return send(200, out);
            }
            if (pathname === '/admin/broadcast/preview') return send(200, await broadcaster.adminPreview(String(parsedUrl.query.chat)));
            if (pathname === '/admin/broadcast/send') return send(200, await broadcaster.adminSend(String(parsedUrl.query.chat), parsedUrl.query.to ? String(parsedUrl.query.to) : null));
        } catch (e) { return send(500, { error: String(e.message || e) }); }
        return send(404, { error: 'unknown admin path' });
    }

    if (pathname === '/vault') {
        if (!COS_ENABLED || parsedUrl.query.t !== VAULT_TOKEN) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Forbidden');
        }
        try {
            const html = await renderVaultPage();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(html);
        } catch (e) {
            console.error('[VAULT PAGE ERROR]:', e.message);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Vault temporarily unavailable');
        }
    }

    if (pathname === '/vault/file') {
        const key = String(parsedUrl.query.k || '');
        if (!COS_ENABLED || parsedUrl.query.t !== VAULT_TOKEN || !key || key.includes('..')) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Forbidden');
        }
        return proxyCosObject(req, res, key);
    }

    if (pathname.startsWith('/f/')) {
        const key = shortLinks[pathname.slice(3)];
        if (!key || !COS_ENABLED) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Link not found');
        }
        return proxyCosObject(req, res, key);
    }

    if (pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: clientStatus, qr: currentQR, qrImg: currentQRDataUrl }));
    }

    if (pathname === '/qr.svg' && currentQRSVG) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(currentQRSVG);
    }

    if (pathname === '/api/send') {
        const to = parsedUrl.query.to || '';
        const text = parsedUrl.query.text || '';
        if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing text parameter' }));
        }
        try {
            await client.sendMessage(to, text);
            console.log(`[MANUAL / API SEND to ${to}]: ${text}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, to, text }));
        } catch(e) {
            console.error('[MANUAL / API SEND ERROR]:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (pathname === '/online') {
        try {
            const pages = client.pupBrowser ? await client.pupBrowser.pages() : [];
            const activePage = pages.find(p => !p.isClosed() && p.url().includes('whatsapp.com')) || client.pupPage;
            if (activePage && client.pupPage !== activePage) {
                client.pupPage = activePage;
            }
            if (activePage && !activePage.isClosed()) {
                // Anti-ban: never force focus/online events here; presence stays reactive.
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, status: clientStatus, presence: 'REACTIVE (offline unless replying)', time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) }));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (pathname === '/screenshot') {
        try {
            const pages = client.pupBrowser ? await client.pupBrowser.pages() : [];
            const page = pages.find(p => !p.isClosed() && p.url().includes('whatsapp.com')) || client.pupPage;
            if (page && !page.isClosed()) {
                const img = await page.screenshot({ type: 'png' });
                res.writeHead(200, { 'Content-Type': 'image/png' });
                return res.end(img);
            } else {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                return res.end('Puppeteer page not ready');
            }
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end(e.message);
        }
    }

    if (pathname === '/debug') {
        try {
            const pages = client.pupBrowser ? await client.pupBrowser.pages() : [];
            const info = [];
            for (let i = 0; i < pages.length; i++) {
                const p = pages[i];
                try {
                    info.push({
                        index: i,
                        closed: p.isClosed(),
                        url: p.url(),
                        title: p.isClosed() ? 'closed' : await p.title()
                    });
                } catch(pe) {
                    info.push({ index: i, error: pe.message });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ clientStatus, pagesCount: pages.length, pages: info }, null, 2));
        } catch(e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    if (pathname === '/api/messages') {
        try {
            if (clientStatus !== 'CONNECTED' && clientStatus !== 'AUTHENTICATED') {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'WhatsApp client not connected yet', status: clientStatus }));
            }

            const queryPhone = (parsedUrl.query.phone || parsedUrl.query.q || '').replace(/[^\d]/g, '');
            const days = parseInt(parsedUrl.query.days || '5', 10);
            console.log(`[API /messages] Extracting for phone='${queryPhone}', days=${days}`);

            const result = await client.pupPage.evaluate(async (phone, days) => {
                try {
                    const collections = window.require('WAWebCollections');
                    const ChatCollection = collections.Chat;
                    const ContactCollection = collections.Contact;
                    const WidFactory = window.require('WAWebWidFactory');

                    const allChats = ChatCollection.getModelsArray ? ChatCollection.getModelsArray() : [];
                    const allContacts = ContactCollection?.getModelsArray ? ContactCollection.getModelsArray() : [];

                    let matchedContact = null;
                    let targetChat = null;

                    if (phone && allContacts.length > 0) {
                        matchedContact = allContacts.find(c => {
                            const num = c.number || (c.id && (c.id.user || c.id._serialized)) || '';
                            const phoneStr = c.phoneNumber || '';
                            const name = c.name || c.__x_name || c.pushname || '';
                            return String(num).includes(phone) || String(phoneStr).includes(phone) || String(name).includes(phone);
                        });
                    }

                    if (phone) {
                        targetChat = allChats.find(c => {
                            const idStr = (c.id && (c.id._serialized || c.id.user)) || '';
                            const nameStr = c.name || c.__x_name || c.formattedTitle || '';
                            const contactName = c.contact?.name || c.contact?.pushname || c.contact?.number || '';
                            return String(idStr).includes(phone) || String(nameStr).includes(phone) || String(contactName).includes(phone);
                        });
                    }

                    if (!targetChat && matchedContact) {
                        const contactId = matchedContact.id;
                        const lid = matchedContact.lid;
                        targetChat = allChats.find(c => {
                            const cId = c.id?._serialized;
                            return cId === contactId?._serialized || (lid && cId === lid?._serialized);
                        });
                    }

                    if (!targetChat && phone) {
                        try {
                            const wid = WidFactory.createWid(`${phone}@c.us`);
                            targetChat = ChatCollection.get(wid);
                            if (!targetChat) {
                                const findAction = window.require('WAWebFindChatAction');
                                if (findAction?.findOrCreateLatestChat) {
                                    const res = await findAction.findOrCreateLatestChat(wid);
                                    targetChat = res?.chat || res;
                                }
                            }
                        } catch(e) {}
                    }

                    const shortPhone = phone.length > 10 ? phone.slice(-10) : phone;
                    if (!targetChat && shortPhone !== phone) {
                        targetChat = allChats.find(c => {
                            const idStr = (c.id && (c.id._serialized || c.id.user)) || '';
                            const nameStr = c.name || c.__x_name || c.formattedTitle || '';
                            return String(idStr).includes(shortPhone) || String(nameStr).includes(shortPhone);
                        });
                    }

                    if (!targetChat) {
                        return {
                            found: false,
                            searched: phone,
                            shortPhone: shortPhone,
                            matchedContact: matchedContact ? {
                                id: matchedContact.id?._serialized,
                                name: matchedContact.name || matchedContact.pushname,
                                number: matchedContact.number,
                                lid: matchedContact.lid?._serialized
                            } : null,
                            totalChats: allChats.length,
                            totalContacts: allContacts.length,
                            sampleChats: allChats.slice(0, 30).map(c => ({
                                id: c.id?._serialized,
                                name: c.name || c.__x_name || c.formattedTitle || '(No Name)',
                                contactName: c.contact?.name || c.contact?.pushname || null
                            }))
                        };
                    }

                    try {
                        if (targetChat.loadEarlierMsgs) {
                            await targetChat.loadEarlierMsgs();
                        }
                    } catch(e) {}

                    const msgs = targetChat.msgs?.getModelsArray ? targetChat.msgs.getModelsArray() : (targetChat.msgs?.models || []);
                    const sinceTimestamp = Math.floor((Date.now() - (days * 24 * 60 * 60 * 1000)) / 1000);

                    const filtered = msgs.filter(m => {
                        const t = m.t || m.timestamp;
                        return t >= sinceTimestamp;
                    });

                    const targetMsgs = filtered.length > 0 ? filtered : msgs;

                    const formatted = targetMsgs.map(m => {
                        const t = m.t || m.timestamp || 0;
                        return {
                            id: (m.id && (m.id._serialized || m.id.id)) || '',
                            timestamp: t,
                            datetime: t ? new Date(t * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : null,
                            from: (m.from && (m.from._serialized || m.from)) || '',
                            to: (m.to && (m.to._serialized || m.to)) || '',
                            fromMe: Boolean(m.id && m.id.fromMe !== undefined ? m.id.fromMe : m.fromMe),
                            type: m.type || 'chat',
                            body: m.body || m.caption || (m.type && m.type !== 'chat' ? `[${m.type}]` : '')
                        };
                    });

                    return {
                        found: true,
                        chat: {
                            id: targetChat.id?._serialized || '',
                            name: targetChat.name || targetChat.__x_name || targetChat.formattedTitle || 'Unknown',
                            isGroup: targetChat.isGroup || false
                        },
                        sinceTime: new Date(sinceTimestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                        totalInChat: msgs.length,
                        matchedInLastDays: filtered.length,
                        messages: formatted
                    };
                } catch(err) {
                    return { error: err.message, stack: err.stack };
                }
            }, queryPhone, days);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(result, null, 2));
        } catch(err) {
            console.error('Server error in /api/messages:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Link WhatsApp - Hermes AI</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #eef2f5; color: #111b21; }
        .card { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); text-align: center; max-width: 440px; width: 92%; }
        h1 { font-size: 24px; margin: 0 0 6px 0; color: #008069; }
        p.subtitle { color: #54656f; font-size: 14px; margin: 0 0 20px 0; }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-bottom: 18px; }
        .badge.waiting { background: #fff3cd; color: #856404; }
        .badge.connected { background: #d1e7dd; color: #0f5132; font-size: 16px; padding: 10px 18px; }
        .qr-wrap { display: flex; justify-content: center; align-items: center; min-height: 290px; margin-bottom: 20px; }
        .qr-wrap img { width: 280px; height: 280px; border: 2px solid #e2e8f0; border-radius: 12px; }
        .instructions { text-align: left; background: #f8fafc; border: 1px solid #e2e8f0; padding: 14px 18px; border-radius: 10px; font-size: 13px; line-height: 1.6; color: #334155; }
        .instructions ol { margin: 0; padding-left: 20px; }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #008069; border-radius: 50%; width: 36px; height: 36px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="card">
        <h1>Link WhatsApp</h1>
        <p class="subtitle">${BOT_NAME} - 24/7 AI Assistant (DeepSeek V3)</p>
        <div id="badge" class="badge waiting">⏳ Fetching QR Code...</div>
        <div class="qr-wrap" id="qr-container">
            <div id="loading"><div class="spinner"></div>Loading latest QR Code...</div>
        </div>
        <div style="margin-top: 18px; padding: 14px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; text-align: center;">
            <h3 style="margin: 0 0 6px 0; color: #166534; font-size: 15px;">📲 Link With Phone Number Instead</h3>
            <p style="font-size: 12px; color: #15803d; margin: 0 0 10px 0;">Don't want to scan QR? Send an 8-character OTP code directly to your phone:</p>
            <div style="display: flex; gap: 8px; justify-content: center; align-items: center;">
                <input id="phoneNumberInput" type="text" value="+918529911832" style="padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; width: 160px; font-weight: bold; text-align: center;" />
                <button id="sendOtpBtn" onclick="requestPairingCode()" style="background: #008069; color: white; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px;">Send Code</button>
            </div>
            <div id="pairingCodeResult" style="margin-top: 12px; display: none;"></div>
        </div>

        <div class="instructions" id="instructions">
            <ol>
                <li>Open <b>WhatsApp</b> on your mobile phone</li>
                <li>Go to <b>Settings</b> &rarr; <b>Linked Devices</b></li>
                <li>Tap <b>Link a Device</b></li>
                <li>Point your camera at this QR code to scan</li>
            </ol>
        </div>
    </div>
    <script>
        async function requestPairingCode() {
            const btn = document.getElementById('sendOtpBtn');
            const input = document.getElementById('phoneNumberInput');
            const resultDiv = document.getElementById('pairingCodeResult');
            let rawVal = input ? input.value : '';
            let phone = rawVal.replace(/[^\d]/g, '') || '918529911832';
            if (phone.length === 10) phone = '91' + phone;
            btn.disabled = true;
            btn.innerText = 'Requesting...';
            resultDiv.style.display = 'block';
            resultDiv.innerHTML = '<div style="color: #64748b; font-size: 13px;">Connecting to WhatsApp and requesting code...</div>';
            try {
                const res = await fetch('/pair-code?phone=' + phone);
                const data = await res.json();
                if (data.success && data.code) {
                    resultDiv.innerHTML = '<div style="padding: 12px; background: white; border: 2px dashed #008069; border-radius: 8px;"><div style="font-size: 12px; color: #54656f; margin-bottom: 4px;">ENTER THIS CODE IN WHATSAPP:</div><div style="font-size: 28px; font-weight: 800; letter-spacing: 4px; color: #008069;">' + data.code + '</div><div style="font-size: 12px; color: #15803d; margin-top: 6px;">Check the notification on phone or enter in Linked Devices!</div></div>';
                } else {
                    resultDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">Error: ' + (data.error || 'Failed to request code') + '</div>';
                }
            } catch(e) {
                resultDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">Error connecting to agent server</div>';
            } finally {
                btn.disabled = false;
                btn.innerText = 'Send Code';
            }
        }

        let lastQR = '';
        async function checkStatus() {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                const badge = document.getElementById('badge');
                const container = document.getElementById('qr-container');
                const instructions = document.getElementById('instructions');

                if (data.status === 'CONNECTED' || data.status === 'AUTHENTICATED') {
                    badge.className = 'badge connected';
                    badge.innerHTML = '✅ WhatsApp Connected Successfully!';
                    container.innerHTML = '<div style="padding:20px;color:#0f5132;font-weight:600;font-size:16px;">WhatsApp is linked! DeepSeek AI assistant is active 24/7.</div>';
                    instructions.style.display = 'none';
                    return;
                }
                if (data.qrImg) {
                    badge.className = 'badge waiting';
                    badge.innerHTML = '📲 Ready to Scan (Live)';
                    if (lastQR !== data.qr) {
                        lastQR = data.qr;
                        container.innerHTML = '<img src="' + data.qrImg + '" alt="WhatsApp QR Code" />';
                    }
                }
            } catch(e) {}
        }
        setInterval(checkStatus, 1500);
        checkStatus();
    </script>
</body>
</html>`);
});

server.listen(3000, '0.0.0.0', () => {
    console.log('[HTTP] QR & API Server running on http://0.0.0.0:3000');
});

client.initialize().catch(err => {
    console.error('[CLIENT INITIALIZE FATAL ERROR]:', err.message);
    process.exit(1);
});
