const db = require('./db');
const { sendMessage, alertBoss } = require('./whatsapp');

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
  if (scheduled <= now) scheduled.setDate(scheduled.getDate() + 1);
  return scheduled;
}

function scheduleLeadFollowups(leadId, groupId, techName) {
  cancelTimers(leadId);
  const t1 = setTimeout(async () => {
    const lead = db.getLead(leadId);
    if (lead && lead.status === 'pending') {
      await sendMessage(groupId, `⚠️ @${techName} please confirm you received this job! Reply "k" or "ok"`);
      db.updateLead(leadId, { follow_up_1_sent: true });
    }
  }, 1 * 60 * 1000);
  addTimer(leadId, t1);

  const t2 = setTimeout(async () => {
    const lead = db.getLead(leadId);
    if (lead && lead.status === 'pending') {
      db.updateLead(leadId, { boss_alerted: true });
      await alertBoss(`🚨 NO RESPONSE - ${techName}\n\nLead not confirmed after 2 minutes:\n"${lead.message}"\n\nPlease follow up!`);
    }
  }, 2 * 60 * 1000);
  addTimer(leadId, t2);
}

function scheduleProgressCheck(leadId, groupId, techName) {
  cancelTimers(leadId);
  const t1 = setTimeout(async () => {
    const lead = db.getLead(leadId);
    if (lead && lead.status === 'confirmed') {
      await sendMessage(groupId, `👷 ${techName}, is the job in progress? Reply:\n"yes" - in progress\n"scheduled 3pm" - for later\n"cancelled" - cancelled\n"no answer" - customer not answering`);
      db.updateLead(leadId, { progress_asked: true });
    }
  }, 5 * 60 * 1000);
  addTimer(leadId, t1);
}

function scheduleClosingReminder(leadId, groupId, techName) {
  cancelTimers(leadId);
  const t1 = setTimeout(async () => {
    const lead = db.getLead(leadId);
    if (lead && lead.status === 'in_progress') {
      await sendMessage(groupId, `💰 ${techName}, time to close the job!\nReply: "closed 300 cash" or "closed 500 card"`);
    }
  }, 2 * 60 * 60 * 1000);
  addTimer(leadId, t1);
}

function scheduleAppointmentReminders(leadId, groupId, techName, scheduledTime) {
  cancelTimers(leadId);
  const now = new Date();
  const appointmentTime = typeof scheduledTime === 'string' ? parseScheduledTime(scheduledTime) : scheduledTime;
  const msUntilAppointment = appointmentTime - now;
  const msUntilReminder = msUntilAppointment - (60 * 60 * 1000);
  const msUntilFollowup = msUntilAppointment + (60 * 60 * 1000);

  if (msUntilReminder > 0) {
    const t1 = setTimeout(async () => {
      await sendMessage(groupId, `⏰ Reminder ${techName}: Scheduled job in 1 hour at ${appointmentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}!`);
    }, msUntilReminder);
    addTimer(leadId, t1);
  }
  if (msUntilAppointment > 0) {
    const t2 = setTimeout(async () => {
      await sendMessage(groupId, `🔔 ${techName}, time for your scheduled job!`);
    }, msUntilAppointment);
    addTimer(leadId, t2);
  }
  if (msUntilFollowup > 0) {
    const t3 = setTimeout(async () => {
      const lead = db.getLead(leadId);
      if (lead && lead.status !== 'closed') {
        await sendMessage(groupId, `📋 ${techName}, update on scheduled job?\n"closed [amount] [cash/card]", "cancelled", or "reschedule [time]"`);
      }
    }, msUntilFollowup);
    addTimer(leadId, t3);
  }
  return appointmentTime;
}

module.exports = { scheduleLeadFollowups, scheduleProgressCheck, scheduleClosingReminder, scheduleAppointmentReminders, cancelTimers, parseScheduledTime };
