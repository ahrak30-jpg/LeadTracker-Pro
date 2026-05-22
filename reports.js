const db = require('./db');
const { alertBoss } = require('./whatsapp');
const { TECHNICIANS } = require('./config');

async function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  
  let fullReport = `📊 DAILY REPORT - ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
  fullReport += `${'='.repeat(35)}\n\n`;

  let grandTotalSales = 0;
  let grandTotalParts = 0;
  let hasData = false;

  for (const [techName, techInfo] of Object.entries(TECHNICIANS)) {
    const leads = db.prepare(`
      SELECT * FROM leads WHERE tech_name = ? AND date(created_at) = ?
    `).all(techName, today);

    if (leads.length === 0) continue;
    hasData = true;

    const totalLeads = leads.length;
    const closedLeads = leads.filter(l => l.status === 'closed');
    const cancelledLeads = leads.filter(l => l.status === 'cancelled' || l.status === 'no_answer');
    
    const totalSales = closedLeads.reduce((sum, l) => sum + (l.sale_amount || 0), 0);
    const totalCash = closedLeads.reduce((sum, l) => sum + (l.cash_collected || 0), 0);
    const totalPartsTech = closedLeads.reduce((sum, l) => sum + (l.parts_tech || 0), 0);
    const totalPartsCompany = closedLeads.reduce((sum, l) => sum + (l.parts_company || 0), 0);
    const totalParts = totalPartsTech + totalPartsCompany;
    const netJobValue = totalSales - totalParts;
    const techEarns = netJobValue * techInfo.commission;
    const techTotal = techEarns + totalPartsTech; // add back parts tech paid
    const balance = techTotal - totalCash;

    grandTotalSales += totalSales;
    grandTotalParts += totalParts;

    let balanceText = '';
    if (balance > 0) {
      balanceText = `Company owes ${techName}: $${balance.toFixed(2)} 💸`;
    } else if (balance < 0) {
      balanceText = `${techName} owes company: $${Math.abs(balance).toFixed(2)} ⚠️`;
    } else {
      balanceText = `All settled ✅`;
    }

    fullReport += `👤 ${techName} (${techInfo.commission * 100}%)\n`;
    fullReport += `   Leads: ${totalLeads} | Closed: ${closedLeads.length}`;
    if (cancelledLeads.length > 0) fullReport += ` | Cancelled: ${cancelledLeads.length}`;
    fullReport += `\n`;
    fullReport += `   Total Sales: $${totalSales.toFixed(2)}\n`;
    if (totalParts > 0) {
      fullReport += `   Parts (tech): $${totalPartsTech.toFixed(2)} | Parts (company): $${totalPartsCompany.toFixed(2)}\n`;
      fullReport += `   Net Job Value: $${netJobValue.toFixed(2)}\n`;
    }
    fullReport += `   Tech Earns: $${techEarns.toFixed(2)}`;
    if (totalPartsTech > 0) fullReport += ` + $${totalPartsTech.toFixed(2)} parts = $${techTotal.toFixed(2)}`;
    fullReport += `\n`;
    fullReport += `   Cash Collected: $${totalCash.toFixed(2)}\n`;
    fullReport += `   ${balanceText}\n\n`;
  }

  if (!hasData) {
    fullReport += `No activity today.\n`;
  }

  fullReport += `${'='.repeat(35)}\n`;
  fullReport += `💰 TOTAL SALES: $${grandTotalSales.toFixed(2)}\n`;
  if (grandTotalParts > 0) fullReport += `🔧 TOTAL PARTS: $${grandTotalParts.toFixed(2)}\n`;
  fullReport += `📦 NET REVENUE: $${(grandTotalSales - grandTotalParts).toFixed(2)}`;

  await alertBoss(fullReport);
  console.log('📊 Daily report sent to boss');
}

module.exports = { generateDailyReport };
