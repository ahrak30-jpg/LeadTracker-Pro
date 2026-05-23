require('dotenv').config();
process.on('uncaughtException', (err) => {
  console.error('CRASH:', err);
});
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const { sendMessage, alertBoss } = require('./whatsapp');
const { TECHNICIANS, CONFIRM_KEYWORDS, CLOSE_KEYWORD } = require('./config');
const { generateDailyReport } = require('./reports');
const { updateTechLocation, getClosestTechs } = require('./location');
const { parseCloseMessage, formatCloseMessage } = require('./parts');
const { scheduleLeadFollowups, scheduleProgressCheck, scheduleClosingReminder, scheduleAppointmentReminders, cancelTimers } = require('./scheduler');

const app = express();
app.use(express.json());

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages;
    if (!messages?.length) return;

    const msg = messages[0];
    const from = msg.from;
    const msgType = msg.type;

    const groupRecord = db.getGroup(from);

    if (msgType === 'location') {
      const { latitude, longitude } = msg.location;
      if (groupRecord) updateTechLocation(groupRecord.tech_name, latitude, longitude);
      return;
    }

    const text = msg.text?.body?.trim() || '';
    const textLower = text.toLowerCase();

    if (textLower.startsWith('register ')) {
      const techName = text.split(' ')[1];
      if (TECHNICIANS[techName]) {
        db.setGroup(from, techName, TECHNICIANS[techName].commission);
        await sendMessage(from, `✅ Group registered for ${techName} (${TECHNICIANS[techName].commission * 100}%)`);
      }
      return;
    }

    if (!groupRecord) return;
    const techName = groupRecord.tech_name;
    const commission = TECHNICIANS[techName]?.commission || groupRecord.commission_pct;

    if (CONFIRM_KEYWORDS.some(kw => textLower === kw || textLower.startsWith(kw + ' '))) {
      const pendingLead = db.getLatestLeadByStatus(techName, 'pending');
      if (pendingLead) {
        db.updateLead(pendingLead.id, { status: 'confirmed', confirmed_at: new Date().toISOString() });
        cancelTimers(pendingLead.id);
        scheduleProgressCheck(pendingLead.id, from, techName);
        await sendMessage(from, `✅ Got it ${techName}! I'll check in with you in 5 minutes.`);
      }
      return;
    }

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
        await sendMessage(from, summary);
        await alertBoss(`✅ JOB CLOSED - ${techName}\n${summary}`);
      }
      return;
    }

    const confirmedLead = db.getLatestLeadByStatus(techName, 'confirmed');
    if (confirmedLead && confirmedLead.progress_asked) {
      if (textLower === 'yes' || textLower.includes('in progress') || textLower === 'omw') {
        db.updateLead(confirmedLead.id, { status: 'in_progress' });
        scheduleClosingReminder(confirmedLead.id, from, techName);
        await sendMessage(from, `💪 Great! I'll remind you to close the job in 2 hours.`);
        return;
      }
      const timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
      if (textLower.includes('schedule') || timeMatch) {
        const timeStr = timeMatch ? timeMatch[1] : null;
        if (timeStr) {
          scheduleAppointmentReminders(confirmedLead.id, from, techName, timeStr);
          db.updateLead(confirmedLead.id, { status: 'scheduled', scheduled_time: timeStr });
          await sendMessage(from, `📅 Job scheduled for ${timeStr}. I'll remind you 1 hour before!`);
          await alertBoss(`📅 SCHEDULED - ${techName} at ${timeStr}`);
          return;
        }
      }
      if (textLower.includes('cancel')) {
        db.updateLead(confirmedLead.id, { status: 'cancelled' });
        await sendMessage(from, `❌ Job cancelled.`);
        await alertBoss(`❌ CANCELLED - ${techName}`);
        return;
      }
      if (textLower.includes('no answer')) {
        db.updateLead(confirmedLead.id, { status: 'no_answer' });
        await sendMessage(from, `📵 Noted - customer not answering.`);
        await alertBoss(`📵 NO ANSWER - ${techName}`);
        return;
      }
    }

    if (textLower.startsWith('reschedule')) {
      const scheduledLead = db.getLatestLeadByStatus(techName, 'scheduled');
      if (scheduledLead) {
        const timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
        if (timeMatch) {
          scheduleAppointmentReminders(scheduledLead.id, from, techName, timeMatch[1]);
          db.updateLead(scheduledLead.id, { scheduled_time: timeMatch[1] });
          await sendMessage(from, `📅 Rescheduled to ${timeMatch[1]}!`);
          await alertBoss(`🔄 RESCHEDULED - ${techName} to ${timeMatch[1]}`);
        }
      }
      return;
    }

    if (text.length > 10 && !textLower.startsWith('register')) {
      const leadId = db.createLead(from, techName, text);
      console.log(`📋 New lead #${leadId} for ${techName}`);
      scheduleLeadFollowups(leadId, from, techName);
    }

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/report', async (req, res) => {
  await generateDailyReport();
  res.send('Report sent ✅');
});

app.get('/', (req, res) => res.send('LeadTracker Pro is running ✅'));

cron.schedule('0 23 * * *', async () => {
  await generateDailyReport();
}, { timezone: 'America/New_York' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LeadTracker Pro running on port ${PORT}`));
