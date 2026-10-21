// Mail assistant for the owner's WhatsApp chat.
// One draft per chat is the single source of truth: "make a mail ...", then edits ("also add the DS ID", "cc x@y.com",
// "attach the 2nd file", "make it more formal") update that draft and the preview card shows exactly what will be sent.
// A mail is sent only on an explicit "Yes / Send" while a draft is open. Recipients are only ever addresses that appear in
// the conversation (never invented). Files from the vault go out as real attachments (a link is added if one cannot be fetched).
// Drafts, recent files and the last sent mail are kept in data/mail-state.json so a restart loses nothing.
// index.js loads this file the same way as reportBot.js, so it can be reloaded without restarting the WhatsApp browser.
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'data', 'mail-state.json');
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 15;
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;   // Gmail allows 25 MB per mail in total

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HAS_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MAIL_WORD = /\b(e-?mail|mails?|gmail|cc|bcc)\b/i;
// Only explicit go-aheads send. A bare "ok" / "sure" is too easy to say about something else.
const CONFIRM_RE = /^(yes|yeah|yep|send|send it|send now|send the mail|send mail|send the email|send email|yes send|yes send it|yes please|ok send|okay send|ok send it|haan|haan bhej do|haan bhejo|bhej do|bhejo|bhej dena|bhej de|go ahead|confirm|confirmed)[\s.!]*$/i;
const STALE_CONFIRM_MS = 30 * 60 * 1000;   // a draft untouched this long is shown again before it goes out
const CANCEL_RE = /^(cancel|no|nahi|nahin|mat bhejo|mat bhej|discard|stop|rehne do|chhod do|chhoro|delete the mail|discard the mail|cancel the mail)[\s.!]*$/i;
const STATUS_RE = /^(is|has|was|did|have|kya)\b.{0,40}\b(mail|email)\b.{0,30}\b(sent|send|gone|gaya|gayi|bheja|delivered)\b|\b(mail|email)\b.{0,20}\b(sent|gaya|gayi|bheja)\b.{0,10}\?\s*$/i;
const SENT_CLAIM_RE = /(e-?mail|mail)[^.\n]{0,60}\b(sent|went out|dispatched|delivered)\b|\bsent (the |an? )?(e-?mail|mail)\b|✅[^\n]*\b(e-?mail|mail)\b[^\n]*\bsent\b/i;

// Lower-cased unique addresses in a text. A literal backslash-n before an address ("\nname@x.com") must not become part of it.
const addrs = (s) => [...new Set((String(s || '').replace(/\\[nrt]/g, ' ').match(EMAIL_RE) || []).map(a => a.toLowerCase()))];
const when = (ts) => new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4', ogg: 'audio/ogg' };

function createMailAssistant(deps) {
    const { generateAIReply, chatHistory, sendEmail, fetchFile } = deps;
    const ownerName = deps.ownerName || 'Roshan';

    let state = { drafts: {}, files: {}, lastSent: {} };
    try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (_) { /* first run */ }
    function save() {
        try {
            fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
            fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        } catch (e) { console.warn('[MAIL] could not save state:', e.message); }
    }

    // ── Files saved to the vault from this chat (newest first) ──
    function rememberFile(sender, f) {
        if (!f || !f.key) return;
        const list = (state.files[sender] || []).filter(x => x.key !== f.key && Date.now() - x.ts < FILE_TTL_MS);
        list.unshift({ key: f.key, url: f.url || '', mime: f.mime || '', name: f.name || '', ts: f.ts || Date.now(), text: String(f.text || '').slice(0, 1500) });
        state.files[sender] = list.slice(0, MAX_FILES);
        save();
    }
    function setFileText(sender, key, text) {
        const f = (state.files[sender] || []).find(x => x.key === key);
        if (f && text) { f.text = String(text).slice(0, 1500); save(); }
    }
    // Files uploaded before this module existed: object keys look like <date>/<sender with _ for @ and .>_<ms>.<ext>
    function seedFromShortLinks(shortLinks, baseUrl) {
        let added = 0;
        for (const [id, key] of Object.entries(shortLinks || {})) {
            const m = String(key).match(/^[\d-]+\/(.+)_(\d{10,})\.(\w+)$/);
            if (!m || Date.now() - Number(m[2]) > FILE_TTL_MS || /^report_/.test(m[1])) continue;
            const sender = m[1].replace(/_lid$/, '@lid').replace(/_c_us$/, '@c.us');
            if ((state.files[sender] || []).some(x => x.key === key)) continue;
            (state.files[sender] = state.files[sender] || []).push({ key, url: `${baseUrl}/f/${id}`, mime: EXT_MIME[m[3]] || '', name: '', ts: Number(m[2]), text: '' });
            added += 1;
        }
        for (const s of Object.keys(state.files)) state.files[s] = state.files[s].sort((a, b) => b.ts - a.ts).slice(0, MAX_FILES);
        if (added) { save(); console.log(`[MAIL] indexed ${added} earlier vault file(s)`); }
    }
    function recentFiles(sender) {
        const list = (state.files[sender] || []).filter(x => Date.now() - x.ts < FILE_TTL_MS);
        // the same photo stored twice within 2 seconds counts once
        return list.filter((x, i) => i === 0 || list[i - 1].ts - x.ts > 2000).slice(0, 5);
    }

    // ── Draft ──
    function getDraft(sender) {
        const d = state.drafts[sender];
        if (d && Date.now() - d.updatedAt > DRAFT_TTL_MS) { delete state.drafts[sender]; save(); return null; }
        return d || null;
    }
    function putDraft(sender, d) { d.updatedAt = Date.now(); state.drafts[sender] = d; save(); }
    function dropDraft(sender) { if (state.drafts[sender]) { delete state.drafts[sender]; save(); } }

    const kindOf = (a) => /pdf/i.test(a.mime || a.key) ? 'PDF' : /^image\//i.test(a.mime || '') || /\.(jpe?g|png|webp)$/i.test(a.key) ? 'photo' : 'file';
    const fileLabel = (a) => `${a.name || kindOf(a)} (${when(a.ts)})`;
    function card(d, note) {
        const lines = [];
        if (note) lines.push(`📝 ${note}`, '');
        lines.push('✉️ *Mail ready — check it*');
        lines.push(`*To:* ${d.to.length ? d.to.join(', ') : '❓ _missing — reply with the email address_'}`);
        if (d.cc.length) lines.push(`*CC:* ${d.cc.join(', ')}`);
        if (d.bcc.length) lines.push(`*BCC:* ${d.bcc.join(', ')}`);
        lines.push(`*Subject:* ${d.subject}`);
        lines.push(`📎 *Attachments:* ${d.attachments.length ? d.attachments.map(fileLabel).join(', ') : 'none'}`);
        lines.push('───────────', d.body, '───────────');
        lines.push(d.to.length
            ? 'Reply *Yes* to send, or tell me what to change (e.g. "add the DS ID", "cc name@x.com", "attach the 2nd file"). *Cancel* discards it.'
            : 'Reply with the recipient\'s email address, or *Cancel* to discard.');
        return lines.join('\n');
    }

    // ── Understand the message with the AI, then validate everything it returns ──
    function parseJson(raw) {
        const s = String(raw || '');
        const i = s.indexOf('{'), j = s.lastIndexOf('}');
        if (i < 0 || j <= i) return null;
        try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
    }
    async function plan(sender, text, quotedBody, draft, files, newFileKey) {
        const hist = (chatHistory.get(sender) || []).slice(-8)
            .map(h => `${h.role}: ${String(h.content || '').replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
        const last = state.lastSent[sender];
        const fileList = files.map((f, i) => `${i + 1}. ${when(f.ts)} ${f.name || path.basename(f.key)}${f.key === newFileKey ? ' [sent with this message]' : ''}` +
            `${f.text ? ` — content: ${f.text.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`).join('\n') || '(none)';
        const draftJson = draft ? JSON.stringify({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, attachments: draft.attachments.map(a => a.n) }) : '(none)';
        const lastJson = last ? JSON.stringify({ to: last.to, cc: last.cc, subject: last.subject, sentAt: when(last.sentAt), body: String(last.body || '').slice(0, 1200) }) : '(none)';
        const prompt =
`You manage ONE email draft for ${ownerName} over WhatsApp.

CURRENT DRAFT:
${draftJson}

LAST SENT MAIL (for follow-ups and reminders):
${lastJson}

RECENT FILES (newest first, refer to them by number):
${fileList}

QUOTED MESSAGE:
${quotedBody ? String(quotedBody).slice(0, 1500) : '(none)'}

RECENT CHAT:
${hist || '(none)'}

USER MESSAGE:
"""${text}"""

Return ONLY valid JSON:
{"intent":"compose|edit|unrelated","to":[],"cc":[],"bcc":[],"subject":"","body":"","attachments":[],"note":""}
Rules:
- "compose": the user asks for a new email. A follow-up or reminder to the LAST SENT MAIL is a compose: reuse its to and cc, subject "Re: <its subject>".
- "edit": the user changes the CURRENT DRAFT (adds or removes a detail such as a DS ID, changes wording, recipients, CC/BCC or attachments, asks for longer/shorter/more formal). Apply the change and return the COMPLETE updated draft, keeping everything else exactly as it was.
- "unrelated": the message is not about an email. Return empty fields.
- Recipients: use only email addresses that appear in the user message, quoted message, recent chat, current draft or last sent mail. Never invent one. "put X in cc" puts X in cc; bcc likewise. Do not repeat an address in more than one list.
- attachments: file numbers to attach. Attach when the user asks to attach or include a photo, slip, screenshot, document, file or "link", or when the email says something is attached. Use file 1 (newest) unless the user names another. When editing, keep the current attachments unless asked to change them.
- body: plain-text email (no *asterisks* or WhatsApp formatting) with a greeting, a clear body and the closing "Best regards,\\n${ownerName}". Copy IDs, codes, amounts, names, account, PAN and transaction numbers exactly. Say documents are attached only when attachments is not empty. English unless the user asks for another language.
- subject: short and specific, at most 10 words; include the key ID (such as the DS ID) when relevant, not every detail.
- note: one short line describing the change to the draft, e.g. "Added DS ID 8DCB54A2 to the subject and body". Nothing is sent yet, so never say sent.`;
        const key = `mail:${sender}`;
        try {
            return parseJson(await generateAIReply(key, prompt, 'You are a precise email assistant. Return ONLY valid JSON.', 1600));
        } finally {
            chatHistory.delete(key);
        }
    }

    function allowedAddresses(sender, text, quotedBody, draft) {
        const hist = (chatHistory.get(sender) || []).slice(-20).map(h => h && h.content).join(' ');
        const last = state.lastSent[sender];
        return new Set(addrs([text, quotedBody, hist,
            draft ? [...draft.to, ...draft.cc, ...draft.bcc].join(' ') : '',
            last ? [...(last.to || []), ...(last.cc || []), ...(last.bcc || [])].join(' ') : ''].join(' ')));
    }

    async function send(msg, sender, d) {
        if (!d.to.length) { await msg.reply('👉 Who should I send it to? Reply with the email address, or *Cancel* to discard.'); return true; }
        const atts = [], failed = [];
        for (const a of d.attachments) {
            try {
                const f = await fetchFile(a.key);
                if (!f || !f.buffer || !f.buffer.length) throw new Error('empty file');
                if (f.buffer.length > MAX_ATTACH_BYTES) throw new Error('too large to attach');
                const ext = path.extname(a.key) || '';
                atts.push({ filename: a.name || `${kindOf(a).toLowerCase()}-${atts.length + 1}${ext}`, content: f.buffer, contentType: f.contentType || a.mime || undefined });
            } catch (e) {
                console.warn(`[MAIL] could not attach ${a.key}: ${e.message}`);
                failed.push(a);
            }
        }
        const body = failed.length ? `${d.body}\n\nFile link${failed.length > 1 ? 's' : ''}:\n${failed.map(a => a.url).join('\n')}` : d.body;
        let info;
        try {
            console.log(`[MAIL] sending to ${d.to.join(', ')}${d.cc.length ? ` cc ${d.cc.join(', ')}` : ''}${d.bcc.length ? ` bcc ${d.bcc.join(', ')}` : ''} | "${d.subject}" | ${atts.length} attachment(s)`);
            info = await sendEmail({
                to: d.to.join(', '),
                cc: d.cc.length ? d.cc.join(', ') : undefined,
                bcc: d.bcc.length ? d.bcc.join(', ') : undefined,
                subject: d.subject,
                text: body,
                attachments: atts.length ? atts : undefined
            });
        } catch (e) {
            console.error('[MAIL] send failed:', e.message);
            await msg.reply(`⚠️ The mail was *not* sent: ${e.message || 'mail server error'}.\nThe draft is kept — reply *Yes* to try again.`);
            return true;
        }
        state.lastSent[sender] = { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body, attachments: d.attachments, sentAt: Date.now(), messageId: info && info.messageId };
        dropDraft(sender);
        save();
        console.log(`[MAIL] sent, message id ${info && info.messageId}`);
        await msg.reply(['✅ *Mail sent*',
            `*To:* ${d.to.join(', ')}`,
            d.cc.length ? `*CC:* ${d.cc.join(', ')}` : '',
            d.bcc.length ? `*BCC:* ${d.bcc.join(', ')}` : '',
            `*Subject:* ${d.subject}`,
            `📎 ${atts.length ? `${atts.length} file${atts.length > 1 ? 's' : ''} attached` : 'no attachments'}`,
            failed.length ? `⚠️ ${failed.length} file${failed.length > 1 ? 's' : ''} could not be attached, so the link is in the mail instead.` : '',
            `_Sent ${when(Date.now())} from ${deps.fromAddress || 'your Gmail'}_`].filter(Boolean).join('\n'));
        return true;
    }

    // Returns true when the message was handled here; false lets the normal chat answer it (any open draft stays).
    async function handle(msg, ctx) {
        const { sender, quotedBody } = ctx;
        const text = String(ctx.text || '').trim();
        const newFileKey = ctx.newFileKey || null;
        const draft = getDraft(sender);
        const mailish = MAIL_WORD.test(text) || HAS_EMAIL.test(text) ||
            (quotedBody && MAIL_WORD.test(quotedBody) && /\b(add|change|attach|send|follow|remind|include|remove)\b/i.test(text));
        if (!draft && !mailish) return false;

        if (draft && CANCEL_RE.test(text)) { dropDraft(sender); await msg.reply('❌ Draft discarded. Nothing was sent.'); return true; }
        if (draft && CONFIRM_RE.test(text)) {
            if (Date.now() - draft.updatedAt > STALE_CONFIRM_MS) {
                putDraft(sender, draft);
                await msg.reply(card(draft, 'This draft is from a while ago, so here it is again. Reply *Yes* once more to send it.'));
                return true;
            }
            return send(msg, sender, draft);
        }
        if (STATUS_RE.test(text) || (!draft && CONFIRM_RE.test(text))) {
            const last = state.lastSent[sender];
            await msg.reply(draft ? `⏳ Not sent yet — the mail to ${draft.to.join(', ') || '(no recipient)'} is waiting. Reply *Yes* to send it.`
                : last ? `📨 Last mail sent ${when(last.sentAt)} to ${last.to.join(', ')} — "${last.subject}". No other mail is waiting.`
                : 'No mail is waiting and none was sent recently. Tell me what to write, e.g. "make a mail to name@x.com about ...".');
            return true;
        }

        const files = recentFiles(sender);
        let p = null;
        try { p = await plan(sender, text || '(the user sent a file without a caption)', quotedBody, draft, files, newFileKey); } catch (e) { console.warn('[MAIL] plan failed:', e.message); }
        if (!p) {
            if (!draft) return false;
            await msg.reply('⚠️ I could not update the mail just now. Please say the change again. The draft is unchanged.');
            return true;
        }
        if (p.intent !== 'compose' && p.intent !== 'edit') return false;
        if (p.intent === 'edit' && !draft) p.intent = 'compose';

        const allowed = allowedAddresses(sender, text, quotedBody, draft);
        const clean = (list) => addrs((Array.isArray(list) ? list : [list]).join(' ')).filter(a => allowed.has(a));
        const to = clean(p.to);
        const cc = clean(p.cc).filter(a => !to.includes(a));
        const bcc = clean(p.bcc).filter(a => !to.includes(a) && !cc.includes(a));
        const nums = (Array.isArray(p.attachments) ? p.attachments : []).map(Number).filter(n => n >= 1 && n <= files.length);
        const attachments = [...new Set(nums)].map(n => ({ n, key: files[n - 1].key, url: files[n - 1].url, name: files[n - 1].name, mime: files[n - 1].mime, ts: files[n - 1].ts }));
        const subject = String(p.subject || (draft && draft.subject) || 'Message from ' + ownerName).replace(/\*/g, '').trim();
        const body = String(p.body || (draft && draft.body) || '').replace(/\*([^*\n]+)\*/g, '$1').trim();
        if (!body) {
            if (!draft) return false;
            await msg.reply('⚠️ I could not update the mail just now. Please say the change again. The draft is unchanged.');
            return true;
        }
        const next = { to, cc, bcc, subject, body, attachments, createdAt: draft && p.intent === 'edit' ? draft.createdAt : Date.now() };
        putDraft(sender, next);
        console.log(`[MAIL] ${p.intent} draft for ${sender}: to=${to.join(',') || '-'} cc=${cc.join(',') || '-'} bcc=${bcc.join(',') || '-'} files=${attachments.length}`);
        // the note is about the draft; nothing has been sent at this point
        const note = SENT_CLAIM_RE.test(String(p.note || '')) || /\bsent\b/i.test(String(p.note || '')) ? (p.intent === 'edit' ? 'Draft updated.' : 'Draft ready.') : String(p.note || '').trim();
        await msg.reply(card(next, note));
        return true;
    }

    // A chat answer must never claim a mail went out: real sends reply from send() above.
    function guardChatReply(sender, reply) {
        if (!SENT_CLAIM_RE.test(String(reply || ''))) return reply;
        const last = state.lastSent[sender];
        const draft = getDraft(sender);
        console.warn('[MAIL GUARD] chat reply claimed a mail was sent; replaced with the real status.');
        if (draft) return `⏳ The mail to ${draft.to.join(', ') || '(no recipient yet)'} is *not* sent yet. Reply *Yes* to send it.`;
        if (last) return `📨 Last mail actually sent: ${when(last.sentAt)} to ${last.to.join(', ')} — "${last.subject}".`;
        return '⚠️ I have *not* sent any email. Tell me what to write, e.g. "make a mail to name@x.com about ...", and I will show a preview before sending.';
    }

    return { handle, guardChatReply, rememberFile, setFileText, seedFromShortLinks, getDraft, dropDraft, recentFiles };
}

module.exports = { createMailAssistant };
