require('dotenv').config();
delete process.env.DBUS_SESSION_BUS_ADDRESS;
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { queryChatMemory, findRecentEmail, createSequentialQueue } = require('./chatMemory');
const { sendEmail } = require('./emailService');

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

// Google Cloud Platform Settings (Vision, Speech-to-Text & Cloud Storage)
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || 'AIzaSyApaRpV3SMllSsMvdALP81zmQlrV_9w7k0';
const GOOGLE_SPEECH_API_KEY = process.env.GOOGLE_SPEECH_API_KEY || process.env.GOOGLE_VISION_API_KEY || 'AIzaSyApaRpV3SMllSsMvdALP81zmQlrV_9w7k0';
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'hermes-whatsapp-vault-390608';

// Google Drive Vault Settings (Option B)
const GOOGLE_DRIVE_KEY_PATH = process.env.GOOGLE_DRIVE_KEY_PATH || path.join(__dirname, 'google-drive-key.json');
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';

let googleDriveKey = null;
if (fs.existsSync(GOOGLE_DRIVE_KEY_PATH)) {
    try {
        googleDriveKey = JSON.parse(fs.readFileSync(GOOGLE_DRIVE_KEY_PATH, 'utf8'));
        console.log(`[GOOGLE DRIVE] Loaded Service Account: ${googleDriveKey.client_email}`);
    } catch (e) {
        console.warn('[GOOGLE DRIVE] Could not load service account key:', e.message);
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

const OCR_MAX_CHARS = 1200;
const HISTORY_MSG_MAX_CHARS = 400;
const REPLY_MAX_TOKENS = 350;

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
    const burstCount = (text.match(/^\[MEDIA BURST: (\d+) /) || [])[1];
    if (burstCount) return `[User sent ${burstCount} photos/documents at once. One combined summary was given.]`;
    if (text.startsWith('[IMAGE RECEIVED')) {
        const caption = (text.match(/User text accompanying the media: "([\s\S]*?)"$/) || [])[1];
        const scene = (text.match(/- Labels \/ Scene: (.*)/) || [])[1];
        const hasOcr = /Detected Text \(OCR/.test(text);
        return `[User sent a photo${scene ? ` (${scene.split(',').slice(0, 4).join(',').trim()})` : ''}${hasOcr ? ' containing text' : ''}${caption ? `; caption: "${caption.slice(0, 120)}"` : ''}. Summary was given.]`;
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
            const accessToken = (googleDriveKey ? await getGoogleDriveAccessToken() : null) || await getGCPAccessToken();
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
 * Fallback image analysis using Gemini Multimodal if Google Cloud Vision is unavailable
 */
async function analyzeImageWithGemini(base64Data, mimeType = 'image/jpeg') {
    if (!GEMINI_API_KEY) return null;
    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: "Describe what is in this image concisely in 2-3 sentences. If there is text, handwriting, or payment/financial figures (especially Indian Rupee ₹ amounts, recipient names, or UPI IDs), transcribe them accurately without confusing currency symbols." },
                        { inline_data: { mime_type: mimeType, data: base64Data } }
                    ]
                }],
                generationConfig: { maxOutputTokens: 250 }
            }),
            signal: AbortSignal.timeout(15000)
        });
        if (resp.ok) {
            const data = await resp.json();
            const desc = cleanOcrText(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
            if (desc) {
                return `[IMAGE RECEIVED - MULTIMODAL VISION ANALYSIS]:\n${desc}`;
            }
        }
    } catch (e) {
        console.error('[Gemini Vision Fallback Error]:', e.message);
    }
    return null;
}

/**
 * Multi-layer Vision Engine: Prioritizes Google Cloud Vision API, falls back to Gemini Multimodal
 */
async function getImageVisionDescription(base64Data, mimeType = 'image/jpeg') {
    console.log('[Vision Engine] Processing image with Google Cloud Vision API...');
    const visionResult = await analyzeImageWithVision(base64Data, mimeType);
    if (visionResult) return visionResult;

    console.log('[Vision Engine] Cloud Vision API unavailable or returned empty. Falling back to Gemini Multimodal Vision...');
    const geminiResult = await analyzeImageWithGemini(base64Data, mimeType);
    if (geminiResult) return geminiResult;

    return '[IMAGE RECEIVED]: An image file was received, but automated vision analysis was unavailable.';
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

    const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash', GEMINI_MODEL].filter(Boolean);

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
        const localDir = path.join(__dirname, 'saved-media', dateFolder);

        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
        }

        const localFilePath = path.join(__dirname, 'saved-media', fileName);
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(localFilePath, buffer);
        console.log(`[CLOUD VAULT] Saved local archive: ${localFilePath} (~${Math.round(buffer.length / 1024)} KB)`);

        let gcsUrl = null;
        let driveUrl = null;

        // 1. Google Drive Upload (Option B)
        if (googleDriveKey) {
            console.log(`[GOOGLE DRIVE] Attempting upload for ${originalFilename || fileName}...`);
            const driveResult = await uploadToGoogleDrive(buffer, originalFilename || path.basename(fileName), cleanMime);
            if (driveResult && driveResult.driveUrl) {
                driveUrl = driveResult.driveUrl;
                console.log(`[GOOGLE DRIVE LINK]: ${driveUrl}`);
            }
        }

        // 2. Google Cloud Storage Bucket Upload
        if (GCS_BUCKET_NAME) {
            // Prefer service account key token (has Storage Admin); fall back to GCE metadata token
            const accessToken = (googleDriveKey ? await getGoogleDriveAccessToken() : null) || await getGCPAccessToken();
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
                console.log(`[CLOUD VAULT] GCE metadata token not present (local dev). Local copy stored safely at ${localFilePath}`);
            }
        }

        return {
            saved: true,
            fileName: fileName,
            localPath: localFilePath,
            gcsUrl: gcsUrl,
            driveUrl: driveUrl
        };
    } catch (e) {
        console.error('[CLOUD VAULT ERROR]:', e.message);
        return null;
    }
}

const OWNER_NAME = process.env.OWNER_NAME || 'My Owner';
const BOT_NAME = process.env.BOT_NAME || 'Hermes AI';
const WHATSAPP_STYLE_RULES = `\n\nRESPONSE STYLE (strict): Write like a sharp, warm friend texting on a phone, better than Meta AI. Reply in under ~250 words / 350 tokens. ` +
    `1) Jump straight into the answer. NEVER open with "Certainly!", "Sure!", "Sure thing!", "Of course!", "Great question!", "Here is what you asked for", and NEVER say "As an AI". NEVER close with "Let me know if you need anything else!" or any similar offer. ` +
    `2) Keep paragraphs to 1-2 punchy sentences separated by a blank line. ` +
    `3) Use *single asterisks* for bold key words. NEVER use **double asterisks**, markdown headers (#), tables, or code fences. ` +
    `4) For lists use "•" bullets, each starting with a fitting emoji, one idea per line. ` +
    `5) NEVER paste raw OCR text, scans, or memory notes. ` +
    `For photos/documents/scans, reply with the PHOTO CARD below.`;

// Shared card layout for every photo/document (single or part of a burst).
const PHOTO_CARD_FORMAT = `PHOTO CARD FORMAT (use exactly, max ~120 words, never paste raw OCR):\n` +
    `📸 *<Photo/Document Overview: one punchy line>*\n\n` +
    `• *Key Information:*\n` +
    `  • <extracted figure, date, name, or key item>\n` +
    `  • <2-5 clean bullets total>\n\n` +
    `👉 *Takeaway/Action:* <one-line conclusion or next step>\n\n` +
    `ACCURACY RULE FOR FINANCIAL TRANSACTIONS: For receipts, invoices, or UPI/bank payment screenshots, transcribe currency amounts with exact precision. Note that '₹' represents Indian Rupees; never confuse or prefix '₹' with digits (e.g. ₹269 is ₹269, never 3269).`;

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

function buildEmailConfirmation({ to, subject, body, fromHistory }) {
    return `✅ *Email sent to ${to}*${fromHistory ? ' _(recipient from our chat)_' : ''}\n\n` +
        `📌 *Subject:* ${subject}\n\n` +
        `📝 ${body}\n\n` +
        `_Sent from sgarmy200@gmail.com_`;
}

function buildEmailPreviewCard({ to, subject, body, fromHistory }) {
    return `✉️ *Email Ready to Send!*\n\n` +
        `*To:* ${to}${fromHistory ? ' _(resolved from recent chat)_' : ''}\n` +
        `*Subject:* ${subject}\n` +
        `*Preview:* "${body}"\n\n` +
        `Shall I send this mail? Reply *Yes / Send* (or *Haan / Bhej do*) to dispatch, or *Cancel* to discard.`;
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
    `EMAIL & DISPATCH CAPABILITY: You have fully automated Gmail sending capabilities via integrated SMTP (sgarmy200@gmail.com). When a user asks to send an email, mail documents/summaries, or draft a message, NEVER say you cannot send emails or lack email access. You can directly send emails on behalf of Roshan.` +
    WHATSAPP_STYLE_RULES;

const OWNER_PROMPT = `You are ${BOT_NAME}, ${OWNER_NAME}'s world-class executive assistant. You are talking directly to ${OWNER_NAME}, the owner. ` +
    `Always use second person ("you"/"your"). NEVER use "he/him/his" or ${OWNER_NAME}'s name to refer to the person you're talking to, and never say he is away, busy, or that a message "will be passed on". ` +
    `Understand natural Hinglish, Hindi, and English (and voice-note transcripts with typos) and reply in the language he used. ` +
    `Give the answer or result first, instantly; no preamble, no restating the question, no filler. Ask at most one short clarifying question, only when truly blocked. ` +
    `Act on requests (emails, saving media, summaries) rather than describing how. Recalled background context is silent: never recite it. ` +
    `Google Drive/Cloud Vault: media he sends is automatically saved; when you see [GOOGLE DRIVE LINK] or [CLOUD STORAGE LINK], confirm it was saved and share the link. ` +
    `EMAIL & DISPATCH CAPABILITY: You have direct integrated Gmail SMTP. When Roshan asks to send an email, mail documents, or forward receipts, draft and prepare the email immediately. NEVER refuse or say you don't have email access.` +
    WHATSAPP_STYLE_RULES;

const chatHistory = new Map();
const MAX_HISTORY = 10;

function getLastAssistantReply(sender) {
    const history = chatHistory.get(sender) || [];
    for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        if (item.role === 'assistant' && item.content) return item.content;
        if (item.role === 'model' && item.parts && item.parts[0]?.text) return item.parts[0].text;
    }
    return '';
}

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
                    maxOutputTokens: maxTokens
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
    if (AI_PROVIDER === 'deepseek') {
        return await getDeepSeekReply(chatId, userMessage, customSystemPrompt, maxTokens);
    } else if (AI_PROVIDER === 'gemini') {
        return await getGeminiReply(chatId, userMessage, customSystemPrompt, maxTokens);
    } else {
        return await getHermesReply(chatId, userMessage, customSystemPrompt, maxTokens);
    }
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
                    blobUrl = URL.createObjectURL(waMsg.mediaData.mediaBlob);
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
                    const blob = await DownloadManager.downloadAndMaybeDecrypt({ msg: waMsg, signal: null });
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
        await client.sendPresenceUnavailable();
        console.log('[PRESENCE] WhatsApp presence set to UNAVAILABLE (anti-ban reactive mode).');
    } catch(e) {}
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

client.on('disconnected', (reason) => {
    clientStatus = 'DISCONNECTED';
    console.warn('[DISCONNECTED] Client was disconnected:', reason);
});

// ─── PROACTIVE SCHEDULER: DISABLED ───
// All automated/scheduled proactive messages (6:00 AM morning & 3:00 PM lunch) have been completely removed.
// The bot now operates strictly in reactive mode: it ONLY replies when messages are received.

const pendingBuffers = new Map(); // sender -> { timeout, texts: [], lastMsg }
const lastMediaStore = new Map();  // sender -> { storageInfo, timestamp } — remembers last upload for 10 minutes
const pendingEmailDrafts = new Map(); // sender -> { subject, body, effectiveStorageInfo, timestamp } — multi-turn email drafts

// Per-chat sequential queue: burst uploads (e.g. 6 photos) are processed fully and in order, never in parallel.
const enqueueChatTask = createSequentialQueue();
const seenMessageIds = new Set();

client.on('message', (msg) => {
    if (!msg || !msg.from) return;
    const msgId = msg.id && msg.id._serialized;
    if (msgId) {
        if (seenMessageIds.has(msgId)) return; // duplicate event -> no duplicate reply
        seenMessageIds.add(msgId);
        if (seenMessageIds.size > 500) seenMessageIds.delete(seenMessageIds.values().next().value);
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
    return [RESET_RE, DRIVE_RE, HELP_RE, STATUS_RE].some(re => re.test(text || ''));
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
            desc = `[DOCUMENT]: "${media.filename || 'Document'}" (${media.mimetype}) received and archived.`;
        }
        if (caption) desc += `\n[USER CAPTION ON THIS ITEM]: "${caption}"`;
        return { desc, storageInfo };
    } catch (err) {
        console.error('[BURST ITEM ERROR]:', err && (err.message || err));
        return { desc: '[media processing failed]', storageInfo: null };
    }
}

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

    const isRoshan = sender === '254975783530728@lid' ||
                     sender === '257487752175866@lid' ||
                     sender.includes('8529911832') ||
                     sender.includes('8058363027') ||
                     contactNum.includes('8529911832') ||
                     contactNum.includes('8058363027') ||
                     chatTitle.toLowerCase().includes('roshan') ||
                     chatTitle.toLowerCase().includes('jhotwara') ||
                     contactName.toLowerCase().includes('roshan') ||
                     contactName.toLowerCase().includes('jhotwara');

    const isDilip = sender === '237413007929354@lid' ||
                    sender.includes('9549477444') ||
                    contactNum.includes('9549477444') ||
                    chatTitle.toLowerCase().includes('dilip') ||
                    contactName.toLowerCase().includes('dilip');

    const isMother = sender.includes('7976765590') ||
                     contactNum.includes('7976765590');

    const isUserTester = sender === '257487752175866@lid' ||
                         sender.includes('8058363027') ||
                         contactNum.includes('8058363027') ||
                         chatTitle.toLowerCase().includes('jhotwara') ||
                         contactName.toLowerCase().includes('jhotwara');

    const isAllowed = isRoshan || isDilip || isMother || isUserTester;

    if (!isAllowed) {
        console.log(`[FILTERED / IGNORED]: Message from ${sender} (Chat: "${chatTitle}", Contact: "${contactName}") - Not in allowed whitelist.`);
        return;
    }

    // ─── INSTANT RESET: zero LLM, zero media processing ───
    if (!hasMedia && RESET_RE.test(incomingText)) {
        chatHistory.delete(sender);
        pendingEmailDrafts.delete(sender);
        lastMediaStore.delete(sender);
        await msg.reply('🧹');
        await goOffline(null);
        return;
    }
    if (!hasMedia && DRIVE_RE.test(incomingText)) {
        await msg.reply(`📁 *Your Cloud Vault*\n${DRIVE_FOLDER_URL}`);
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
            `${yn(GCS_BUCKET_NAME)} Cloud Storage`);
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
                    const truncatedQuoted = cleanQuoted.length > 1500 ? cleanQuoted.slice(0, 1500) + '… [truncated]' : cleanQuoted;
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
            const reply = sanitizeWhatsAppReply(await generateAIReply(sender, burstPrompt, (customPrompt || SYSTEM_PROMPT) + timeContext, 500));
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
                    if (storageInfo && storageInfo.driveUrl) {
                        mediaContext = `[DOCUMENT RECEIVED & SAVED TO GOOGLE DRIVE]: A document named "${docName}" was received and successfully uploaded to Google Drive. Direct Link: ${storageInfo.driveUrl}`;
                    } else {
                        mediaContext = `[DOCUMENT RECEIVED]: A document named "${docName}" was received and securely archived in the Cloud Storage Vault.`;
                    }
                }

                if (storageInfo && storageInfo.driveUrl) {
                    mediaContext += `\n[GOOGLE DRIVE LINK]: ${storageInfo.driveUrl}`;
                } else if (storageInfo && storageInfo.gcsUrl) {
                    mediaContext += `\n[CLOUD STORAGE LINK]: ${storageInfo.gcsUrl}`;
                }

                // Remember this upload for this sender for 10 minutes
                // so "save to drive" sent as a separate follow-up message works
                if (storageInfo) {
                    lastMediaStore.set(sender, { storageInfo, urls: [storageInfo.driveUrl || storageInfo.gcsUrl].filter(Boolean), timestamp: Date.now() });
                    console.log(`[LAST MEDIA STORE] Cached storageInfo for ${sender} (driveUrl: ${storageInfo.driveUrl || 'none'})`);
                }
            } else {
                console.warn('[MEDIA WARNING]: downloadMedia() returned empty or undefined media.');
            }
        } catch (mediaErr) {
            console.error('[MEDIA/STORAGE ERROR]:', mediaErr && (mediaErr.stack || mediaErr.message || mediaErr));
        }
    }

    let finalPrompt = incomingText;
    if (mediaContext) {
        if (incomingText) {
            finalPrompt = `${mediaContext}\n\n(If this is a photo/scan/document, answer with the card below and address the user's request in the Takeaway line.)\n${PHOTO_CARD_FORMAT}\nUser text accompanying the media: "${incomingText}"`;
        } else {
            finalPrompt = `${mediaContext}\n\n(No caption. If this is a photo/scan/document, reply with the card below. Do NOT repeat the raw text.)\n${PHOTO_CARD_FORMAT}`;
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

    // ─── MULTI-TURN EMAIL DRAFT RESOLUTION ───
    // If user previously asked to send an email without providing an address, and is now replying:
    if (pendingEmailDrafts.has(sender)) {
        const draft = pendingEmailDrafts.get(sender);
        // Expire draft after 15 minutes
        if (Date.now() - draft.timestamp > 15 * 60 * 1000) {
            pendingEmailDrafts.delete(sender);
        } else {
            const replyText = incomingText.trim();

            // Cancellation
            if (/^(cancel|no|nahi|nahin|mat bhej|mat bhejo|discard|radd|stop|chhoro|chhod do|rehne do)\b[\s.!]*$/i.test(replyText) ||
                /^(cancel|discard|radd|chhoro|stop|rehne do)\b/i.test(replyText)) {
                pendingEmailDrafts.delete(sender);
                console.log(`[MULTI-TURN EMAIL] Draft cancelled by ${sender}`);
                await msg.reply('❌ *Draft discarded.* Nothing was sent.');
                await goOffline(null);
                return;
            }

            // A (new) email address sets/updates the recipient, then asks for confirmation
            const matchEmail = incomingText.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/i);
            if (matchEmail) {
                draft.to = matchEmail[1];
                draft.fromHistory = false;
                draft.timestamp = Date.now();
                await msg.reply(buildEmailPreviewCard({ to: draft.to, subject: draft.subject, body: draft.body }));
                return;
            }

            // Confirmation
            if (/^(yes|yeah|yep|yup|y|send|send it|send now|haan|han|ha|haa|haan bhej do|bhej do|bhejo|bhej|bhej dena|bhej de|ok|okay|ok send|sure|proceed|go ahead|confirm|confirmed|done|kar do|kardo)[\s.!]*$/i.test(replyText)) {
                if (!draft.to) {
                    await msg.reply('👉 *Send to whom?* Please reply with the recipient\'s email address, or *Cancel* to discard.');
                    return;
                }
                pendingEmailDrafts.delete(sender);
                try {
                    const chat = await msg.getChat().catch(() => null);
                    if (chat && chat.sendStateTyping) await chat.sendStateTyping().catch(() => {});

                    console.log(`[MULTI-TURN EMAIL] Dispatching confirmed draft to ${draft.to}...`);
                    await sendEmail({
                        to: draft.to,
                        subject: draft.subject,
                        text: draft.body
                    });

                    await msg.reply(buildEmailConfirmation({ to: draft.to, subject: draft.subject, body: draft.body, fromHistory: draft.fromHistory }));
                    await goOffline(chat);
                } catch (sendErr) {
                    console.error('[MULTI-TURN EMAIL SEND ERROR]:', sendErr);
                    await msg.reply(`⚠️ Failed to send email to ${draft.to}: ${sendErr.message || 'SMTP error'}. Please try again.`).catch(() => {});
                    await goOffline(null);
                }
                return;
            }
        }
    }

    // ─── EMAIL INTENT: Send email directly from WhatsApp ───
    const hasEmailAddress = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i.test(incomingText);
    // Only explicit send/draft instructions trigger the email flow; mere mentions ("did you see my mail?",
    // "what is your email?") fall through to normal chat and cost no extra LLM calls.
    const isEmailQuestion = /^\s*(did|have|has|had|was|were|what|which|when|where|why|who|whose|kab|kaun)\b/i.test(incomingText);
    const isSelfEmailDeclaration = /^\s*(my|mera|meri)\s+(e-?mail|gmail|id)\b/i.test(incomingText);
    const hasEmailAction = !isEmailQuestion && !isSelfEmailDeclaration && (
        // Verbs preceding email/mail: 'send email', 'draft mail', 'forward an email to...'
        /\b(send|draft|compose|write|forward|shoot|fire\s*off)\b[^.?!\n]{0,40}\b(e-?mail|mail|gmail)\b/i.test(incomingText) ||
        // Mail/email as action verb: 'mail it to...', 'email this to...', 'mail them to...'
        /\b(e-?mail|mail)\b[^.?!\n]{0,40}\b(it|this|that|them|these|to|ko|pe|at|draft|send)\b/i.test(incomingText) ||
        // Direct 'mail/email <address>'
        /\b(e-?mail|mail)\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i.test(incomingText) ||
        // Hindi / Hinglish action patterns
        /\b(e-?mail|mail|gmail)\b[^.?!\n]{0,30}\b(kar\s*do|kardo|kar\s*dena|kar\s*de|karo|bhej\s*do|bhejo|bhej\s*dena|bhej\s*de|send\s*kar|draft\s*kar)\b/i.test(incomingText) ||
        /\b(isko|ise|ye|yeh|is)\s+(e-?mail|mail|gmail)\b/i.test(incomingText) ||
        // Email address explicitly present + any transmission verb
        (hasEmailAddress && /\b(send|bhej|bhejo|bhejna|forward|share|deliver|dispatch|drop|shoot)\b/i.test(incomingText))
    );

    if (hasEmailAction) {
        console.log(`[EMAIL INTENT DETECTED from ${sender}]: "${incomingText}"`);

        const emailMatch = incomingText.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/i);
        // No address in this message -> look back through recent conversation before asking
        const recentEmail = emailMatch ? null : findRecentEmail(chatHistory.get(sender), { exclude: ['sgarmy200@gmail.com'] });
        const recipientEmail = emailMatch ? emailMatch[1] : recentEmail;
        const recipientFromHistory = Boolean(recentEmail);
        if (recipientFromHistory) console.log(`[EMAIL RECIPIENT] Resolved ${recentEmail} from recent chat with ${sender}`);

        let emailSubject = 'Message from Roshan';
        let emailBody = incomingText;
        const lastReply = getLastAssistantReply(sender);
        const hasSubstantiveQuoted = quotedBody && !/^\[.+ attachment\]$/i.test(quotedBody);
        let refSource = '';
        if (hasSubstantiveQuoted && lastReply) {
            refSource = `Quoted Message Reference (user specifically replied to this):\n"""\n${quotedBody.substring(0, 1500)}\n"""\n\nRecent Assistant Reply Context:\n"""\n${lastReply.substring(0, 1000)}\n"""`;
        } else if (hasSubstantiveQuoted) {
            refSource = `Quoted Message Reference (user specifically replied to this):\n"""\n${quotedBody.substring(0, 1500)}\n"""`;
        } else if (lastReply) {
            refSource = `Recent Context / Conversation Reference (what "it" or "this" refers to):\n"""\n${lastReply.substring(0, 1500)}\n"""`;
        }
        const recentContext = refSource ? `\n${refSource}` : '';

        try {
            const chat = await msg.getChat().catch(() => null);
            if (chat && chat.sendStateTyping) await chat.sendStateTyping().catch(() => {});

            // AI Polishing Prompt: Turn rough notes/instructions into an articulate, executive email
            const polishPrompt = `You are an expert executive email writer. The user sent this raw WhatsApp request to compose an email:
"${incomingText}"
${recentContext}

Task:
1. Polish the message into a professional, articulate, polite, and well-structured email body.
   - If written in Hindi, Hinglish, or shorthand notes, translate and polish into clear, fluent business English (unless the user explicitly instructed to write in Hindi).
   - Include a courteous greeting (e.g., "Hi," or "Dear Team,"), a clear and concise body with proper formatting, and a professional closing ("Best regards,\\nRoshan").
   - Strip out voice-to-text artifacts, WhatsApp meta-commands (like "mail kar do", "tell him that", "send email to..."), and informal conversational filler.
2. Formulate a crisp, professional subject line (maximum 6-8 words).

Return ONLY a valid JSON object with keys "subject" and "body". Do not use markdown backticks:
{"subject": "...", "body": "..."}`;

            const aiResponse = await generateAIReply(sender, polishPrompt, 'You are an email polishing assistant. Return ONLY valid JSON.', 700);
            const cleanJson = aiResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            if (parsed.subject) emailSubject = parsed.subject;
            if (parsed.body) emailBody = parsed.body;
        } catch (parseErr) {
            console.warn('[EMAIL POLISH AI WARNING]: Using fallback extraction:', parseErr.message);
            const rawBody = incomingText
                .replace(emailMatch ? emailMatch[0] : '', '')
                .replace(/\b(send|email|mail|gmail|bhej|kar do|kar dena|to|ko|ki|please|isko|ise|it|this|that)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            emailBody = rawBody.length >= 15 ? rawBody : (lastReply || rawBody || incomingText);
            emailSubject = `Message from Roshan via Hermes Assistant`;
        }

        // Append all Cloud Vault links (current media, or cached media from the last 10 minutes)
        if (effectiveUrls.length === 0 && (effectiveStorageInfo?.driveUrl || effectiveStorageInfo?.gcsUrl)) {
            effectiveUrls = [effectiveStorageInfo.driveUrl || effectiveStorageInfo.gcsUrl];
        }
        if (effectiveUrls.length === 1) {
            emailBody += `\n\n---\n📎 Shared Cloud File / Document:\n${effectiveUrls[0]}`;
        } else if (effectiveUrls.length > 1) {
            emailBody += `\n\n---\n📎 Shared Cloud Files / Documents (${effectiveUrls.length}):\n` +
                effectiveUrls.map((u, i) => `${i + 1}. ${u}`).join('\n');
        }

        // Case 1: Recipient email is missing -> Save draft & ask user!
        if (!recipientEmail) {
            pendingEmailDrafts.set(sender, {
                subject: emailSubject,
                body: emailBody,
                effectiveStorageInfo,
                timestamp: Date.now()
            });

            const askEmailReply = `✍️ *Draft ready*\n\n📌 *Subject:* ${emailSubject}\n\n📝 ${emailBody}\n\n👉 *Send to whom?* Reply with the email address to send instantly, or *Cancel* to discard.`;
            try {
                await msg.reply(askEmailReply);
            } catch (err) {
                console.error('[EMAIL ASK REPLY ERROR]:', err);
            }
            await goOffline(await msg.getChat().catch(() => null));
            return;
        }

        // Case 2: Recipient known -> never send immediately; save draft & ask for confirmation
        pendingEmailDrafts.set(sender, {
            to: recipientEmail,
            fromHistory: recipientFromHistory,
            subject: emailSubject,
            body: emailBody,
            effectiveStorageInfo,
            timestamp: Date.now()
        });
        try {
            await msg.reply(buildEmailPreviewCard({ to: recipientEmail, subject: emailSubject, body: emailBody, fromHistory: recipientFromHistory }));
        } catch (err) {
            console.error('[EMAIL PREVIEW REPLY ERROR]:', err);
        }
        await goOffline(await msg.getChat().catch(() => null));
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

        const reply = sanitizeWhatsAppReply(await generateAIReply(sender, finalPrompt, fullPrompt));
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

client.initialize().catch(err => {
    console.error('[CLIENT INITIALIZE FATAL ERROR]:', err.message);
    process.exit(1);
});
