const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const BASE_URL = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;

// Send a text message to a phone number or group
async function sendMessage(to, message) {
  try {
    await axios.post(BASE_URL, {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Message sent to ${to}`);
  } catch (err) {
    console.error(`❌ Failed to send message to ${to}:`, err.response?.data || err.message);
  }
}

// Send message to boss
async function alertBoss(message) {
  const bossPhone = process.env.BOSS_PHONE;
  if (bossPhone) {
    await sendMessage(bossPhone, message);
  }
}

module.exports = { sendMessage, alertBoss };
