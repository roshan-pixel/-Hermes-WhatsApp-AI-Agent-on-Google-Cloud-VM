// Live check of mailAssistant.js against the real DeepSeek model (no mail is sent: sendEmail is a fake).
// Run on the server: node scripts/mail-smoke.js   (reads DEEPSEEK_* from .env, writes state to a temp folder)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-smoke-'));
fs.copyFileSync(path.join(__dirname, '..', 'mailAssistant.js'), path.join(dir, 'mailAssistant.js'));
const { createMailAssistant } = require(path.join(dir, 'mailAssistant.js'));

async function deepseek(key, prompt, system, maxTokens) {
    const r = await fetch(`${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', max_tokens: maxTokens, temperature: 0.2,
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] })
    });
    const j = await r.json();
    return j.choices[0].message.content;
}

(async () => {
    const chatHistory = new Map([['own@lid', [{ role: 'user', content: 'my other mail is sgarmy200@outlook.com' }]]]);
    const sent = [];
    const mail = createMailAssistant({
        chatHistory, generateAIReply: deepseek, fromAddress: 'sgarmy200@gmail.com',
        sendEmail: async (o) => { sent.push(o); return { messageId: '<smoke>' }; },
        fetchFile: async () => ({ buffer: Buffer.from('x'), contentType: 'image/jpeg' })
    });
    mail.rememberFile('own@lid', { key: '2026-10-21/own_lid_1.jpg', url: 'https://h/f/1', mime: 'image/jpeg', ts: Date.now() - 60000,
        text: 'BANK/PAN KYC Verification Pan No: BGTPB5961M Name: KHAWLHRING BIAKTHANSANGI IFSC SBIN0007059 A/C 30058679150 Account Holder MRS. K BIAKTHANSANGI STATE BANK OF INDIA' });
    const say = async (text) => {
        const replies = [];
        const handled = await mail.handle({ reply: async (t) => replies.push(t) }, { sender: 'own@lid', text, quotedBody: '' });
        console.log(`\n>>> ${text}\n[handled=${handled}]\n${replies.join('\n') || '(falls through to normal chat)'}`);
        return handled ? replies.join('\n') : '(falls through)';
    };
    const checks = [];
    const check = (ok, what) => { checks.push([ok, what]); };

    let r = await say('make a mail that want to aprove the bank kyc as pan card has name KHAWLHRING BIAKTHANSANGI and bank account has name MRS. K BIAKTHANSANGI as only mrs is there in bank please approve the bank kyc mail id kyc@asclepiuswellness.com attach the phooto as documents proof');
    check(/kyc@asclepiuswellness\.com/.test(r) && /Attachments:\* (?!none)/.test(r), 'compose: recipient and photo attached');
    r = await say('also add the ds id 8DCB54A2');
    check(/8DCB54A2/.test(r), 'edit: DS ID in the draft');
    r = await say('put sgarmy200@outlook.com in cc');
    check(/\*CC:\* sgarmy200@outlook\.com/.test(r) && /8DCB54A2/.test(r), 'edit: CC added, DS ID kept');
    r = await say('what is the time now');
    check(/falls through/.test(r), 'unrelated message goes to normal chat');
    r = await say('yes');
    check(sent.length === 1 && /8DCB54A2/.test(sent[0].text) && sent[0].cc === 'sgarmy200@outlook.com' && sent[0].attachments && sent[0].attachments.length === 1, 'send: exactly the preview, with CC and attachment');
    r = await say('make a followup to this mail that please approve asap !!');
    check(/kyc@asclepiuswellness\.com/.test(r) && /Re:/i.test(r) && !/^📝[^\n]*\bsent\b/im.test(r), 'follow-up: same recipient, Re: subject, note does not claim it was sent');
    const subjWords = ((sent[0] && sent[0].subject) || '').split(/\s+/).filter(w => /\w/.test(w)).length;
    check(subjWords > 0 && subjWords <= 12, `subject is short (${subjWords} words)`);
    r = await say('cancel');

    console.log('\n==== RESULT ====');
    for (const [ok, what] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
    process.exit(checks.every(c => c[0]) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
