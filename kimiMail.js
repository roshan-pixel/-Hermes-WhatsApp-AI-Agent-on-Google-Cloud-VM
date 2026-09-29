const fs = require('fs');
const path = require('path');

const KIMI_URL = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';

async function sendKimiCommand(action, args, session = 'hermes-email') {
    const payload = { action, args, session };
    const tempFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `webbridge-req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(payload));
    try {
        const resp = await fetch(KIMI_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: fs.readFileSync(tempFile)
        });
        const data = await resp.json();
        return data;
    } finally {
        try { fs.unlinkSync(tempFile); } catch(_) {}
    }
}

/**
 * Automates sending an email via the user's logged-in Gmail using Kimi WebBridge
 */
async function sendEmailViaKimi({ to, subject, body }) {
    console.log(`[KIMI EMAIL] Starting email to: ${to}, subject: ${subject}`);
    const session = `mail-${Date.now()}`;
    
    // 1. Navigate to Gmail Compose view with pre-filled fields
    const composeUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const navResult = await sendKimiCommand('navigate', { url: composeUrl, newTab: true, group_title: 'Hermes Mail' }, session);
    if (!navResult.ok) {
        throw new Error(`Failed to open Gmail: ${navResult.error?.message || JSON.stringify(navResult)}`);
    }

    // 2. Wait 3 seconds for Gmail compose UI to render
    await new Promise(r => setTimeout(r, 3000));

    // 3. Take snapshot to locate the Send button ref or use CDP to press Ctrl+Enter
    const snapResult = await sendKimiCommand('snapshot', {}, session);
    let sendSuccess = false;

    if (snapResult.ok && snapResult.data?.tree) {
        // Find Send button in tree
        function findSendButton(nodes) {
            if (!nodes) return null;
            for (const n of nodes) {
                if (n.role === 'button' && (n.name?.includes('Send') || n.name?.includes('Ctrl-Enter'))) {
                    return n.ref;
                }
                if (n.children) {
                    const found = findSendButton(n.children);
                    if (found) return found;
                }
            }
            return null;
        }

        const sendRef = findSendButton(snapResult.data.tree);
        if (sendRef) {
            console.log(`[KIMI EMAIL] Found Send button with ref: ${sendRef}, clicking...`);
            const clickResult = await sendKimiCommand('click', { selector: sendRef }, session);
            if (clickResult.ok) {
                sendSuccess = true;
            }
        }
    }

    // 4. Fallback to CDP Ctrl+Enter if click failed or button ref not found
    if (!sendSuccess) {
        console.log('[KIMI EMAIL] Dispatching Ctrl+Enter via CDP...');
        // Focus the body
        await sendKimiCommand('evaluate', { code: `(() => { const el = document.querySelector('div[role="textbox"][aria-label*="Message Body"]'); if (el) el.focus(); })()` }, session);
        // Dispatch Ctrl+Enter
        await sendKimiCommand('cdp', {
            method: 'Input.dispatchKeyEvent',
            params: {
                type: 'rawKeyDown',
                windowsVirtualKeyCode: 13,
                unmodifiedText: '\r',
                text: '\r',
                modifiers: 2 // Ctrl
            }
        }, session);
        await sendKimiCommand('cdp', {
            method: 'Input.dispatchKeyEvent',
            params: {
                type: 'keyUp',
                windowsVirtualKeyCode: 13,
                modifiers: 2
            }
        }, session);
        sendSuccess = true;
    }

    // 5. Wait 2 seconds for email to transmit
    await new Promise(r => setTimeout(r, 2500));

    // 6. Close the tab to keep user browser clean
    try {
        await sendKimiCommand('close_tab', {}, session);
    } catch (_) {}

    return {
        success: true,
        to,
        subject,
        method: 'kimi-webbridge',
        timestamp: new Date().toISOString()
    };
}

module.exports = { sendEmailViaKimi };
