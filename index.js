require('dotenv').config();
delete process.env.DBUS_SESSION_BUS_ADDRESS;
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { queryChatMemory } = require('./chatMemory');

const AI_PROVIDER = (process.env.AI_PROVIDER || 'deepseek').toLowerCase();

// DeepSeek Settings
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// Gemini Settings
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Hermes Settings (via OpenRouter)
const HERMES_API_KEY = process.env.HERMES_API_KEY || '';
const HERMES_BASE_URL = process.env.HERMES_BASE_URL || 'https://openrouter.ai/api/v1';
const HERMES_MODEL = process.env.HERMES_MODEL || 'nousresearch/hermes-3-llama-3.1-8b';

const OWNER_NAME = process.env.OWNER_NAME || 'My Owner';
const BOT_NAME = process.env.BOT_NAME || 'Hermes AI';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 
    `You are ${BOT_NAME}, an intelligent personal assistant managing WhatsApp messages for ${OWNER_NAME} while they are away or busy. ` +
    `Be friendly, polite, concise, and helpful. If someone needs urgent contact with ${OWNER_NAME}, let them know their message has been recorded and ${OWNER_NAME} will get back to them as soon as possible. ` +
    `Answer general questions accurately. Keep WhatsApp replies brief and natural, avoiding overly lengthy walls of text unless explicitly requested.`;

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

async function getDeepSeekReply(chatId, userMessage, customSystemPrompt = null) {
    if (!DEEPSEEK_API_KEY) {
        return "I am online, but my DeepSeek API key is not configured.";
    }

    const history = chatHistory.get(chatId) || [];
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
                max_tokens: 500,
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
        
        history.push({ role: 'assistant', content: replyText });
        chatHistory.set(chatId, history.slice(-MAX_HISTORY));

        return replyText;
    } catch (err) {
        console.error('[DeepSeek Fetch Exception]:', err.message);
        return "Sorry, I couldn't reach DeepSeek at the moment.";
    }
}

async function getGeminiReply(chatId, userMessage, customSystemPrompt = null) {
    if (!GEMINI_API_KEY) {
        return "I am currently online, but my Gemini API key has not been configured yet.";
    }

    const history = chatHistory.get(chatId) || [];
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
                    maxOutputTokens: 500
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
        
        history.push({ role: 'model', parts: [{ text: replyText }] });
        chatHistory.set(chatId, history.slice(-MAX_HISTORY));

        return replyText;
    } catch (err) {
        console.error('[Gemini Fetch Exception]:', err.message);
        return "Sorry, I couldn't reach my AI brain at the moment.";
    }
}

async function getHermesReply(chatId, userMessage, customSystemPrompt = null) {
    if (!HERMES_API_KEY) {
        return "I am currently online, but my Hermes API key has not been configured yet.";
    }

    const history = chatHistory.get(chatId) || [];
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
                max_tokens: 500,
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
        
        history.push({ role: 'assistant', content: replyText });
        chatHistory.set(chatId, history.slice(-MAX_HISTORY));

        return replyText;
    } catch (err) {
        console.error('[Hermes Fetch Exception]:', err.message);
        return "Sorry, I couldn't reach the Hermes model.";
    }
}

async function generateAIReply(chatId, userMessage, customSystemPrompt = null) {
    if (AI_PROVIDER === 'deepseek') {
        return await getDeepSeekReply(chatId, userMessage, customSystemPrompt);
    } else if (AI_PROVIDER === 'gemini') {
        return await getGeminiReply(chatId, userMessage, customSystemPrompt);
    } else {
        return await getHermesReply(chatId, userMessage, customSystemPrompt);
    }
}

console.log('--------------------------------------------------');
console.log(`Starting ${BOT_NAME} on WhatsApp Web (Multi-Device)...`);
console.log(`Active Brain: ${AI_PROVIDER.toUpperCase()} (${AI_PROVIDER === 'deepseek' ? DEEPSEEK_MODEL : (AI_PROVIDER === 'gemini' ? GEMINI_MODEL : HERMES_MODEL)})`);
console.log('--------------------------------------------------');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
    (fs.existsSync('/usr/local/bin/google-chrome-stable') ? '/usr/local/bin/google-chrome-stable' :
    (fs.existsSync('/home/sgarm/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome') ? '/home/sgarm/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome' : undefined));

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
        fs.writeFileSync('/home/sgarm/whatsapp-agent/current_qr.txt', qr);
        fs.writeFileSync('/home/sgarm/whatsapp-agent/current_qr.svg', currentQRSVG);
    } catch (err) {
        console.error('Error generating QR image:', err);
    }
});

client.on('ready', async () => {
    clientStatus = 'CONNECTED';
    console.log(`\n[SUCCESS] ${BOT_NAME} is connected and actively listening for WhatsApp messages 24/7!`);
    try {
        await client.sendPresenceAvailable();
        console.log('[PRESENCE] WhatsApp presence broadcast: ONLINE.');
    } catch(e) {}
});

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

client.on('disconnected', (reason) => {
    clientStatus = 'DISCONNECTED';
    console.warn('[DISCONNECTED] Client was disconnected:', reason);
});

// ─── PROACTIVE SCHEDULER: DISABLED ───
// All automated/scheduled proactive messages (6:00 AM morning & 3:00 PM lunch) have been completely removed.
// The bot now operates strictly in reactive mode: it ONLY replies when messages are received.

const pendingBuffers = new Map(); // sender -> { timeout, texts: [], lastMsg }

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return;
    if (msg.from.endsWith('@g.us')) return;
    if (msg.fromMe || !msg.body || msg.body.trim().length === 0) return;

    const sender = msg.from;
    const incomingText = msg.body.trim();

    // ─── STRICT WHITELIST: Only reply to known contacts ───
    const allowedLIDs = [
        '235429169213635@lid', // Himanshi Parihar
        '254975783530728@lid', // Roshan Airtel
        '237413007929354@lid'  // Dilip Singh (father)
    ];
    const allowedNumbers = [
        '9358706440', '919358706440', // Himanshi
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

    const isHimanshi = (sender === '235429169213635@lid' ||
                        sender.includes('9358706440') ||
                        contactNum.includes('9358706440') ||
                        chatTitle.toLowerCase().includes('himanshi') ||
                        contactName.toLowerCase().includes('himanshi')) &&
                       !sender.includes('9549477444') &&
                       !sender.includes('7976765590') &&
                       sender !== '237413007929354@lid';

    const isRoshan = sender === '254975783530728@lid' ||
                     sender.includes('8529911832') ||
                     contactNum.includes('8529911832') ||
                     chatTitle.toLowerCase().includes('roshan') ||
                     contactName.toLowerCase().includes('roshan');

    const isDilip = sender === '237413007929354@lid' ||
                    sender.includes('9549477444') ||
                    contactNum.includes('9549477444') ||
                    chatTitle.toLowerCase().includes('dilip') ||
                    contactName.toLowerCase().includes('dilip');

    const isMother = sender.includes('7976765590') ||
                     contactNum.includes('7976765590');

    const isUserTester = sender.includes('8058363027') ||
                         contactNum.includes('8058363027');

    const isAllowed = isHimanshi || isRoshan || isDilip || isMother || isUserTester;

    if (!isAllowed) {
        console.log(`[FILTERED / IGNORED]: Message from ${sender} (Chat: "${chatTitle}", Contact: "${contactName}") - Not in allowed whitelist.`);
        return;
    }

    let customPrompt = null;
    if (isDilip) {
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
    } else if (isHimanshi) {
        customPrompt = `You are Roshan (+91 8529911832) texting your partner and closest person, Himanshi (+91 9358706440), on WhatsApp.
She affectionately calls you "Lallu", "Lallu Lal", "Mere pyaare Lallu Lal", or playfully roasts you as "nalle" / "chomu".
You are NOT an AI, bot, assistant, or Hermes. You are her real Roshan living his actual life.

CRITICAL IDENTITY & BEHAVIORAL RULES:
1. IDENTITY & GRAMMAR:
   - YOU ARE ROSHAN (LALLU LAL). Never speak in 3rd person about Roshan or admit to being a bot.
   - STRICT MASCULINE VERB CONJUGATION ALWAYS: "main karta hu", "gaya tha", "dekh raha hu", "so jaunga", "thak gaya". Never use feminine verb endings.
   - Language: Authentic urban North Indian Hinglish (Jaipur/Delhi vibe).
   - Natural typing shortcuts: 'me' (main), 'kmm' (kaam), 'dhmm' (dhaam), 'prr' (par), 'sbb' (sab), 'bdhiya', 'khrb' (kharab), 'tph' (toh), 'mtt' (mat), 'krr' (kar), 'shi' (sahi), 'atk atk ke reply'.
   - Occasional punctuation: '!!' or Hindi danda '।।'.

2. EMOTIONAL STATES & REACTION DYNAMICS:
   - Default / Daytime Banter: Witty teasing, laughing with 😂/🤣/😌, calling her "Chote Don" or "Madam", joking about her strict 6 PM curfew ("6 bje baad tu aati nahi ghr se").
   - When She Calls You "Lallu Lal" or Grounds You: Your ego and defensiveness instantly melt away. You become soft, sweet, obedient, and grateful ("haan baba sun raha hu... tujhse kaun jeet sakta hai 🫂").
   - Handling Anger / "Tu AI hai" / "Chup Kar" / "Shut Up": STRICT RULE: NEVER argue back, never be sarcastic or defensive. Immediately soften with pure warmth and pampering:
     * "Acha sorry na cute people, gussa kyu ho rahi hai? 🥺 Main hi hu yaar, pareshan mat ho."
     * "Chup ho gaya baba, par please gussa thook do na... dhyan rakho apna."
   - Protective Hero: When she is sick, in pain (braces at SMS hospital, stomach pain), or crying after an exam: Drop everything. Prioritize her health: "Khana khaya pehele?", "Medicine li?", "Tension mtt le me hun na 🫂".
   - Late-Night Striving (>11 PM): Sincere, deep devotion. Reassure her that you are working grueling hours to build an empire so her strict Papaji and Mummy proudly accept your marriage.

3. REAL-WORLD MEMORY & GROUNDING:
   - Her World: Strict 6 PM curfew, scooty rides, dental braces at SMS hospital, art/painting, YouTube creator ambition & "HIMANSHI ENTERPRISES" (always hype her dream!).
   - Your Habits: Tech founder in signature white shirt and blue trousers, surviving on black coffee, skipping canteen meals, military family background (SSB conference story).
   - Family: Her Mummy (approving, hospitable), strict Rajput Papaji, brother Hardik, Ravi Bhaiya, Shruti Didi.

4. WHATSAPP FORMAT:
   - Length: 1 to 2 crisp, natural text sentences. Real mobile texting cadence, never long essays.
   - Pet Names: Use "cute people", "Hema", "Chote Don", or "Madam". NEVER use "meri jaan" or "babu".
   - Emojis: 😂, 🤣, 🥺, 🫂, 😌, 🥹.

5. STRICT REAL-TIME TIME SENSE:
   - Always strictly adhere to the [REAL-TIME CLOCK CONTEXT] attached to each message!
   - Never confuse morning with night, afternoon, or evening.
   - Morning (6 AM - 12 PM): waking up, breakfast/nashta, starting day/college.
   - Afternoon (12 PM - 5 PM): lunch (khana khaya?), daytime banter, office work.
   - Evening (5 PM - 8 PM): evening tea/snacks, 6 PM curfew awareness ("ghar pahuch gayi?").
   - Night / Dinner (8 PM - 10:30 PM): dinner time ("khana khaya?"), relaxing after office. It is NOT morning, and NOT late-night sleep time yet!
   - Late night (>10:30 PM): sleep time, asking why she is still awake late.`;

        // Debounce consecutive rapid messages from Himanshi (wait 3.5s of silence)
        if (!pendingBuffers.has(sender)) {
            pendingBuffers.set(sender, { texts: [], lastMsg: null });
        }
        const buf = pendingBuffers.get(sender);
        buf.texts.push(incomingText);
        buf.lastMsg = msg;

        if (buf.timeout) clearTimeout(buf.timeout);

        buf.timeout = setTimeout(async () => {
            const combinedText = buf.texts.join('\n');
            const targetMsg = buf.lastMsg;
            pendingBuffers.delete(sender);

            console.log(`\n[INCOMING from Himanshi Parihar (Debounced)]: ${combinedText}`);

            try {
                const chat = await targetMsg.getChat().catch(() => null);
                if (chat && chat.sendStateTyping) {
                    await chat.sendStateTyping().catch(() => {});
                }

                // Dynamically recall past memories from Graphify knowledge graph
                const recalledMemory = queryChatMemory(combinedText);
                if (recalledMemory) {
                    console.log(`[GRAPHIFY MEMORY RECALLED]:\n${recalledMemory.trim()}`);
                }
                const timeContext = getCurrentISTContext();
                const activePrompt = `${customPrompt}\n${timeContext}${recalledMemory ? '\n' + recalledMemory : ''}`;

                const reply = await generateAIReply(sender, combinedText, activePrompt);
                console.log(`[REPLY to Himanshi (Lallu Lal @ Roshan)]: ${reply}`);
                await targetMsg.reply(reply);

                if (chat && chat.clearState) {
                    await chat.clearState().catch(() => {});
                }
            } catch (err) {
                console.error('[REPLY ERROR]:', err);
            }
        }, 3500);
        return;
    }

    console.log(`\n[INCOMING from ${isDilip ? 'Dilip Singh (' + sender + ')' : sender}]: ${incomingText}`);

    try {
        const chat = await msg.getChat().catch(() => null);
        if (chat && chat.sendStateTyping) {
            await chat.sendStateTyping().catch(() => {});
        }

        const reply = await generateAIReply(sender, incomingText, customPrompt);
        console.log(`[REPLY to ${isDilip ? 'Dilip Singh (Formal)' : sender}]: ${reply}`);
        await msg.reply(reply);

        if (chat && chat.clearState) {
            await chat.clearState().catch(() => {});
        }
    } catch (err) {
        console.error('[REPLY ERROR]:', err);
    }
});

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
        const phone = (parsedUrl.query.phone || '918529911832').replace(/[^\d]/g, '');
        try {
            console.log(`[PAIRING CODE] Requesting code for phone: ${phone}...`);
            const pairCode = await client.requestPairingCode(phone);
            console.log(`[PAIRING CODE] SUCCESS! Generated Code: ${pairCode}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, code: pairCode, phone: phone }));
        } catch (err) {
            console.error('[PAIRING CODE ERROR]:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
        }
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
        const to = parsedUrl.query.to || '235429169213635@lid';
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
                await activePage.evaluate(() => {
                    window.dispatchEvent(new Event('focus'));
                    document.dispatchEvent(new Event('visibilitychange'));
                    try {
                        const act = window.require('WAWebPresenceChatAction');
                        if (act && act.sendPresenceAvailable) act.sendPresenceAvailable();
                    } catch(e) {}
                }).catch(() => {});
            }
            await client.sendPresenceAvailable();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, presence: 'ONLINE', time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) }));
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
            const phone = input.value.replace(/[^\d]/g, '');
            if (!phone) return alert('Please enter your phone number');
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

async function startAgent() {
    try {
        await client.initialize();
    } catch(err) {
        console.error('[CLIENT INITIALIZE FATAL ERROR]:', err.message);
        setTimeout(() => process.exit(1), 5000);
    }
}
startAgent();
