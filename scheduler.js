const db = require('./db');
const { sendMessage, alertBoss } = require('./whatsapp');

// Store all active timers so we can cancel them if needed
const activeTimers = {};

function cancelTimers(leadId) {
  if (activeTimers[leadId]) {
    activeTimers[leadId].forEach(t => clearTimeout(t));
    delete activeTimers[leadId];
  }
}

function addTimer(leadId, timer) {
  if (!activeTimers[leadId]) activeTimers[leadId] = [];
  activeTimers[leadId].push(timer);
}

// Parse time string like "3pm", "3:30pm", "15:00" into today's Date
function parseScheduledTime(timeStr) {
  const now = new Date();
  const str = timeStr.toLowerCase().trim();
  
  let hours, minutes = 0;
  
  if (str.includes('pm') || str.includes('am')) {
    const isPM = str.includes('pm');
    const timePart = str.replace('pm', '').replace('am', '').trim();
    const parts = timePart.split(':');
    hours = parseInt(parts[0]);
    minutes = parts[1] ? parseInt(parts[1]) : 0;
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
  } else {
    const parts = str.split(':');
    hours = parseInt(parts[0]);
    minutes = parts[1] ? parseInt(parts[1]) : 0;
  }

  const scheduled = new Date(now);
  scheduled.setHours(hours, minutes, 0, 0);
  
  // If time already passed today, schedule for tomorrow
  if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1);
  
  return scheduled;
}

// Schedule all follow-ups after a new lead comes in
function scheduleLeadFollowups(leadId, groupId, techName) {
  cancelTimers(leadId);

  // 1 MIN: Tag tech if no confirmation
  const t1 = setTimeout(async () => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (lead && lead.status === 'pending') {
      await sendMessage(groupId, `⚠️ @${techName} please confirm you received this job! Reply "k" or "ok"`);
      db.prepare('UPDATE leads SET follow_up_1_sent = 1 WHERE id = ?').run(leadId);
    }
  }, 1 * 60 * 1000);
  addTimer(leadId, t1);

  // 2 MIN: Alert boss if still no confirmation
  const t2 = setTimeout(async () => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (lead && lead.status === 'pending') {
      db.prepare('UPDATE leads SET boss_alerted = 1 WHERE id = ?').run(leadId);
      await alertBoss(`🚨 NO RESPONSE - ${techName}\n\nLead not confirmed after 2 minutes:\n"${lead.message}"\n\nPlease follow up!`);
    }
  }, 2 * 60 * 1000);
  addTimer(leadId, t2);
}

// Schedule progress check 5 min after confirmation
function scheduleProgressCheck(leadId, groupId, techName) {
  cancelTimers(leadId);

  const t1 = setTimeout(async () => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (lead && lead.status === 'confirmed') {
      await sendMessage(groupId, `👷 ${techName}, is the job in progress? Reply:\n"yes" - in progress\n"scheduled 3pm" - scheduled for later\n"cancelled" - job cancelled\n"no answer" - customer not answering`);
      db.prepare('UPDATE leads SET progress_asked = 1 WHERE id = ?').run(leadId);
    }
  }, 5 * 60 * 1000);
  addTimer(leadId, t1);
}

// Schedule closing reminder 2 hours after job starts
function scheduleClosingReminder(leadId, groupId, techName) {
  cancelTimers(leadId);

  const t1 = setTimeout(async () => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (lead && lead.status === 'in_progress') {
      await sendMessage(groupId, `💰 ${techName}, time to close the job!\nReply: "closed [amount] [cash/card]"\nExample: "closed 300 cash" or "closed 500 card"`);
    }
  }, 2 * 60 * 60 * 1000);
  addTimer(leadId, t1);
}

// Schedule reminders for a scheduled appointment
function scheduleAppointmentReminders(leadId, groupId, techName, scheduledTime) {
  cancelTimers(leadId);

  const now = new Date();
  const appointmentTime = typeof scheduledTime === 'string' 
    ? parseScheduledTime(scheduledTime) 
    : scheduledTime;

  const msUntilAppointment = appointmentTime - now;
  const msUntilReminder = msUntilAppointment - (60 * 60 * 1000); // 1 hour before
  const msUntilFollowup = msUntilAppointment + (60 * 60 * 1000); // 1 hour after

  // 1 hour before reminder
  if (msUntilReminder > 0) {
    const t1 = setTimeout(async () => {
      await sendMessage(groupId, `⏰ Reminder ${techName}: You have a scheduled job in 1 hour at ${appointmentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}!`);
    }, msUntilReminder);
    addTimer(leadId, t1);
  }

  // At appointment time
  if (msUntilAppointment > 0) {
    const t2 = setTimeout(async () => {
      await sendMessage(groupId, `🔔 ${techName}, it's time for your scheduled job! Are you on your way?`);
    }, msUntilAppointment);
    addTimer(leadId, t2);
  }

  // 1 hour after appointment - ask for update
  if (msUntilFollowup > 0) {
    const t3 = setTimeout(async () => {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (lead && lead.status !== 'closed') {
        await sendMessage(groupId, `📋 ${techName}, update on the scheduled job?\nReply: "closed [amount] [cash/card]", "cancelled", or "reschedule [new time]"`);
      }
    }, msUntilFollowup);
    addTimer(leadId, t3);
  }

  console.log(`📅 Appointment reminders scheduled for ${techName} at ${appointmentTime}`);
  return appointmentTime;
}

module.exports = { 
  scheduleLeadFollowups, 
  scheduleProgressCheck, 
  scheduleClosingReminder,
  scheduleAppointmentReminders,
  cancelTimers,
  parseScheduledTime
};
