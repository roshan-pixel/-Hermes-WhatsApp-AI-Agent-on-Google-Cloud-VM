// Owner-only broadcast: forwards a message you recently sent (text and/or video/photo) to every Mizoram Bonanza member,
// personalised with each member's name. Nothing is sent until the owner types /confirm.
//   /broadcast  -> finds the message, shows a preview (nothing is sent)
//   /confirm    -> sends it, one member at a time with a random pause between sends (reduces the ban risk)
//   /cancel     -> drops the preview or stops a running broadcast
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SENT_PATH = path.join(__dirname, 'data', 'broadcast-sent.json');
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const AWAIT_TTL_MS = 10 * 60 * 1000;      // /broadcast waits this long for the message
const COLLECT_MS = parseInt(process.env.BROADCAST_COLLECT_MS, 10) || 20 * 1000;   // wait for a follow-up (caption/video) before showing the preview
const LOOKBACK_SEC = 24 * 3600;
const MIN_PAUSE_MS = parseInt(process.env.BROADCAST_MIN_PAUSE_MS, 10) || 20 * 1000;
const MAX_PAUSE_MS = parseInt(process.env.BROADCAST_MAX_PAUSE_MS, 10) || 45 * 1000;
const SELF_CHAT = '918529911832@c.us';
const BOT_NOTICE_RE = /^(✅ Broadcast|⏹ Broadcast|📣 Broadcast|🚀 Sending|Hi \*)/;
const COMMAND_RE = /^\/(broadcast|confirm|cancel)\b/i;

function createBroadcaster(deps) {
    const { client, MessageMedia, downloadMedia, listMembers } = deps;
    let pending = null;   // { ownerChat, text, media, mediaType, key, expires }
    let running = null;   // { cancelled }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const loadSent = () => { try { return JSON.parse(fs.readFileSync(SENT_PATH, 'utf8')); } catch (_) { return {}; } };
    const saveSent = (all) => {
        try { fs.mkdirSync(path.dirname(SENT_PATH), { recursive: true }); fs.writeFileSync(SENT_PATH, JSON.stringify(all)); }
        catch (e) { console.warn('[BROADCAST] could not save progress:', e.message); }
    };
    const greet = (name, text) => text || '';   // no names: the message goes out exactly as you wrote it

    // Messages the owner sent to the bot are remembered here (reading chat history through WhatsApp Web is unreliable)
    const recent = new Map();   // chat id -> [message objects]
    const LATEST_PATH = path.join(__dirname, 'data', 'broadcast-latest.json');
    // The newest text + media you sent yourself, downloaded straight away and kept on disk so a restart cannot lose it
    let latest = null;       // { text, media: { mimetype, data, filename } | null, mediaType, ts }
    try { latest = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8')); } catch (_) { /* none yet */ }
    function saveLatest() {
        try { fs.mkdirSync(path.dirname(LATEST_PATH), { recursive: true }); fs.writeFileSync(LATEST_PATH, JSON.stringify(latest)); }
        catch (e) { console.warn('[BROADCAST] could not save latest message:', e.message); }
    }
    async function captureLatest(msg) {
        const text = (msg.body || '').trim();
        const fresh = latest && (msg.timestamp - latest.ts) < 15 * 60;
        const next = { text: '', media: null, mediaType: null, ts: msg.timestamp };
        if (msg.hasMedia && ['video', 'image', 'document'].includes(msg.type)) {
            const dl = await downloadMedia(msg);
            if (dl && dl.data) {
                next.media = { mimetype: dl.mimetype, data: dl.data, filename: dl.filename || null };
                next.mediaType = msg.type;
                next.text = text || (fresh ? latest.text : '');
            } else {
                console.warn('[BROADCAST] could not download the media you sent; it will be retried at preview time');
                return;
            }
        } else if (text) {
            // a text message: attach to a media sent within the last 15 minutes, otherwise it stands alone
            next.text = text;
            if (fresh && latest.media) { next.media = latest.media; next.mediaType = latest.mediaType; }
        } else {
            return;
        }
        latest = next;
        saveLatest();
        console.log(`[BROADCAST] saved your latest message (${next.mediaType || 'text'}${next.media ? `, ${(next.media.data.length * 0.75 / 1048576).toFixed(1)} MB` : ''}, ${next.text.length} chars of text)`);
    }
    function record(msg) {
        if (!msg || !msg.from) return;
        if (msg.fromMe && msg.hasQuotedMsg) return;                 // the bot's own replies
        if (msg.fromMe && BOT_NOTICE_RE.test((msg.body || '').trim())) return;   // the bot's own broadcast status messages
        const isSelfChat = msg.fromMe && msg.to === msg.from;       // "message yourself" chat
        if (msg.fromMe && !isSelfChat) return;
        const key = isSelfChat ? SELF_CHAT : msg.from;
        const list = recent.get(key) || [];
        if (list.some(m => m.id && msg.id && m.id._serialized === msg.id._serialized)) return;
        list.push(msg);
        const now = Date.now() / 1000;
        recent.set(key, list.filter(m => now - m.timestamp < LOOKBACK_SEC).slice(-25));
        if (isSelfChat) captureLatest(msg).catch(e => console.warn('[BROADCAST] capture failed:', e && e.message));
        console.log(`[BROADCAST] remembered a ${msg.type} message in ${isSelfChat ? 'your self chat' : 'owner chat'}`);
    }

    // Finds your latest message in your self chat directly in WhatsApp Web's own message store.
    async function findInStore() {
        const rows = await client.pupPage.evaluate(() => {
            const Msg = window.require('WAWebCollections').Msg;
            const now = Date.now() / 1000;
            const all = typeof Msg.getModelsArray === 'function' ? Msg.getModelsArray() : (Msg.models || Msg._models || []);
            return all
                .filter(m => m && m.id && m.id.fromMe && m.from && m.to && m.from._serialized === m.to._serialized && now - m.t < 24 * 3600)
                .map(m => ({ id: m.id._serialized, type: m.type, body: (m.caption || m.body || ''), t: m.t, size: m.size || 0 }));
        });
        const usable = rows.filter(r => !BOT_NOTICE_RE.test((r.body || '').trim()) && !COMMAND_RE.test((r.body || '').trim()) && (r.type !== 'chat' || (r.body || '').trim().length > 0));
        usable.sort((a, b) => a.t - b.t);
        const media = [...usable].reverse().find(r => ['video', 'image', 'document'].includes(r.type));
        let textRow = null;
        if (media) {
            textRow = (media.body || '').trim() ? media : [...usable].reverse().find(r => r.type === 'chat' && Math.abs(r.t - media.t) < 15 * 60);
        } else {
            textRow = [...usable].reverse().find(r => r.type === 'chat');
        }
        if (!media && !textRow) return null;
        const ids = [textRow && textRow !== media ? textRow.id : null, media ? media.id : null].filter(Boolean);
        return { ids, text: textRow ? (textRow.body || '').trim() : '', mediaType: media ? media.type : null, mediaMb: media ? +(media.size / 1048576).toFixed(2) : 0 };
    }

    async function findMessage(ownerChatId) {
        const now = Date.now() / 1000;
        // skip commands; only messages that arrived in this chat while the bot was running are known
        let pool = recent.get(ownerChatId) || [];
        try {
            // history works for some chats (e.g. your own "message yourself" chat); merge it with what the bot remembered
            const chat = await client.getChatById(ownerChatId);
            const fetched = await chat.fetchMessages({ limit: 40 });
            const seen = new Set(fetched.map(m => m.id && m.id._serialized));
            pool = fetched.concat(pool.filter(m => !(m.id && seen.has(m.id._serialized))));
        } catch (_) { /* history not available for this chat */ }
        pool.sort((x, y) => x.timestamp - y.timestamp);
        const candidates = pool.filter(m => now - m.timestamp < LOOKBACK_SEC
            && !COMMAND_RE.test((m.body || '').trim())
            && !(m.fromMe && m.hasQuotedMsg)   // the bot's own automatic replies quote the message they answer
            && (m.hasMedia || (m.body || '').trim().length > 0));
        if (candidates.length === 0) return null;
        const media = [...candidates].reverse().find(m => m.hasMedia && ['video', 'image', 'document'].includes(m.type));
        let textMsg = null;
        if (media) {
            textMsg = (media.body || '').trim()
                ? media
                : [...candidates].reverse().find(m => !m.hasMedia && Math.abs(m.timestamp - media.timestamp) < 15 * 60 && (m.body || '').trim().length > 0);
        } else {
            textMsg = [...candidates].reverse().find(m => !m.hasMedia && (m.body || '').trim().length > 0);
        }
        return { media, textMsg };
    }

    // Finds the message in the chat and downloads its media. Returns { job } or { error }.
    async function buildJob(ownerChatId) {
        if (ownerChatId === SELF_CHAT && latest && (Date.now() / 1000 - latest.ts) < LOOKBACK_SEC) {
            const mediaObj = latest.media ? new MessageMedia(latest.media.mimetype, latest.media.data, latest.media.filename || undefined) : null;
            const key = crypto.createHash('sha1').update(`${latest.text}|${mediaObj ? mediaObj.data.length : 0}`).digest('hex').slice(0, 12);
            return { job: { ownerChat: ownerChatId, text: latest.text, media: mediaObj, mediaType: latest.mediaType, key } };
        }
        if (ownerChatId === SELF_CHAT && false) {
            try {
                const st = await findInStore();
                if (st) {
                    const key = crypto.createHash('sha1').update(`${st.text}|${st.ids.join(',')}`).digest('hex').slice(0, 12);
                    return { job: { ownerChat: ownerChatId, text: st.text, media: null, mediaType: st.mediaType, mediaMb: st.mediaMb, key, forwardIds: st.ids } };
                }
            } catch (e) { console.warn('[BROADCAST] store lookup failed:', e && e.message); }
        }
        const found = await findMessage(ownerChatId);
        // The original message(s) can be forwarded natively. If they are not reachable (e.g. after a restart), fall back to the saved copy.
        if ((!found || (!found.media && !found.textMsg)) && ownerChatId === SELF_CHAT && latest && (Date.now() / 1000 - latest.ts) < LOOKBACK_SEC) {
            const mediaObj = latest.media ? new MessageMedia(latest.media.mimetype, latest.media.data, latest.media.filename || undefined) : null;
            const key = crypto.createHash('sha1').update(`${latest.text}|${mediaObj ? mediaObj.data.length : 0}`).digest('hex').slice(0, 12);
            return { job: { ownerChat: ownerChatId, text: latest.text, media: mediaObj, mediaType: latest.mediaType, key } };
        }
        if (!found || (!found.media && !found.textMsg)) return { error: 'I could not find a recent message to forward in this chat (last 24 hours). Send the message here first, then type /broadcast.' };
        const text = found.textMsg ? (found.textMsg.body || '').trim() : '';
        const forwardMsgs = [found.textMsg && found.textMsg !== found.media ? found.textMsg : null, found.media].filter(Boolean);
        let mediaObj = null;
        if (found.media) {
            const dl = await downloadMedia(found.media);
            if (!dl || !dl.data) return { error: 'I found the video/photo but could not download it. Please try again in a minute.' };
            mediaObj = new MessageMedia(dl.mimetype, dl.data, dl.filename || undefined);
        }
        const key = crypto.createHash('sha1').update(`${text}|${mediaObj ? mediaObj.data.length : 0}`).digest('hex').slice(0, 12);
        if (ownerChatId === SELF_CHAT) {
            // keep what we found on disk so a restart cannot lose it
            latest = { text, media: mediaObj ? { mimetype: mediaObj.mimetype, data: mediaObj.data, filename: mediaObj.filename || null } : null, mediaType: found.media ? found.media.type : null, ts: Math.floor(Date.now() / 1000) };
            saveLatest();
        }
        return { job: { ownerChat: ownerChatId, text, media: mediaObj, mediaType: found.media ? found.media.type : null, key, forwardMsgs } };
    }

    async function preview(msg, ownerChatId) {
        if (running) { await msg.reply('A broadcast is already being sent. Type /cancel to stop it.'); return; }
        const built = await buildJob(ownerChatId);
        if (built.error) { await msg.reply(built.error); return; }
        const { text, media: mediaObj, key } = built.job;
        const members = listMembers();
        const already = (loadSent()[key] || []).length;
        pending = { ...built.job, expires: Date.now() + PREVIEW_TTL_MS };
        const sample = members[0] ? greet(members[0].name, text) : text;
        const sizeMb = mediaObj ? (mediaObj.data.length * 0.75 / 1048576).toFixed(1) : (built.job.mediaMb || null);
        const minutes = Math.ceil(((members.length - already) * (MIN_PAUSE_MS + MAX_PAUSE_MS) / 2) / 60000);
        await msg.reply(
            `📣 *Broadcast preview* (nothing sent yet)\n\n` +
            `*Recipients:* ${members.length} Mizoram Bonanza members, sent exactly as you wrote it (no names)${already ? ` (${already} already received this exact message, they will be skipped)` : ''}\n` +
            `*Attachment:* ${(mediaObj || pending.mediaType) ? `${pending.mediaType} (${sizeMb} MB)` : 'none'}\n\n` +
            `*Message:*\n${sample.slice(0, 700)}${sample.length > 700 ? '…' : ''}\n\n` +
            `It will take about ${minutes} minutes (a random 20-45 second pause between members).\n\n` +
            `Reply */confirm* to send, or */cancel* to drop it.`);
    }

    async function send(msg) {
        if (running) { await msg.reply('A broadcast is already running. Type /cancel to stop it.'); return; }
        if (!pending || pending.expires < Date.now()) { pending = null; await msg.reply('Nothing to confirm. Type /broadcast first.'); return; }
        const job = pending;
        pending = null;
        const count = await startSending(job, null);
        await msg.reply(`🚀 Sending to ${count} members, one at a time with a short pause between each. You will get a completion report here when it is finished. Type /cancel to stop.`);
    }

    // Sends text/media straight from the VM. For people the account has never chatted with, WhatsApp Web needs the
    // LID <-> phone mapping and a chat created under the LID id first, so do that, then send.
    async function sendDirect(phone, media, caption) {
        const num = `91${phone}`;
        let lidId = null;
        try {
            lidId = await client.pupPage.evaluate(async (n) => {
                const wid = window.require('WAWebWidFactory').createWid(`${n}@c.us`);
                const r = await window.WWebJS.enforceLidAndPnRetrieval(wid);
                const lid = r && r.lid;
                if (lid) await window.require('WAWebFindChatAction').findOrCreateLatestChat(lid);
                return lid ? lid._serialized : null;
            }, num);
        } catch (e) { lidId = null; }
        const targets = [lidId, `${num}@c.us`].filter(Boolean);
        let lastErr = null;
        for (const t of targets) {
            try {
                // sendSeen:false -> skip "mark the chat as read", which crashes for people the account has never chatted with
                if (media) await client.sendMessage(t, media, { caption, sendSeen: false });
                else await client.sendMessage(t, caption, { sendSeen: false });
                return t;
            } catch (e) {
                lastErr = e;
                // only try the next id when this one failed before anything was sent
                if (!/must include an id|Cannot read properties of undefined/.test(String(e && e.message))) break;
            }
        }
        throw lastErr || new Error('no send target');
    }

    // The Baileys sender (a second linked device, see ~/baileys-sender) can message people this account has never chatted with.
    // Hand the job to it: it reads the saved broadcast + sent list, sends with pauses, and reports to the owner when finished.
    const SENDER_URL = process.env.SENDER_URL || 'http://127.0.0.1:3100';
    async function senderGet(pathname) {
        const r = await fetch(`${SENDER_URL}${pathname}`, { signal: AbortSignal.timeout(20000) });
        return r.json();
    }
    async function tryViaSender(job, onlyPhone, count) {
        try {
            const st = await senderGet('/status');
            if (!st.connected) return null;
            // save what to send and which members already have it (same message = resume, new message = fresh list)
            const all = loadSent();
            const sentList = all[job.key] || [];
            const media = job.media ? { mimetype: job.media.mimetype, data: job.media.data, filename: job.media.filename || null } : null;
            if (!media && job.forwardIds) return null;   // nothing the sender can use
            fs.mkdirSync(path.dirname(LATEST_PATH), { recursive: true });
            fs.writeFileSync(LATEST_PATH, JSON.stringify({ text: job.text, media, mediaType: job.mediaType, ts: Math.floor(Date.now() / 1000) }));
            fs.writeFileSync(SENT_PATH, JSON.stringify({ [job.key]: sentList }));
            if (onlyPhone) {
                const r = await senderGet(`/send?to=${onlyPhone}`);
                if (!r.ok) throw new Error(r.error || 'send failed');
                const all2 = loadSent(); const l2 = new Set(all2[job.key] || []); l2.add(onlyPhone); all2[job.key] = [...l2]; saveSent(all2);
                return 1;
            }
            const r = await senderGet('/broadcast');
            if (r.error) throw new Error(r.error);
            running = { cancelled: false, viaSender: true };
            console.log(`[BROADCAST] handed to the sender: ${count} members to go`);
            // free the "running" flag when the sender is done
            const poll = setInterval(async () => {
                try {
                    const s2 = await senderGet('/status');
                    if (!s2.job || !s2.job.running) { clearInterval(poll); running = null; }
                } catch (_) { /* keep polling */ }
            }, 20000);
            return count;
        } catch (e) {
            console.warn('[BROADCAST] sender not usable, falling back:', e && e.message);
            return null;
        }
    }

    // Starts the background send loop. onlyPhone limits it to one member (used for a test send). Returns how many will be sent.
    async function startSending(job, onlyPhone) {
        const members = listMembers().filter(m => !onlyPhone || m.phone === onlyPhone);
        const all = loadSent();
        const done = new Set(all[job.key] || []);
        const todo = members.filter(m => !done.has(m.phone));
        const viaSender = await tryViaSender(job, onlyPhone, todo.length);
        if (viaSender !== null) return viaSender;
        running = { cancelled: false };
        const failed = [];
        let consecutiveFailures = 0;
        let sent = 0;
        (async () => {
            for (let i = 0; i < todo.length; i++) {
                if (running.cancelled) break;
                const m = todo[i];
                try {
                    let chatId = `91${m.phone}@c.us`;
                    try {
                        const id = await client.getNumberId(`91${m.phone}`);   // may fail on some WhatsApp Web versions; then just try to send
                        if (id === null) { failed.push(`${m.name} (not on WhatsApp)`); continue; }
                    } catch (_) { /* fall back to the plain number id */ }
                    const usedTarget = await sendDirect(m.phone, job.media, greet(m.name, job.text));
                    consecutiveFailures = 0;
                    console.log(`[BROADCAST] delivered via ${usedTarget.endsWith('@lid') ? 'lid' : 'phone'} id`);
                    done.add(m.phone); all[job.key] = [...done]; saveSent(all);
                    sent += 1;
                    console.log(`[BROADCAST] sent ${sent}/${todo.length} (...${m.phone.slice(-4)})`);
                } catch (e) {
                    consecutiveFailures += 1;
                    if (consecutiveFailures >= 3) { running.cancelled = true; failed.push('stopped after 3 failures in a row'); }
                    failed.push(`${m.name} (${String(e.message || e).slice(0, 40)})`);
                    console.warn(`[BROADCAST] failed for ...${m.phone.slice(-4)}:`, e.message, '| via:', (job.forwardMsgs && job.forwardMsgs.length) ? 'forward' : (job.media ? 'sendMessage+media' : 'sendMessage'), '|', String(e.stack || '').split(String.fromCharCode(10)).slice(1, 5).join(' <- ').slice(0, 500));
                }
                if (sent > 0 && sent % 10 === 0 && i < todo.length - 1) {
                    try { await client.sendMessage(job.ownerChat, `📣 Broadcast progress: ${sent}/${todo.length} sent.`); } catch (_) { /* ignore */ }
                }
                if (i < todo.length - 1 && !running.cancelled) await sleep(MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS));
            }
            const stopped = running.cancelled;
            running = null;
            try {
                await client.sendMessage(job.ownerChat,
                    `${stopped ? '⏹ Broadcast stopped' : '✅ Broadcast finished'}: ${sent} sent, ${failed.length} failed.` +
                    (failed.length ? `\n\nNot delivered:\n${failed.map(f => `• ${f}`).join('\n')}` : '') +
                    (stopped ? '\n\nType /broadcast then /confirm to continue with the remaining members.' : ''));
            } catch (_) { /* ignore */ }
        })();
        return todo.length;
    }

    // Admin helpers (used by the server's token-protected admin endpoint)
    async function adminPreview(chatId) {
        const built = await buildJob(chatId);
        if (built.error) return { error: built.error };
        const j = built.job;
        return { text: j.text, mediaType: j.mediaType, mediaMb: j.media ? +(j.media.data.length * 0.75 / 1048576).toFixed(2) : (j.mediaMb || 0), members: listMembers().length, alreadySent: (loadSent()[j.key] || []).length };
    }
    async function adminSend(chatId, onlyPhone) {
        if (running) return { error: 'a broadcast is already running' };
        const built = await buildJob(chatId);
        if (built.error) return { error: built.error };
        if (onlyPhone && !listMembers().some(m => m.phone === onlyPhone)) return { error: 'that number is not a Mizoram Bonanza member' };
        return { started: await startSending(built.job, onlyPhone || null) };
    }

    // ── /broadcast flow (like /report): ask for the message -> you send it -> preview -> /confirm sends it to everyone ──
    let awaiting = null;   // { chat, expires, items: [messages], timer }

    async function ask(msg, ownerChatId) {
        if (running) { await msg.reply('A broadcast is already being sent. Type /cancel to stop it.'); return; }
        if (awaiting && awaiting.timer) clearTimeout(awaiting.timer);
        pending = null;
        awaiting = { chat: ownerChatId, expires: Date.now() + AWAIT_TTL_MS, items: [], timer: null };
        const n = listMembers().length;
        await msg.reply(`📣 *Broadcast*\n\nSend me the message you want to broadcast now (text, or a video/photo with a caption).\n\nI will show you a preview first. Nothing goes to the ${n} Mizoram Bonanza members until you confirm.\n\nType /cancel to stop.`);
    }

    const isAwaiting = (chatId) => Boolean(awaiting && awaiting.chat === chatId && awaiting.expires > Date.now());

    // Called for every non-command message the owner sends while the bot is waiting. Returns true when it took the message.
    function collect(msg) {
        if (!awaiting || awaiting.chat !== msg.from || awaiting.expires < Date.now()) return false;
        if (COMMAND_RE.test((msg.body || '').trim())) return false;
        awaiting.items.push(msg);
        if (awaiting.timer) clearTimeout(awaiting.timer);
        awaiting.timer = setTimeout(() => finalizeAwaited().catch(e => console.error('[BROADCAST] preview failed:', e && e.message)), COLLECT_MS);
        return true;
    }

    // Builds the preview text for a job
    function previewText(job) {
        const members = listMembers();
        const already = (loadSent()[job.key] || []).length;
        const mb = job.media ? (job.media.data.length * 0.75 / 1048576).toFixed(1) : null;
        const minutes = Math.ceil(((members.length - already) * (MIN_PAUSE_MS + MAX_PAUSE_MS) / 2) / 60000);
        return `📣 *Broadcast preview* (nothing sent yet)\n\n` +
            `*Recipients:* ${members.length} Mizoram Bonanza members, sent exactly as you wrote it (no names)${already ? ` (${already} already received this exact message, they will be skipped)` : ''}\n` +
            `*Attachment:* ${job.media ? `${job.mediaType || job.media.mimetype.split('/')[0]} (${mb} MB)` : 'none'}\n\n` +
            `*Message:*\n${job.text ? job.text.slice(0, 900) + (job.text.length > 900 ? '…' : '') : '(no text)'}\n\n` +
            `It will take about ${minutes} minutes (a random pause between members).\n\n` +
            `Reply */confirm* to send it to everyone, or */cancel* to drop it.`;
    }

    async function finalizeAwaited() {
        const a = awaiting;
        awaiting = null;
        if (!a) return;
        const tell = async (t) => { try { await client.sendMessage(a.chat, t); } catch (e) { console.warn('[BROADCAST] could not message the owner:', e && e.message); } };
        const mediaMsg = [...a.items].reverse().find(m => m.hasMedia && ['video', 'image', 'document'].includes(m.type));
        const text = (mediaMsg && (mediaMsg.body || '').trim()) ||
            a.items.filter(m => !m.hasMedia).map(m => (m.body || '').trim()).filter(Boolean).join('\n\n');
        if (!mediaMsg && !text) { await tell('I did not get a text or a video/photo to broadcast. Type /broadcast to start again.'); return; }
        let mediaObj = null;
        if (mediaMsg) {
            const dl = await downloadMedia(mediaMsg);
            if (!dl || !dl.data) { await tell('I could not download the video/photo you sent. Nothing was broadcast. Please type /broadcast and send it again.'); return; }
            mediaObj = new MessageMedia(dl.mimetype, dl.data, dl.filename || undefined);
        }
        const key = crypto.createHash('sha1').update(`${text}|${mediaObj ? mediaObj.data.length : 0}`).digest('hex').slice(0, 12);
        const job = { ownerChat: a.chat, text, media: mediaObj, mediaType: mediaMsg ? mediaMsg.type : null, key };
        pending = { ...job, expires: Date.now() + PREVIEW_TTL_MS };
        await tell(previewText(job));
    }

    async function cancel(msg) {
        if (awaiting && awaiting.chat === msg.from) {
            if (awaiting.timer) clearTimeout(awaiting.timer);
            awaiting = null;
            await msg.reply('Broadcast cancelled. Nothing was sent.');
            return;
        }
        if (running) {
            running.cancelled = true;
            if (running.viaSender) { try { await senderGet('/cancel'); } catch (_) { /* ignore */ } }
            await msg.reply('Stopping after the current member...');
            return;
        }
        if (pending) { pending = null; await msg.reply('Broadcast dropped. Nothing was sent.'); return; }
        await msg.reply('Nothing to cancel.');
    }

    async function handle(msg, ownerChatId, text) {
        try {
            const cmd = text.trim().toLowerCase().split(/\s/)[0];
            if (cmd === '/broadcast') await ask(msg, ownerChatId);
            else if (cmd === '/confirm') await send(msg);
            else await cancel(msg);
        } catch (e) {
            console.error('[BROADCAST ERROR]:', e && (e.stack || e.message || e));
            try { await msg.reply('Broadcast failed: ' + String(e.message || e).slice(0, 120)); } catch (_) { /* ignore */ }
        }
    }

    return { handle, record, collect, isAwaiting, adminPreview, adminSend, hasActive: () => Boolean(running || awaiting || (pending && pending.expires > Date.now())), isCommand: (t) => COMMAND_RE.test((t || '').trim()) };
}

module.exports = { createBroadcaster };
