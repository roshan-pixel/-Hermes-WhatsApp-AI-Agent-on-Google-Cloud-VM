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

async function composeThread() {
    console.log(`[X COMPOSE] Starting 10-post thread generation on X (Twitter)...`);

    for (let i = 0; i < posts.length; i++) {
        const postText = posts[i];
        console.log(`\n========================================`);
        console.log(`[X COMPOSE] Filling Post ${i + 1}/10 (${postText.length} chars)...`);
        
        // Find existing textboxes
        const targetSelector = `[data-testid="tweetTextarea_${i}"]`;
        
        // Fill the current tweet textarea
        const fillRes = await sendKimiCommand('fill', {
            selector: targetSelector,
            value: postText
        });
        
        if (!fillRes.ok) {
            console.warn(`[X COMPOSE] Fill via testid failed (${fillRes.error?.message}). Trying evaluate fallback...`);
            // evaluate fallback
            await sendKimiCommand('evaluate', {
                code: `(() => {
                    const el = document.querySelector('[data-testid="tweetTextarea_${i}"]');
                    if (el) {
                        el.focus();
                        document.execCommand('selectAll', false, null);
                        document.execCommand('insertText', false, ${JSON.stringify(postText)});
                    }
                })()`
            });
        } else {
            console.log(`[X COMPOSE] Post ${i + 1} filled successfully.`);
        }
        await sleep(1200);

        // Click '+' (Add post) to open the next textarea if not the last post
        if (i < posts.length - 1) {
            console.log(`[X COMPOSE] Spawning next tweet in thread (clicking '+' Add post)...`);
            const addRes = await sendKimiCommand('click', {
                selector: '[data-testid="addButton"]'
            });
            console.log(`[X COMPOSE] AddButton clicked:`, addRes.ok ? 'OK' : addRes.error?.message);
            await sleep(1500);
        }
    }

    // Verification
    console.log(`\n========================================`);
    console.log(`[X COMPOSE] Verifying complete 10-post thread in browser DOM...`);
    const statusRes = await sendKimiCommand('evaluate', {
        code: `(() => {
            const boxes = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"]'))
                .filter(b => b.getAttribute('data-testid') && b.getAttribute('data-testid').startsWith('tweetTextarea_'));
            const postBtn = document.querySelector('[data-testid="tweetButton"]');
            return JSON.stringify({
                detectedBoxes: boxes.length,
                postBtnText: postBtn ? postBtn.innerText : null,
                items: boxes.map((b, idx) => ({
                    index: idx + 1,
                    testId: b.getAttribute('data-testid'),
                    length: b.innerText.trim().length,
                    preview: b.innerText.trim().split('\\n')[0].substring(0, 50) + '...'
                }))
            });
        })()`
    });

    console.log('[X COMPOSE] Thread Verification Details:');
    try {
        const details = JSON.parse(statusRes.data.value);
        console.log(`Total thread posts composed: ${details.detectedBoxes} / 10`);
        console.log(`Main button state: "${details.postBtnText}"`);
        details.items.forEach(it => {
            console.log(` - Post ${it.index} (${it.testId}): [${it.length} chars] ${it.preview}`);
        });
    } catch(err) {
        console.log(statusRes);
    }
}

composeThread().catch(console.error);
