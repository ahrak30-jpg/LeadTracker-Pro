require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const express = require('express');
const db = require('./db');
const { TECHNICIANS, CONFIRM_KEYWORDS, CLOSE_KEYWORD } = require('./config');
const { parseCloseMessage, formatCloseMessage } = require('./parts');
const { scheduleLeadFollowups, scheduleProgressCheck, scheduleClosingReminder, scheduleAppointmentReminders, cancelTimers } = require('./scheduler');
const { updateTechLocation, getClosestTechs } = require('./location');
const { generateDailyReport } = require('./reports');

const app = express();
app.get('/', (req, res) => res.send('LeadTracker Pro is running ✅'));
app.get('/report', async (req, res) => {
  await generateDailyReport();
  res.send('Report sent ✅');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Show QR code to scan
client.on('qr', (qr) => {
  console.log('📱 Scan this QR code with WhatsApp Business:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp Bot is ready!');
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const groupId = chat.id._serialized;
    const text = msg.body?.trim() || '';
    const textLower = text.toLowerCase();

    // Send message helper
    const sendMessage = async (to, message) => {
      await client.sendMessage(to, message);
    };

    const alertBoss = async (message) => {
      const bossPhone = process.env.BOSS_PHONE;
      if (bossPhone) await client.sendMessage(`${bossPhone}@c.us`, message);
    };

    // Only process group messages
    if (!isGroup) return;

    const groupRecord = db.getGroup(groupId);

    // REGISTER command
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

    // Location message
    if (msg.type === 'location') {
      updateTechLocation(techName, msg.location.latitude, msg.location.longitude);
      return;
    }

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

  } catch (err) {
    console.error('Message error:', err);
  }
});

// Daily report at 11pm ET
cron.schedule('0 23 * * *', async () => {
  const bossPhone = process.env.BOSS_PHONE;
  if (!bossPhone) return;
  const report = await generateDailyReport();
  await client.sendMessage(`${bossPhone}@c.us`, report);
}, { timezone: 'America/New_York' });

client.initialize();
