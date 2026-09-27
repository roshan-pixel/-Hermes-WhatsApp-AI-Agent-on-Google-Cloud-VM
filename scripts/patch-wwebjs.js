/**
 * Automatic Post-Install Patch for whatsapp-web.js
 * 
 * Fixes critical upstream Puppeteer / Chrome CDP disconnect issues:
 * 1. Prevents unhandled rejections on internal subframe navigations in pupPage.on('framenavigated').
 * 2. Adds .catch() error guards on polling evaluation loops (window.Debug?.VERSION and window.WWebJS).
 * 3. Adds transient error retries to initial Client.inject().
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
    console.log('[patch-wwebjs] whatsapp-web.js successfully patched for production stability!');
} else {
    console.log('[patch-wwebjs] whatsapp-web.js is already patched.');
}
