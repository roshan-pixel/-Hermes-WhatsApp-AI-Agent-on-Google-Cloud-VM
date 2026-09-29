const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

async function testUploadToFolder() {
    const keyPath = path.join(__dirname, 'google-drive-key.json');
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    console.log('Service Account Email:', key.client_email);

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(JSON.stringify({
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    })).toString('base64url');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const signature = signer.sign(key.private_key, 'base64url');
    const jwt = `${header}.${claim}.${signature}`;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });

    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
        console.error('Failed to get token:', tokenData);
        return;
    }

    console.log('OAuth Token OK.');

    const boundary = 'hermes_test_boundary_' + Date.now();
    const metadata = {
        name: 'hermes_welcome_vault.txt',
        mimeType: 'text/plain',
        description: 'Uploaded by Hermes WhatsApp AI Agent to user folder',
        parents: ['1g_P5pR04n6VDqO1iZQGYfJf-Pvj8T05r']
    };
    const fileContent = 'Hermes WhatsApp Agent connected to Google Drive Vault successfully!\nTimestamp: ' + new Date().toISOString() + '\nFolder ID: 1g_P5pR04n6VDqO1iZQGYfJf-Pvj8T05r';

    const multipartBody = 
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) + `\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: text/plain\r\n\r\n` +
        fileContent + `\r\n` +
        `--${boundary}--`;

    const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
    });

    if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        console.error('Upload Error:', uploadResp.status, errText);
        return;
    }

    const fileResult = await uploadResp.json();
    console.log('SUCCESS! File uploaded to Hermes Vault!');
    console.log('File ID:', fileResult.id);
    console.log('File Name:', fileResult.name);
    console.log('Direct Drive Link:', fileResult.webViewLink || `https://drive.google.com/file/d/${fileResult.id}/view?usp=sharing`);
}

testUploadToFolder().catch(console.error);
