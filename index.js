require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cron = require('node-cron');
const express = require('express');
const db = require('./db');
const { TECHNICIANS, CONFIRM_KEYWORDS, CLOSE_KEYWORD } = require('./config');
const { parseCloseMessage, formatCloseMessage } = require('./parts');
const { scheduleLeadFollowups, scheduleProgressCheck, scheduleClosingReminder, scheduleAppointmentReminders, cancelTimers } = require('./scheduler');
const { generateDailyReport } = require('./reports');

// HTTP server for Railway health check
const app = express();
app.get('/', (req, res) => res.send('LeadTracker Pro is running ✅'));
app.get('/report', async (req, res) => {
  const report = await generateDailyReport();
  res.send(report);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 HTTP server on port ${PORT}`));

let sock;

async function sendMessage(to, message) {
  try {
    await sock.sendMessage(to, { text: message });
  } catch (err) {
    console.error('Send error:', err);
  }
}

async function alertBoss(message) {
  const bossPhone = process.env.BOSS_PHONE;
  if (bossPhone) await sendMessage(`${bossPhone}@s.whatsapp.net`, message);
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp Business:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const isGroup = msg.key.remoteJid.endsWith('@g.us');
    if (!isGroup) return;

    const groupId = msg.key.remoteJid;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
    const textLower = text.toLowerCase();

    if (!text) return;

    const groupRecord = db.getGroup(groupId);

    // REGISTER
    if (textLower.startsWith('register ')) {
      const techName = text.split(' ')[1];
      if (TECHNICIANS[techName]) {
        db.setGroup(groupId, techName, TECHNICIANS[techName].commission);
        await sendMessage(groupId, `✅ Group registered for ${techName} (${TECHNICIANS[techName].commission * 100}%)`);
      }
      return;
    }

    if (!groupRecord) return;
    const techName = groupRecord.tech_name;
    const commission = TECHNICIANS[techName]?.commission || groupRecord.commission_pct;

    // CONFIRMATION
    if (CONFIRM_KEYWORDS.some(kw => textLower === kw || textLower.startsWith(kw + ' '))) {
      const pendingLead = db.getLatestLeadByStatus(techName, 'pending');
      if (pendingLead) {
        db.updateLead(pendingLead.id, { status: 'confirmed', confirmed_at: new Date().toISOString() });
        cancelTimers(pendingLead.id);
        scheduleProgressCheck(pendingLead.id, groupId, techName);
        await sendMessage(groupId, `✅ Got it ${techName}! I'll check in with you in 5 minutes.`);
      }
      return;
    }

    // CLOSE JOB
    if (textLower.startsWith(CLOSE_KEYWORD)) {
      const calc = parseCloseMessage(textLower, commission);
      const activeLead = db.getLatestLeadByStatus(techName, 'confirmed', 'in_progress', 'scheduled');
      if (activeLead) {
        cancelTimers(activeLead.id);
        db.updateLead(activeLead.id, {
          status: 'closed', closed_at: new Date().toISOString(),
          sale_amount: calc.totalSale, cash_collected: calc.cashCollected,
          parts_tech: calc.partsCostTech, parts_company: calc.partsCostCompany
        });
        const summary = formatCloseMessage(techName, commission, calc);
        await sendMessage(groupId, summary);
        await alertBoss(`✅ JOB CLOSED - ${techName}\n${summary}`);
      }
      return;
    }

    // PROGRESS RESPONSE
    const confirmedLead = db.getLatestLeadByStatus(techName, 'confirmed');
    if (confirmedLead && confirmedLead.progress_asked) {
      if (textLower === 'yes' || textLower.includes('in progress') || textLower === 'omw') {
        db.updateLead(confirmedLead.id, { status: 'in_progress' });
        scheduleClosingReminder(confirmedLead.id, groupId, techName);
        await sendMessage(groupId, `💪 Great! I'll remind you to close the job in 2 hours.`);
        return;
      }
      const timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
      if (textLower.includes('schedule') || timeMatch) {
        if (timeMatch) {
          scheduleAppointmentReminders(confirmedLead.id, groupId, techName, timeMatch[1]);
          db.updateLead(confirmedLead.id, { status: 'scheduled', scheduled_time: timeMatch[1] });
          await sendMessage(groupId, `📅 Job scheduled for ${timeMatch[1]}. I'll remind you 1 hour before!`);
          await alertBoss(`📅 SCHEDULED - ${techName} at ${timeMatch[1]}`);
          return;
        }
      }
      if (textLower.includes('cancel')) {
        db.updateLead(confirmedLead.id, { status: 'cancelled' });
        await sendMessage(groupId, `❌ Job cancelled.`);
        await alertBoss(`❌ CANCELLED - ${techName}`);
        return;
      }
      if (textLower.includes('no answer')) {
        db.updateLead(confirmedLead.id, { status: 'no_answer' });
        await sendMessage(groupId, `📵 Customer not answering. Boss alerted.`);
        await alertBoss(`📵 NO ANSWER - ${techName}`);
        return;
      }
    }

    // RESCHEDULE
    if (textLower.startsWith('reschedule')) {
      const scheduledLead = db.getLatestLeadByStatus(techName, 'scheduled');
      if (scheduledLead) {
        const timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
        if (timeMatch) {
          scheduleAppointmentReminders(scheduledLead.id, groupId, techName, timeMatch[1]);
          db.updateLead(scheduledLead.id, { scheduled_time: timeMatch[1] });
          await sendMessage(groupId, `📅 Rescheduled to ${timeMatch[1]}!`);
          await alertBoss(`🔄 RESCHEDULED - ${techName} to ${timeMatch[1]}`);
        }
      }
      return;
    }

    // NEW LEAD
    if (text.length > 10 && !textLower.startsWith('register')) {
      const leadId = db.createLead(groupId, techName, text);
      console.log(`📋 New lead #${leadId} for ${techName}`);
      scheduleLeadFollowups(leadId, groupId, techName);
    }
  });
}

// Daily report at 11pm ET
cron.schedule('0 23 * * *', async () => {
  const bossPhone = process.env.BOSS_PHONE;
  if (!bossPhone || !sock) return;
  const report = await generateDailyReport();
  await sendMessage(`${bossPhone}@s.whatsapp.net`, report);
}, { timezone: 'America/New_York' });

connectToWhatsApp();
