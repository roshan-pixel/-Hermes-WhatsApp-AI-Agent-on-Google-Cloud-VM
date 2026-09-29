const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || 'sgarmy200@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || 'gkhatigbsdvcttqo';
const GMAIL_FROM_NAME = process.env.GMAIL_FROM_NAME || 'Hermes AI Assistant';

let transporter = null;

function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                user: GMAIL_USER,
                pass: GMAIL_APP_PASSWORD
            }
        });
    }
    return transporter;
}

/**
 * Sends an email via Gmail SMTP using authenticated App Password
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject line
 * @param {string} options.text - Plain text content
 * @param {string} [options.html] - Optional HTML formatted content
 * @param {Array} [options.attachments] - Optional attachments array [{ filename, content, path }]
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendEmail({ to, subject, text, html, attachments }) {
    if (!to) {
        throw new Error('Recipient email ("to") is required.');
    }

    const mailOptions = {
        from: `"${GMAIL_FROM_NAME}" <${GMAIL_USER}>`,
        to: to.trim(),
        subject: subject || 'Message from Hermes Assistant',
        text: text || '',
        html: html || undefined,
        attachments: attachments || undefined
    };

    console.log(`[EMAIL SERVICE] Sending email to: ${to} | Subject: "${mailOptions.subject}"`);
    const transport = getTransporter();
    const info = await transport.sendMail(mailOptions);
    console.log(`[EMAIL SERVICE] Email successfully dispatched! Message ID: ${info.messageId}`);
    return {
        success: true,
        messageId: info.messageId,
        to: to.trim(),
        subject: mailOptions.subject
    };
}

module.exports = {
    sendEmail,
    GMAIL_USER
};
