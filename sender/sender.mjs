// Baileys sender: a second linked device on the same WhatsApp account that can message people the account has never chatted with.
// Control API on 127.0.0.1:3100 (local only):
//   GET /status                     -> connection state + pairing code while linking
//   GET /send?to=PHONE10            -> send the saved broadcast (video + caption) to one member
//   GET /broadcast                  -> send to every member not yet sent (20-45 s pause between members)
//   GET /cancel                     -> stop a running broadcast
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';

const BOT_DIR = path.join(os.homedir(), 'hermes-whatsapp-agent');
const AUTH_DIR = path.join(os.homedir(), 'baileys-sender', 'auth');
const ACCOUNT_PHONE = '918529911832';
const OWNER_JID = '918058363027@s.whatsapp.net';   // Hermes owner: gets the completion report
const PORT = 3100;
const LOG = path.join(os.homedir(), 'baileys-sender', 'sender.log');
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let sock = null;
let state = { connected: false, registered: false, pairingCode: null, codeAt: 0, lastError: null };
let job = null;   // { running, cancelled, sent, failed:[], total }

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; } };

function loadBroadcast() {
    const latest = readJson(path.join(BOT_DIR, 'data', 'broadcast-latest.json'), null);
    if (!latest) throw new Error('no saved broadcast');
    return { text: latest.text || '', media: latest.media ? { mimetype: latest.media.mimetype, buffer: Buffer.from(latest.media.data, 'base64') } : null };
}

function members() {
    const rows = readJson(path.join(BOT_DIR, 'data', 'mizoram_members.json'), []);
    const byPhone = new Map();
    for (const r of rows) {
        const p = String(r.p || '').replace(/\D/g, '').slice(-10);
        if (p.length === 10 && !byPhone.has(p)) byPhone.set(p, r.n || 'Member');
    }
    return [...byPhone].map(([phone, name]) => ({ phone, name }));
}

const sentFile = path.join(BOT_DIR, 'data', 'broadcast-sent.json');
function sentSet() {
    const all = readJson(sentFile, {});
    const key = Object.keys(all)[0];
    return { key, all, set: new Set(all[key] || []) };
}
function markSent(phone) {
    const { key, all, set } = sentSet();
    if (!key) return;
    set.add(phone); all[key] = [...set];
    fs.writeFileSync(sentFile, JSON.stringify(all));
}

async function sendOne(phone) {
    if (!state.connected) throw new Error('not connected');
    const b = loadBroadcast();
    const [res] = await sock.onWhatsApp(`91${phone}@s.whatsapp.net`);
    if (!res || !res.exists) throw new Error('not on WhatsApp');
    const jid = res.jid;
    const content = b.media
        ? (b.media.mimetype.startsWith('video') ? { video: b.media.buffer, caption: b.text, mimetype: b.media.mimetype }
            : b.media.mimetype.startsWith('image') ? { image: b.media.buffer, caption: b.text }
            : { document: b.media.buffer, caption: b.text, mimetype: b.media.mimetype, fileName: 'file' })
        : { text: b.text };
    const sent = await sock.sendMessage(jid, content);
    return sent && sent.key && sent.key.id;
}

function niceName(n) { return String(n || '').split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' '); }

// Completion report for the owner
function summaryText() {
    const all = members();
    const { set } = sentSet();
    const delivered = all.filter(m => set.has(m.phone));
    const missing = all.filter(m => !set.has(m.phone));
    let t = `✅ *Mizoram Bonanza broadcast complete*\n\n` +
        `📋 Members: ${all.length}\n` +
        `📨 Delivered: ${delivered.length}\n` +
        `⚠️ Not delivered: ${missing.length}`;
    if (missing.length) {
        t += `\n\nThese numbers could not be reached (not on WhatsApp or send failed):\n` +
            missing.map(m => `• ${niceName(m.name)} - +91 ${m.phone}`).join('\n');
    }
    t += `\n\nMessage sent: the announcement video with its caption, no names.`;
    return t;
}

async function notifyOwner(text) {
    if (!state.connected) throw new Error('not connected');
    await sock.sendMessage(OWNER_JID, { text });
    log('completion report sent to the owner');
}

async function runBroadcast() {
    const { set } = sentSet();
    const todo = members().filter(m => !set.has(m.phone));
    job = { running: true, cancelled: false, sent: 0, failed: [], total: todo.length };
    log(`broadcast starting: ${todo.length} members`);
    let consecutive = 0;
    for (let i = 0; i < todo.length && !job.cancelled; i++) {
        const m = todo[i];
        try {
            const id = await sendOne(m.phone);
            markSent(m.phone);
            job.sent++; consecutive = 0;
            log(`sent ${job.sent}/${job.total} to ...${m.phone.slice(-4)} (${m.name}) id=${id}`);
        } catch (e) {
            consecutive++;
            job.failed.push(`${m.name}: ${String(e.message || e).slice(0, 60)}`);
            log(`FAILED ...${m.phone.slice(-4)} (${m.name}): ${e.message}`);
            if (consecutive >= 3) { log('stopping after 3 failures in a row'); job.cancelled = true; }
        }
        if (i < todo.length - 1 && !job.cancelled) await sleep(20000 + Math.random() * 25000);
    }
    job.running = false;
    log(`broadcast finished: ${job.sent} sent, ${job.failed.length} failed`);
    try { await notifyOwner(summaryText()); } catch (e) { log('could not notify the owner:', e.message); }
}

async function start() {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    state.registered = Boolean(auth.creds.registered);

    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr && !auth.creds.registered) {
            // link with a pairing code (enter it on the phone: Linked devices -> Link with phone number)
            try {
                const code = await sock.requestPairingCode(ACCOUNT_PHONE);
                state.pairingCode = code; state.codeAt = Date.now();
                log(`PAIRING CODE: ${code}`);
            } catch (e) { state.lastError = String(e.message || e); log('pairing code error:', state.lastError); }
        }
        if (connection === 'open') { state.connected = true; state.registered = true; state.pairingCode = null; log('connected'); }
        if (connection === 'close') {
            state.connected = false;
            const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
            log('connection closed, code', code);
            if (code === DisconnectReason.loggedOut) { log('logged out - clearing auth'); fs.rmSync(AUTH_DIR, { recursive: true, force: true }); }
            setTimeout(start, 3000);
        }
    });
}

http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const out = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
        if (u.pathname === '/status') return out({ ...state, job });
        if (u.pathname === '/send') return out({ ok: true, id: await sendOne(u.searchParams.get('to')) });
        if (u.pathname === '/broadcast') { if (job && job.running) return out({ error: 'already running' }, 409); runBroadcast(); return out({ started: true }); }
        if (u.pathname === '/report-owner') { await notifyOwner(summaryText()); return out({ ok: true, text: summaryText() }); }
        if (u.pathname === '/cancel') { if (job) job.cancelled = true; return out({ ok: true }); }
        out({ error: 'unknown' }, 404);
    } catch (e) { out({ error: String(e.message || e) }, 500); }
}).listen(PORT, '127.0.0.1', () => log(`control API on 127.0.0.1:${PORT}`));

start();
