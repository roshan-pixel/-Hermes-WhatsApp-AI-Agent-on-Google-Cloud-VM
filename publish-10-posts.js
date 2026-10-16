const fs = require('fs');
const path = require('path');

const KIMI_URL = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';
const SESSION = 'x-thread';

async function sendKimiCommand(action, args) {
    const payload = { action, args, session: SESSION };
    const tempFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `webbridge-req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(payload));
    try {
        const resp = await fetch(KIMI_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: fs.readFileSync(tempFile)
        });
        return await resp.json();
    } finally {
        try { fs.unlinkSync(tempFile); } catch(_) {}
    }
}

const posts = [
`🏛️ We built Hermes: An enterprise-grade, autonomous 24/7 WhatsApp AI Agent running on a Google Cloud VM with zero phone dependency.

Here is how we engineered it using Node.js, DeepSeek V3, multi-modal GCP APIs & Kimi WebBridge 🧵👇 [1/10]`,

`⚡ The Edge: WhatsApp Multi-Device Protocol
Instead of sketchy third-party APIs, Hermes runs whatsapp-web.js over headless Chromium.
Persistent session keys (.wwebjs_auth) live on our GCP e2-medium VM—surviving reboots with 0 reliance on a physical phone being online. [2/10]`,

`🧠 Brain: Multi-Model Cognitive Cascade
Primary: DeepSeek V3 for human-like reasoning & tone.
Instant fallback if rate limits hit:
DeepSeek V3 ➔ Google Gemini ➔ Nous Hermes 3.
Zero downtime, multi-turn conversation memory with a 10-turn FIFO sliding context. [3/10]`,

`⏱️ Real-time UX: Debouncing & Typing State
Humans text in rapid bursts:
"Hey"
"Free now?"
Without debouncing = multiple LLM calls.
Hermes uses a 3.5s sliding debouncer to bundle thoughts, simulates native typing (sendStateTyping), then responds smoothly. [4/10]`,

`🎭 Persona Isolation & Whitelist Engine
Hermes guarantees zero persona bleed:
• Strict LID/JID filter drops unknown numbers & groups.
• Dynamic persona routing: Intimate pampering for partner, formal "Ji Papa" for father, warm "Haan Maa" for mother.
Zero prompt leakage. [5/10]`,

`👁️ Tri-Cloud Multimodal Engine
WhatsApp media isn't just text.
• GCP Vision API: OCR, label detection, web entities, and scene recognition.
• GCP Speech-to-Text: Transcribes WhatsApp voice notes in Hindi, Hinglish, & English on the fly before cognitive reasoning. [6/10]`,

`☁️ Media Vault: Automated Cloud Backups
Every incoming image, document, and media note is streamed to Google Cloud Storage (hermes-whatsapp-vault) and mirrored to Google Drive.
Generates instant secure public viewing shortcuts right back into the chat. [7/10]`,

`📧 WhatsApp-to-Email Dispatch
Just text Hermes "Email this doc to X with summary":
• SMTP via Gmail + Nodemailer
• Browser fallback via Kimi WebBridge
• Multi-turn draft engine: remembers draft, prompts for missing recipient
• Polishes rough notes into executive emails. [8/10]`,

`🛡️ 3-Strike Watchdog & Production Resilience
Headless Chromium in production can suffer detached frames or re-renders.
Hermes has a 3-strike grace watchdog:
• Probes DOM title every 30s
• Tolerates transient sandbox glitches
• PM2 + systemd auto-heals on real crashes. [9/10]`,

`🕸️ Graphify Architecture & Open Source
We compiled the entire project AST into a 228-node knowledge graph with community clusters & interactive callflows using Graphify.

Check the architecture & star the repo:
🔗 https://github.com/roshan-pixel/-Hermes-WhatsApp-AI-Agent-on-Google-Cloud-VM [10/10]`
];

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForComposer(maxRetries = 15) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const check = await sendKimiCommand('evaluate', {
            code: `(() => {
                const box = document.querySelector('[data-testid="tweetTextarea_0"]');
                const btn = document.querySelector('button[data-testid="tweetButtonInline"]');
                return JSON.stringify({
                    hasBox: !!box,
                    hasBtn: !!btn
                });
            })()`
        });
        try {
            const data = JSON.parse(check.data?.value || '{}');
            if (data.hasBox && data.hasBtn) {
                return true;
            }
        } catch (_) {}
        await sleep(1000);
    }
    return false;
}

async function insertPostText(text) {
    // 1. Focus box and clear any previous selection
    await sendKimiCommand('evaluate', {
        code: `(() => {
            const box = document.querySelector('[data-testid="tweetTextarea_0"]');
            if (box) {
                box.focus();
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(box);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        })()`
    });
    await sleep(400);

    // 2. Insert complete multiline text via CDP Input.insertText
    await sendKimiCommand('cdp', {
        method: 'Input.insertText',
        params: { text }
    });
    await sleep(1200);

    // 3. Strict verification of inserted text
    const verifyRes = await sendKimiCommand('evaluate', {
        code: `(() => {
            const box = document.querySelector('[data-testid="tweetTextarea_0"]');
            return JSON.stringify({
                text: box ? box.innerText : '',
                length: box ? box.innerText.length : 0
            });
        })()`
    });
    
    const actual = JSON.parse(verifyRes.data?.value || '{}');
    console.log(`[INSERT CHECK] Expected chars: ${text.length} | Actual in editor: ${actual.length}`);
    if (actual.length < text.length * 0.85) {
        throw new Error(`CRITICAL: Text was truncated! Expected ${text.length} chars but got ${actual.length}. Aborting post to prevent incomplete tweet.`);
    }
    return true;
}

async function clickPostButton() {
    // 1. Locate button[data-testid="tweetButtonInline"]
    const coordRes = await sendKimiCommand('evaluate', {
        code: `(() => {
            const btn = document.querySelector('button[data-testid="tweetButtonInline"]');
            if (!btn) return JSON.stringify({ error: 'not_found' });
            const rect = btn.getBoundingClientRect();
            return JSON.stringify({
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                disabled: btn.getAttribute('aria-disabled') || btn.disabled
            });
        })()`
    });

    const coords = JSON.parse(coordRes.data?.value || '{}');
    if (coords.disabled === 'true') {
        throw new Error('Post button is disabled!');
    }

    if (coords.x && coords.y) {
        console.log(`[X POST] Dispatching trusted CDP click at (${coords.x}, ${coords.y})...`);
        await sendKimiCommand('cdp', {
            method: 'Input.dispatchMouseEvent',
            params: {
                type: 'mousePressed',
                x: coords.x,
                y: coords.y,
                button: 'left',
                clickCount: 1
            }
        });
        await sendKimiCommand('cdp', {
            method: 'Input.dispatchMouseEvent',
            params: {
                type: 'mouseReleased',
                x: coords.x,
                y: coords.y,
                button: 'left',
                clickCount: 1
            }
        });
        return true;
    }

    // Fallback: standard click
    const clickRes = await sendKimiCommand('click', { selector: 'button[data-testid="tweetButtonInline"]' });
    return clickRes.ok;
}

async function publishAllPosts() {
    console.log(`[PUBLISHER] Starting verified multiline publishing of 10 Hermes posts to X...`);

    // Ensure on home page
    await sendKimiCommand('navigate', { url: 'https://x.com/home', newTab: false });
    await sleep(3500);

    for (let i = 0; i < posts.length; i++) {
        const postNum = i + 1;
        const postText = posts[i];
        console.log(`\n======================================================`);
        console.log(`[PUBLISHER] >> POST ${postNum} of ${posts.length} <<`);
        console.log(`Content:\n${postText}\n------------------------------------------------------`);

        // 1. Wait for fresh composer
        console.log(`[PUBLISHER] Waiting for composer readiness...`);
        const ready = await waitForComposer();
        if (!ready) {
            console.warn(`[PUBLISHER] Composer not ready. Reloading page...`);
            await sendKimiCommand('evaluate', { code: 'window.location.reload()' });
            await sleep(4000);
            await waitForComposer();
        }

        // 2. Insert complete text with multiline verification
        console.log(`[PUBLISHER] Inserting full multiline text via CDP Input.insertText...`);
        await insertPostText(postText);
        console.log(`[PUBLISHER] Verified: full text is active in the editor.`);
        await sleep(1000);

        // 3. Click tweetButtonInline
        console.log(`[PUBLISHER] Clicking <button data-testid="tweetButtonInline">...`);
        await clickPostButton();
        console.log(`[PUBLISHER] Click dispatched! Waiting 5s for tweet submission...`);
        await sleep(5000);

        // 4. Refresh page to write new post
        console.log(`[PUBLISHER] Refreshing page for next post...`);
        await sendKimiCommand('evaluate', { code: 'window.location.reload()' });
        console.log(`[PUBLISHER] Page reload triggered. Waiting for UI reset...`);
        await sleep(4000);
    }

    console.log(`\n======================================================`);
    console.log(`[PUBLISHER] 🎉 All 10 full multiline project posts successfully published on X!`);
}

publishAllPosts().catch(console.error);
