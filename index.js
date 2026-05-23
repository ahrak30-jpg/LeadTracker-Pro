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

const app = express();
let currentQR = null;
app.get('/', (req, res) => res.send('LeadTracker Pro is running'));
app.get('/qr', (req, res) => {
  if (currentQR) {
    res.send('<html><body><h2>Scan this QR with WhatsApp Business</h2><img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(currentQR) + '"/></body></html>');
  } else {
    res.send('No QR code available yet. Refresh in a few seconds.');
  }
});
app.get('/report', async (req, res) => {
  const report = await generateDailyReport();
  res.send(report);
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('HTTP server on port ' + PORT));

let sock;

async function sendMessage(to, message) {
  try {
    await sock.sendMessage(to, { text: message });
  } catch (err) {
    console.error('Send error:', err.message);
  }
}

async function alertBoss(message) {
  const bossPhone = process.env.BOSS_PHONE;
  if (bossPhone) await sendMessage(bossPhone + '@s.whatsapp.net', message);
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', function(update) {
    var connection = update.connection;
    var lastDisconnect = update.lastDisconnect;
    var qr = update.qr;
    
    if (qr) {
  currentQR = qr;
  console.log('QR ready - visit /qr to scan');
}
    }
    if (connection === 'close') {
      var shouldReconnect = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('WhatsApp connected!');
    }
  });

  sock.ev.on('messages.upsert', async function(upsert) {
    var messages = upsert.messages;
    var msg = messages[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    var isGroup = msg.key.remoteJid.endsWith('@g.us');
    if (!isGroup) return;

    var groupId = msg.key.remoteJid;
    var text = (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '').trim();
    var textLower = text.toLowerCase();

    if (!text) return;

    var groupRecord = db.getGroup(groupId);

    if (textLower.startsWith('register ')) {
      var techName = text.split(' ')[1];
      if (TECHNICIANS[techName]) {
        db.setGroup(groupId, techName, TECHNICIANS[techName].commission);
        await sendMessage(groupId, 'Group registered for ' + techName + ' (' + (TECHNICIANS[techName].commission * 100) + '%)');
      }
      return;
    }

    if (!groupRecord) return;
    var techName2 = groupRecord.tech_name;
    var commission = TECHNICIANS[techName2] ? TECHNICIANS[techName2].commission : groupRecord.commission_pct;

    if (CONFIRM_KEYWORDS.some(function(kw) { return textLower === kw || textLower.startsWith(kw + ' '); })) {
      var pendingLead = db.getLatestLeadByStatus(techName2, 'pending');
      if (pendingLead) {
        db.updateLead(pendingLead.id, { status: 'confirmed', confirmed_at: new Date().toISOString() });
        cancelTimers(pendingLead.id);
        scheduleProgressCheck(pendingLead.id, groupId, techName2);
        await sendMessage(groupId, 'Got it ' + techName2 + '! I will check in with you in 5 minutes.');
      }
      return;
    }

    if (textLower.startsWith(CLOSE_KEYWORD)) {
      var calc = parseCloseMessage(textLower, commission);
      var activeLead = db.getLatestLeadByStatus(techName2, 'confirmed', 'in_progress', 'scheduled');
      if (activeLead) {
        cancelTimers(activeLead.id);
        db.updateLead(activeLead.id, {
          status: 'closed', closed_at: new Date().toISOString(),
          sale_amount: calc.totalSale, cash_collected: calc.cashCollected,
          parts_tech: calc.partsCostTech, parts_company: calc.partsCostCompany
        });
        var summary = formatCloseMessage(techName2, commission, calc);
        await sendMessage(groupId, summary);
        await alertBoss('JOB CLOSED - ' + techName2 + '\n' + summary);
      }
      return;
    }

    var confirmedLead = db.getLatestLeadByStatus(techName2, 'confirmed');
    if (confirmedLead && confirmedLead.progress_asked) {
      if (textLower === 'yes' || textLower.includes('in progress') || textLower === 'omw') {
        db.updateLead(confirmedLead.id, { status: 'in_progress' });
        scheduleClosingReminder(confirmedLead.id, groupId, techName2);
        await sendMessage(groupId, 'Great! I will remind you to close the job in 2 hours.');
        return;
      }
      var timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
      if (textLower.includes('schedule') || timeMatch) {
        if (timeMatch) {
          scheduleAppointmentReminders(confirmedLead.id, groupId, techName2, timeMatch[1]);
          db.updateLead(confirmedLead.id, { status: 'scheduled', scheduled_time: timeMatch[1] });
          await sendMessage(groupId, 'Job scheduled for ' + timeMatch[1] + '. I will remind you 1 hour before!');
          await alertBoss('SCHEDULED - ' + techName2 + ' at ' + timeMatch[1]);
          return;
        }
      }
      if (textLower.includes('cancel')) {
        db.updateLead(confirmedLead.id, { status: 'cancelled' });
        await sendMessage(groupId, 'Job cancelled.');
        await alertBoss('CANCELLED - ' + techName2);
        return;
      }
      if (textLower.includes('no answer')) {
        db.updateLead(confirmedLead.id, { status: 'no_answer' });
        await sendMessage(groupId, 'Customer not answering. Boss alerted.');
        await alertBoss('NO ANSWER - ' + techName2);
        return;
      }
    }

    if (textLower.startsWith('reschedule')) {
      var scheduledLead = db.getLatestLeadByStatus(techName2, 'scheduled');
      if (scheduledLead) {
        var timeMatch2 = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
        if (timeMatch2) {
          scheduleAppointmentReminders(scheduledLead.id, groupId, techName2, timeMatch2[1]);
          db.updateLead(scheduledLead.id, { scheduled_time: timeMatch2[1] });
          await sendMessage(groupId, 'Rescheduled to ' + timeMatch2[1] + '!');
          await alertBoss('RESCHEDULED - ' + techName2 + ' to ' + timeMatch2[1]);
        }
      }
      return;
    }

    if (text.length > 10 && !textLower.startsWith('register')) {
      var leadId = db.createLead(groupId, techName2, text);
      console.log('New lead #' + leadId + ' for ' + techName2);
      scheduleLeadFollowups(leadId, groupId, techName2);
    }
  });
}

cron.schedule('0 23 * * *', async function() {
  var bossPhone = process.env.BOSS_PHONE;
  if (!bossPhone || !sock) return;
  var report = await generateDailyReport();
  await sendMessage(bossPhone + '@s.whatsapp.net', report);
}, { timezone: 'America/New_York' });

connectToWhatsApp();
