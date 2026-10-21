// Replays the KYC-mail conversation against mailAssistant.js with a scripted AI and a fake mail server.
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Run against a copy in a temp folder so data/mail-state.json never touches the real one
function freshModule() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
    fs.copyFileSync(path.join(__dirname, '..', 'mailAssistant.js'), path.join(dir, 'mailAssistant.js'));
    return { dir, mod: require(path.join(dir, 'mailAssistant.js')) };
}

function setup({ planReplies, fetchFails = false, dir, mod } = {}) {
    ({ dir, mod } = dir ? { dir, mod } : freshModule());
    const chatHistory = new Map([['own@lid', [{ role: 'user', content: 'my other mail is sgarmy200@outlook.com' }]]]);
    const sent = [];
    const prompts = [];
    const queue = [...(planReplies || [])];
    const mail = mod.createMailAssistant({
        chatHistory,
        generateAIReply: async (key, prompt) => { prompts.push(prompt); chatHistory.set(key, []); return JSON.stringify(queue.shift() || { intent: 'unrelated' }); },
        sendEmail: async (opts) => { sent.push(opts); return { messageId: '<id@test>' }; },
        fetchFile: async () => { if (fetchFails) throw new Error('storage down'); return { buffer: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' }; },
        fromAddress: 'sgarmy200@gmail.com'
    });
    const replies = [];
    const msg = { reply: async (t) => { replies.push(t); } };
    const say = (text, extra = {}) => mail.handle(msg, { sender: 'own@lid', text, quotedBody: '', ...extra });
    return { mail, say, replies, sent, prompts, chatHistory, dir, mod };
}

const KYC_FILE = { key: '2026-10-21/own_lid_1792564643363.jpg', url: 'https://h/f/8Px', mime: 'image/jpeg', ts: Date.now() - 60000, text: 'PAN BGTPB5961M KHAWLHRING BIAKTHANSANGI A/C 30058679150' };

test('compose, edit DS ID, cc, then send exactly the preview with a real attachment', async () => {
    const t = setup({ planReplies: [
        { intent: 'compose', to: ['kyc@asclepiuswellness.com'], cc: ['invented@nowhere.com'], subject: 'Request to Approve Bank KYC', body: 'Dear KYC Team,\nPlease approve the bank KYC.\nBest regards,\nRoshan', attachments: [1], note: 'Drafted' },
        { intent: 'edit', to: ['kyc@asclepiuswellness.com'], subject: 'Request to Approve Bank KYC (DS ID: 8DCB54A2)', body: 'Dear KYC Team,\nMy DS ID is 8DCB54A2. Please approve the bank KYC.\nBest regards,\nRoshan', attachments: [1], note: 'Added DS ID' },
        { intent: 'edit', to: ['kyc@asclepiuswellness.com'], cc: ['sgarmy200@outlook.com'], subject: 'Request to Approve Bank KYC (DS ID: 8DCB54A2)', body: 'Dear KYC Team,\nMy DS ID is 8DCB54A2. Please approve the bank KYC.\nBest regards,\nRoshan', attachments: [1], note: 'Added CC' }
    ] });
    t.mail.rememberFile('own@lid', KYC_FILE);
    assert.equal(await t.say('make a mail to approve the bank kyc, mail id kyc@asclepiuswellness.com, attach the photo'), true);
    assert.match(t.replies.at(-1), /Mail ready/);
    assert.doesNotMatch(t.replies.at(-1), /invented@nowhere\.com/, 'an address nobody wrote must be dropped');
    assert.match(t.prompts[0], /PAN BGTPB5961M/, 'the photo text is given to the AI');

    assert.equal(await t.say('also add the ds id 8DCB54A2'), true);
    assert.match(t.replies.at(-1), /DS ID: 8DCB54A2/);
    assert.equal(await t.say('put sgarmy200@outlook.com in cc'), true);
    assert.match(t.replies.at(-1), /\*CC:\* sgarmy200@outlook\.com/);

    assert.equal(await t.say('Yes'), true);
    assert.equal(t.sent.length, 1);
    const m = t.sent[0];
    assert.equal(m.to, 'kyc@asclepiuswellness.com');
    assert.equal(m.cc, 'sgarmy200@outlook.com');
    assert.match(m.subject, /DS ID: 8DCB54A2/);
    assert.match(m.text, /My DS ID is 8DCB54A2/);
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].content.toString(), 'JPEGDATA');
    assert.match(t.replies.at(-1), /Mail sent/);
    assert.equal(t.mail.getDraft('own@lid'), null, 'draft closed after sending');
});

test('a chat reply that claims a mail was sent is replaced with the truth', async () => {
    const t = setup();
    assert.match(t.mail.guardChatReply('own@lid', '✅ *Email sent successfully*'), /not\* sent any email/);
    assert.equal(t.mail.guardChatReply('own@lid', 'Here is your summary.'), 'Here is your summary.');
});

test('ordinary chat is left alone and needs no AI call', async () => {
    const t = setup();
    assert.equal(await t.say('ok'), false);
    assert.equal(await t.say('what is the weather'), false);
    assert.equal(t.prompts.length, 0);
});

test('an unrelated message keeps the draft and falls through to chat', async () => {
    const t = setup({ planReplies: [
        { intent: 'compose', to: ['a@b.com'], subject: 'S', body: 'Dear A,\nHello there friend.\nBest regards,\nRoshan', attachments: [] },
        { intent: 'unrelated' }
    ] });
    await t.say('make a mail to a@b.com saying hello');
    assert.equal(await t.say('what time is it'), false);
    assert.ok(t.mail.getDraft('own@lid'), 'draft still open');
    assert.equal(await t.say('ok'), false, 'a bare ok must not send');
    assert.equal(t.sent.length, 0);
});

test('if a file cannot be fetched the mail still goes with its link', async () => {
    const t = setup({ fetchFails: true, planReplies: [
        { intent: 'compose', to: ['a@b.com'], subject: 'Slip', body: 'Dear A,\nThe payment slip is attached.\nBest regards,\nRoshan', attachments: [1] }
    ] });
    t.mail.rememberFile('own@lid', KYC_FILE);
    await t.say('mail the slip to a@b.com');
    await t.say('send');
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].attachments, undefined);
    assert.match(t.sent[0].text, /https:\/\/h\/f\/8Px/);
    assert.match(t.replies.at(-1), /could not be attached/);
});

test('a draft untouched for 30+ minutes is shown again before sending', async () => {
    const t = setup({ planReplies: [{ intent: 'compose', to: ['a@b.com'], subject: 'S', body: 'Dear A,\nHello there friend.\nBest regards,\nRoshan', attachments: [] }] });
    await t.say('make a mail to a@b.com saying hello');
    t.mail.getDraft('own@lid').updatedAt -= 31 * 60 * 1000;
    await t.say('yes');
    assert.equal(t.sent.length, 0);
    assert.match(t.replies.at(-1), /Reply \*Yes\* once more/);
    await t.say('yes');
    assert.equal(t.sent.length, 1);
});

test('drafts survive a restart', async () => {
    const a = setup({ planReplies: [{ intent: 'compose', to: ['a@b.com'], subject: 'Kept', body: 'Dear A,\nHello there friend.\nBest regards,\nRoshan', attachments: [] }] });
    await a.say('make a mail to a@b.com saying hello');
    const b = setup({ dir: a.dir, mod: a.mod });   // new instance, same state file
    assert.equal(b.mail.getDraft('own@lid').subject, 'Kept');
});

test('"is the mail sent?" answers from real state', async () => {
    const t = setup();
    assert.equal(await t.say('is the mail sent?'), true);
    assert.match(t.replies.at(-1), /No mail is waiting/);
});
