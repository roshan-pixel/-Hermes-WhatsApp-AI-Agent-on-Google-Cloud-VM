/**
 * Automatic Post-Install Patch for whatsapp-web.js
 * 
 * Fixes critical upstream Puppeteer / Chrome CDP disconnect issues:
 * 1. Prevents unhandled rejections on internal subframe navigations in pupPage.on('framenavigated').
 * 2. Adds .catch() error guards on polling evaluation loops (window.Debug?.VERSION and window.WWebJS).
 * 3. Adds transient error retries to initial Client.inject().
 * 4. Fixes WhatsApp Web July 2026 $1 / _serialized message ID property rename in Message.js & Injected/Utils.js to enable reliable downloadMedia().
 */

const fs = require('fs');
const path = require('path');

const clientPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

if (!fs.existsSync(clientPath)) {
    console.log('[patch-wwebjs] whatsapp-web.js not found in node_modules, skipping patch.');
    process.exit(0);
}

let code = fs.readFileSync(clientPath, 'utf8');
let modified = false;

// 1. Guard framenavigated listener against destroyed contexts and detached frames
const badNav = `        this.pupPage.on('framenavigated', async (frame) => {
            if (frame.url().includes('post_logout=1') || this.lastLoggedOut) {
                this.emit(Events.DISCONNECTED, 'LOGOUT');
                await this.authStrategy.logout();
                await this.authStrategy.beforeBrowserInitialized();
                await this.authStrategy.afterBrowserInitialized();
                this.lastLoggedOut = false;
            }
            await this.inject();
        });`;

const safeNav = `        this.pupPage.on('framenavigated', async (frame) => {
            try {
                if (frame.url().includes('post_logout=1') || this.lastLoggedOut) {
                    this.emit(Events.DISCONNECTED, 'LOGOUT');
                    await this.authStrategy.logout();
                    await this.authStrategy.beforeBrowserInitialized();
                    await this.authStrategy.afterBrowserInitialized();
                    this.lastLoggedOut = false;
                }
                await this.inject();
            } catch (err) {
                // Ignore transient subframe / detached frame navigation errors
            }
        });`;

if (code.includes(badNav)) {
    code = code.replace(badNav, safeNav);
    modified = true;
    console.log('[patch-wwebjs] Patched framenavigated handler');
}

// 2. Add .catch(() => false) to window.Debug?.VERSION loop
const badVersionLoop = `        while (start > Date.now() - timeout) {
            res = await this.pupPage.evaluate(
                'window.Debug?.VERSION != undefined',
            );
            if (res) {
                break;
            }
            await new Promise((r) => setTimeout(r, 200));
        }`;

const safeVersionLoop = `        while (start > Date.now() - timeout) {
            res = await this.pupPage.evaluate(
                'window.Debug?.VERSION != undefined',
            ).catch(() => false);
            if (res) {
                break;
            }
            await new Promise((r) => setTimeout(r, 200));
        }`;

if (code.includes(badVersionLoop)) {
    code = code.replace(badVersionLoop, safeVersionLoop);
    modified = true;
    console.log('[patch-wwebjs] Patched window.Debug?.VERSION loop');
}

// 3. Add .catch(() => false) to window.WWebJS loop
const badWWebLoop = `                    while (start > Date.now() - 30000) {
                        // Check window.WWebJS Injection
                        res = await this.pupPage.evaluate(
                            'window.WWebJS != undefined',
                        );
                        if (res) {
                            break;
                        }
                        await new Promise((r) => setTimeout(r, 200));
                    }`;

const safeWWebLoop = `                    while (start > Date.now() - 30000) {
                        // Check window.WWebJS Injection
                        res = await this.pupPage.evaluate(
                            'window.WWebJS != undefined',
                        ).catch(() => false);
                        if (res) {
                            break;
                        }
                        await new Promise((r) => setTimeout(r, 200));
                    }`;

if (code.includes(badWWebLoop)) {
    code = code.replace(badWWebLoop, safeWWebLoop);
    modified = true;
    console.log('[patch-wwebjs] Patched window.WWebJS loop');
}

// 4. Wrap initial inject in retry loop
const badInject = `        await page.goto(WhatsWebURL, {
            waitUntil: 'load',
            timeout: 0,
            referer: 'https://whatsapp.com/',
        });

        await this.inject();`;

const safeInject = `        await page.goto(WhatsWebURL, {
            waitUntil: 'load',
            timeout: 0,
            referer: 'https://whatsapp.com/',
        });

        let injectRetries = 5;
        while (injectRetries > 0) {
            try {
                await this.inject();
                break;
            } catch (err) {
                injectRetries--;
                if (injectRetries === 0) throw err;
                console.log(\`[INJECT RETRY] Transient error during inject (\${err.message}). Retrying in 2s... (\${injectRetries} left)\`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }`;

if (code.includes(badInject)) {
    code = code.replace(badInject, safeInject);
    modified = true;
    console.log('[patch-wwebjs] Patched initial inject retry loop');
}

if (modified) {
    fs.writeFileSync(clientPath, code, 'utf8');
    console.log('[patch-wwebjs] Client.js successfully patched for production stability!');
} else {
    console.log('[patch-wwebjs] Client.js is already patched.');
}

// 5. Patch Message.js for $1 and _serialized
const messagePath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'structures', 'Message.js');
if (fs.existsSync(messagePath)) {
    let msgCode = fs.readFileSync(messagePath, 'utf8');
    let msgModified = false;

    // A. Fix constructor this.id assignment
    const oldId = '        this.id = data.id;';
    const newId = `        this.id = data.id;
        if (this.id && !this.id._serialized) {
            this.id._serialized = this.id.$1 || (this.id.remote ? \`\${this.id.fromMe ? 'true' : 'false'}_\${this.id.remote._serialized || this.id.remote.$1 || this.id.remote}_\${this.id.id}\` : undefined);
        }`;
    if (msgCode.includes(oldId) && !msgCode.includes('this.id.$1')) {
        msgCode = msgCode.replace(oldId, newId);
        msgModified = true;
        console.log('[patch-wwebjs] Patched Message.js this.id initialization');
    }

    // B. Fix downloadMedia evaluate call argument
    const oldDownloadArg = '        }, this.id._serialized);';
    const newDownloadArg = `        }, this.id?._serialized || this.id?.$1 || (this.id && typeof this.id === 'object' ? \`\${this.id.fromMe ? 'true' : 'false'}_\${this.id.remote?._serialized || this.id.remote?.$1 || this.id.remote}_\${this.id.id}\` : this.id));`;
    if (msgCode.includes(oldDownloadArg)) {
        msgCode = msgCode.replace(oldDownloadArg, newDownloadArg);
        msgModified = true;
        console.log('[patch-wwebjs] Patched Message.js downloadMedia ID argument');
    }

    // C. Fix downloadMedia Msg.get in browser evaluate
    const oldMsgGet = `            const msg =
                window.require('WAWebCollections').Msg.get(msgId) ||
                (
                    await window
                        .require('WAWebCollections')
                        .Msg.getMessagesById([msgId])
                )?.messages?.[0];`;
    const newMsgGet = `            let msg =
                window.require('WAWebCollections').Msg.get(msgId) ||
                (
                    await window
                        .require('WAWebCollections')
                        .Msg.getMessagesById([msgId])
                        .catch(() => null)
                )?.messages?.[0];

            if (!msg && window.require('WAWebCollections').Msg?.models) {
                msg = window.require('WAWebCollections').Msg.models.find(m => 
                    m.id && (m.id._serialized === msgId || m.id.$1 === msgId || m.id.id === msgId)
                );
            }`;
    if (msgCode.includes(oldMsgGet)) {
        msgCode = msgCode.replace(oldMsgGet, newMsgGet);
        msgModified = true;
        console.log('[patch-wwebjs] Patched Message.js Msg.get evaluate fallback');
    }

    if (msgModified) {
        fs.writeFileSync(messagePath, msgCode, 'utf8');
        console.log('[patch-wwebjs] Message.js successfully patched!');
    } else {
        console.log('[patch-wwebjs] Message.js is already patched.');
    }
}

// 6. Patch Injected/Utils.js for $1 and _serialized
const utilsPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
if (fs.existsSync(utilsPath)) {
    let utilsCode = fs.readFileSync(utilsPath, 'utf8');
    let utilsModified = false;

    const oldRemote = `        if (typeof msg.id.remote === 'object') {
            msg.id = Object.assign({}, msg.id, {
                remote: msg.id.remote._serialized,
            });
        }`;
    const newRemote = `        if (msg.id) {
            if (!msg.id._serialized && msg.id.$1) {
                msg.id._serialized = msg.id.$1;
            }
            if (typeof msg.id.remote === 'object') {
                msg.id = Object.assign({}, msg.id, {
                    remote: msg.id.remote._serialized || msg.id.remote.$1,
                });
            }
        }`;
    if (utilsCode.includes(oldRemote)) {
        utilsCode = utilsCode.replace(oldRemote, newRemote);
        utilsModified = true;
        console.log('[patch-wwebjs] Patched Injected/Utils.js remote & $1 backfill');
    }

    if (utilsModified) {
        fs.writeFileSync(utilsPath, utilsCode, 'utf8');
        console.log('[patch-wwebjs] Injected/Utils.js successfully patched!');
    } else {
        console.log('[patch-wwebjs] Injected/Utils.js is already patched.');
    }
}
