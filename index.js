require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const express = require('express');
const db = require('./db');
const { TECHNICIANS, CONFIRM_KEYWORDS, CLOSE_KEYWORD } = require('./config');
const { parseCloseMessage, formatCloseMessage } = require('./parts');
const { scheduleLeadFollowups, scheduleProgressCheck, scheduleClosingReminder, scheduleAppointmentReminders, cancelTimers } = require('./scheduler');
const { generateDailyReport } = require('./reports');

let currentQR = null;
const app = express();

app.get('/', (req, res) => res.send('LeadTracker Pro is running'));
app.get('/qr', (req, res) => {
  if (currentQR) {
    const url = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(currentQR);
    res.send('<html><body style="text-align:center"><h2>Scan with WhatsApp Business</h2><img src="' + url + '"/><p>Refresh if expired</p></body></html>');
  } else {
    res.send('<html><body><h2>No QR yet - refresh in 10 seconds</h2></body></html>');
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
  sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', function(update) {
    if (update.qr) {
      currentQR = update.qr;
      console.log('QR ready - visit /qr to scan');
    }
    if (update.connection === 'close') {
      var code = update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode;
      if (code !== DisconnectReason.loggedOut) connectToWhatsApp();
    }
    if (update.connection === 'open') {
      currentQR = null;
      console.log('WhatsApp connected!');
    }
  });

  sock.ev.on('messages.upsert', async function(upsert) {
    var msg = upsert.messages[0];
    if (!msg || !msg.message || msg.key.fromMe) return;
    if (!msg.key.remoteJid.endsWith('@g.us')) return;

    var groupId = msg.key.remoteJid;
    var text = (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '').trim();
    var textLower = text.toLowerCase();
    if (!text) return;

    var groupRecord = db.getGroup(groupId);

    if (textLower.startsWith('register ')) {
      var tName = text.split(' ')[1];
      if (TECHNICIANS[tName]) {
        db.setGroup(groupId, tName, TECHNICIANS[tName].commission);
        await sendMessage(groupId, 'Group registered for ' + tName + ' (' + (TECHNICIANS[tName].commission * 100) + '%)');
      }
      return;
    }

    if (!groupRecord) return;
    var tech = groupRecord.tech_name;
    var comm = TECHNICIANS[tech] ? TECHNICIANS[tech].commission : groupRecord.commission_pct;

    if (CONFIRM_KEYWORDS.some(function(kw) { return textLower === kw || textLower.startsWith(kw + ' '); })) {
      var lead = db.getLatestLeadByStatus(tech, 'pending');
      if (lead) {
        db.updateLead(lead.id, { status: 'confirmed', confirmed_at: new Date().toISOString() });
        cancelTimers(lead.id);
        scheduleProgressCheck(lead.id, groupId, tech);
        await sendMessage(groupId, 'Got it ' + tech + '! I will check in with you in 5 minutes.');
      }
      return;
    }

    if (textLower.startsWith(CLOSE_KEYWORD)) {
      var calc = parseCloseMessage(textLower, comm);
      var aLead = db.getLatestLeadByStatus(tech, 'confirmed', 'in_progress', 'scheduled');
      if (aLead) {
        cancelTimers(aLead.id);
        db.updateLead(aLead.id, { status: 'closed', closed_at: new Date().toISOString(), sale_amount: calc.totalSale, cash_collected: calc.cashCollected, parts_tech: calc.partsCostTech, parts_company: calc.partsCostCompany });
        var sum = formatCloseMessage(tech, comm, calc);
        await sendMessage(groupId, sum);
        await alertBoss('JOB CLOSED - ' + tech + '\n' + sum);
      }
      return;
    }

    var cLead = db.getLatestLeadByStatus(tech, 'confirmed');
    if (cLead && cLead.progress_asked) {
      if (textLower === 'yes' || textLower.includes('in progress') || textLower === 'omw') {
        db.updateLead(cLead.id, { status: 'in_progress' });
        scheduleClosingReminder(cLead.id, groupId, tech);
        await sendMessage(groupId, 'Great! I will remind you to close the job in 2 hours.');
        return;
      }
      var tm = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
      if ((textLower.includes('schedule') || tm) && tm) {
        scheduleAppointmentReminders(cLead.id, groupId, tech, tm[1]);
        db.updateLead(cLead.id, { status: 'scheduled', scheduled_time: tm[1] });
        await sendMessage(groupId, 'Job scheduled for ' + tm[1] + '. Reminder 1 hour before!');
        await alertBoss('SCHEDULED - ' + tech + ' at ' + tm[1]);
        return;
      }
      if (textLower.includes('cancel')) {
        db.updateLead(cLead.id, { status: 'cancelled' });
        await sendMessage(groupId, 'Job cancelled.');
        await alertBoss('CANCELLED - ' + tech);
        return;
      }
      if (textLower.includes('no answer')) {
        db.updateLead(cLead.id, { status: 'no_answer' });
        await sendMessage(groupId, 'Customer not answering. Boss alerted.');
        await alertBoss('NO ANSWER - ' + tech);
        return;
      }
    }

    if (textLower.startsWith('reschedule')) {
      var sLead = db.getLatestLeadByStatus(tech, 'scheduled');
      if (sLead) {
        var tm2 = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
        if (tm2) {
          scheduleAppointmentReminders(sLead.id, groupId, tech, tm2[1]);
          db.updateLead(sLead.id, { scheduled_time: tm2[1] });
          await sendMessage(groupId, 'Rescheduled to ' + tm2[1]);
          await alertBoss('RESCHEDULED - ' + tech + ' to ' + tm2[1]);
        }
      }
      return;
    }

    if (text.length > 10 && !textLower.startsWith('register')) {
      var lid = db.createLead(groupId, tech, text);
      console.log('New lead #' + lid + ' for ' + tech);
      scheduleLeadFollowups(lid, groupId, tech);
    }
  });
}

cron.schedule('0 23 * * *', async function() {
  if (!process.env.BOSS_PHONE || !sock) return;
  var report = await generateDailyReport();
  await sendMessage(process.env.BOSS_PHONE + '@s.whatsapp.net', report);
}, { timezone: 'America/New_York' });

connectToWhatsApp();
