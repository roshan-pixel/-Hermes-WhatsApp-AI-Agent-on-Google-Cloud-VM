const { sendEmailViaKimi } = require('./kimiMail');

async function test() {
    console.log('Testing sendEmailViaKimi to roshanrathore7700@gmail.com...');
    const res = await sendEmailViaKimi({
        to: 'roshanrathore7700@gmail.com',
        subject: 'Hermes WhatsApp Integration Test',
        body: 'Hello Roshan!\n\nThis is an automated test from your Hermes WhatsApp assistant using Kimi WebBridge.\n\nAll systems operational!'
    });
    console.log('Result:', JSON.stringify(res, null, 2));
}

test().catch(console.error);
