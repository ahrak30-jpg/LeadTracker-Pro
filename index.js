require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const { sendMessage, alertBoss } = require('./whatsapp');
const { TECHNICIANS, CONFIRM_KEYWORDS, CLOSE_KEYWORD } = require('./config');
const { generateDailyReport } = require('./reports');
const { updateTechLocation, getClosestTechs } = require('./location');
const { parseCloseMessage, formatCloseMessage } = require('./parts');
const { 
  scheduleLeadFollowups, 
  scheduleProgressCheck, 
  scheduleClosingReminder,
  scheduleAppointmentReminders,
  cancelTimers
} = require('./scheduler');

const app = express();
app.use(express.json());

// ─── WEBHOOK VERIFICATION ────────────────────────────────────────────────────
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

// ─── INCOMING MESSAGES ───────────────────────────────────────────────────────
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

    const groupRecord = db.prepare('SELECT * FROM groups WHERE group_id = ?').get(from);

    // ── LOCATION MESSAGE ──────────────────────────────────────────────────────
    if (msgType === 'location') {
      const { latitude, longitude } = msg.location;
      if (groupRecord) {
        updateTechLocation(groupRecord.tech_name, latitude, longitude);
      }
      return;
    }

    const text = msg.text?.body?.trim() || '';
    const textLower = text.toLowerCase();

    // ── SETUP: Register group ─────────────────────────────────────────────────
    if (textLower.startsWith('register ')) {
      const techName = text.split(' ')[1];
      if (TECHNICIANS[techName]) {
        db.prepare(`
          INSERT OR REPLACE INTO groups (group_id, tech_name, commission_pct)
          VALUES (?, ?, ?)
        `).run(from, techName, TECHNICIANS[techName].commission);
        await sendMessage(from, `✅ Group registered for ${techName} (${TECHNICIANS[techName].commission * 100}%)\n\nI will now track all leads in this group.`);
      }
      return;
    }

    if (!groupRecord) return;
    const techName = groupRecord.tech_name;
    const commission = TECHNICIANS[techName]?.commission || groupRecord.commission_pct;

    // ── CONFIRMATION (k, ok, done, etc.) ─────────────────────────────────────
    if (CONFIRM_KEYWORDS.some(kw => textLower === kw || textLower.startsWith(kw + ' '))) {
      const pendingLead = db.prepare(`
        SELECT * FROM leads WHERE tech_name = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `).get(techName);

      if (pendingLead) {
        db.prepare(`UPDATE leads SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(pendingLead.id);
        cancelTimers(pendingLead.id);
        scheduleProgressCheck(pendingLead.id, from, techName);
        await sendMessage(from, `✅ Got it ${techName}! I'll check in with you in 5 minutes.`);
      }
      return;
    }

    // ── JOB CLOSE ────────────────────────────────────────────────────────────
    // Format: "closed 105 50cash 5parts-tech 10parts-company"
    if (textLower.startsWith(CLOSE_KEYWORD)) {
      const calc = parseCloseMessage(textLower, commission);

      const activeLead = db.prepare(`
        SELECT * FROM leads WHERE tech_name = ? AND status IN ('confirmed','in_progress','scheduled')
        ORDER BY created_at DESC LIMIT 1
      `).get(techName);

      if (activeLead) {
        cancelTimers(activeLead.id);
        db.prepare(`
          UPDATE leads SET status = 'closed', closed_at = CURRENT_TIMESTAMP, 
          sale_amount = ?, cash_collected = ?, parts_tech = ?, parts_company = ?
          WHERE id = ?
        `).run(calc.totalSale, calc.cashCollected, calc.partsCostTech, calc.partsCostCompany, activeLead.id);

        const summary = formatCloseMessage(techName, commission, calc);
        await sendMessage(from, summary);
        await alertBoss(`✅ JOB CLOSED - ${techName}\n${summary}`);
      }
      return;
    }

    // ── PROGRESS RESPONSE ─────────────────────────────────────────────────────
    const confirmedLead = db.prepare(`
      SELECT * FROM leads WHERE tech_name = ? AND status = 'confirmed' AND progress_asked = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(techName);

    if (confirmedLead) {
      if (textLower === 'yes' || textLower.includes('in progress') || textLower.includes('on my way') || textLower === 'omw') {
        db.prepare(`UPDATE leads SET status = 'in_progress' WHERE id = ?`).run(confirmedLead.id);
        scheduleClosingReminder(confirmedLead.id, from, techName);
        await sendMessage(from, `💪 Great! I'll remind you to close the job in 2 hours.`);
        return;
      }

      if (textLower.includes('schedule') || textLower.match(/\d+(am|pm)/i)) {
        const timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i) || text.match(/(\d{1,2}:\d{2})/);
        const timeStr = timeMatch ? timeMatch[1] : null;
        if (timeStr) {
          scheduleAppointmentReminders(confirmedLead.id, from, techName, timeStr);
          db.prepare(`UPDATE leads SET status = 'scheduled', scheduled_time = ? WHERE id = ?`).run(timeStr, confirmedLead.id);
          await sendMessage(from, `📅 Got it! Job scheduled for ${timeStr}.\nI'll remind you 1 hour before and follow up after.`);
          await alertBoss(`📅 SCHEDULED - ${techName}\nJob scheduled for ${timeStr}`);
          return;
        }
      }

      if (textLower.includes('cancel')) {
        db.prepare(`UPDATE leads SET status = 'cancelled', cancel_reason = 'cancelled' WHERE id = ?`).run(confirmedLead.id);
        await sendMessage(from, `❌ Job marked as cancelled.`);
        await alertBoss(`❌ CANCELLED - ${techName}\nJob: "${confirmedLead.message}"`);
        return;
      }

      if (textLower.includes('no answer') || textLower.includes('no response')) {
        db.prepare(`UPDATE leads SET status = 'no_answer', cancel_reason = 'no answer' WHERE id = ?`).run(confirmedLead.id);
        await sendMessage(from, `📵 Noted - customer not answering. I'll alert the boss.`);
        await alertBoss(`📵 NO ANSWER - ${techName}\nCustomer not answering for: "${confirmedLead.message}"`);
        return;
      }
    }

    // ── RESCHEDULE ────────────────────────────────────────────────────────────
    if (textLower.startsWith('reschedule')) {
      const scheduledLead = db.prepare(`
        SELECT * FROM leads WHERE tech_name = ? AND status = 'scheduled'
        ORDER BY created_at DESC LIMIT 1
      `).get(techName);

      if (scheduledLead) {
        const timeMatch = text.match(/(\d{1,2}:?\d{0,2}\s*(?:am|pm|AM|PM))/i);
        if (timeMatch) {
          const newTime = timeMatch[1];
          scheduleAppointmentReminders(scheduledLead.id, from, techName, newTime);
          db.prepare(`UPDATE leads SET scheduled_time = ? WHERE id = ?`).run(newTime, scheduledLead.id);
          await sendMessage(from, `📅 Rescheduled to ${newTime}! Reminders updated.`);
          await alertBoss(`🔄 RESCHEDULED - ${techName}\nNew time: ${newTime}`);
        }
      }
      return;
    }

    // ── NEW LEAD ──────────────────────────────────────────────────────────────
    if (text.length > 10 && !textLower.startsWith('register')) {
      const lead = db.prepare(`
        INSERT INTO leads (group_id, tech_name, message, status)
        VALUES (?, ?, ?, 'pending')
      `).run(from, techName, text);

      const leadId = lead.lastInsertRowid;
      console.log(`📋 New lead #${leadId} for ${techName}`);
      scheduleLeadFollowups(leadId, from, techName);

      // If lead has location, find closest techs for boss
      if (msg.location) {
        const closest = getClosestTechs(msg.location.latitude, msg.location.longitude, techName);
        if (closest.length > 0) {
          const options = closest.map((t, i) => `${i+1}. ${t.techName} - ${t.distance.toFixed(1)} miles`).join('\n');
          await alertBoss(`📋 NEW LEAD - ${techName}'s group\n\n"${text}"\n\n🗺️ Closest techs:\n${options}`);
        }
      }
    }

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ─── MANUAL REPORT ────────────────────────────────────────────────────────────
app.get('/report', async (req, res) => {
  await generateDailyReport();
  res.send('Report sent ✅');
});

app.get('/', (req, res) => res.send('LeadTracker Pro is running ✅'));

// ─── DAILY REPORT AT 11PM ET ──────────────────────────────────────────────────
cron.schedule('0 23 * * *', async () => {
  console.log('📊 Generating daily report...');
  await generateDailyReport();
}, { timezone: 'America/New_York' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LeadTracker Pro running on port ${PORT}`));
