const db = require('./db');
const { TECHNICIANS } = require('./config');

async function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  
  let fullReport = `📊 DAILY REPORT - ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
  fullReport += `${'='.repeat(35)}\n\n`;

  let grandTotalSales = 0;
  let grandTotalParts = 0;
  let hasData = false;

  for (const [techName, techInfo] of Object.entries(TECHNICIANS)) {
    const leads = db.getLeadsByTechAndDate(techName, today);
    if (leads.length === 0) continue;
    hasData = true;

    const closedLeads = leads.filter(l => l.status === 'closed');
    const cancelledLeads = leads.filter(l => l.status === 'cancelled' || l.status === 'no_answer');
    const totalSales = closedLeads.reduce((sum, l) => sum + (l.sale_amount || 0), 0);
    const totalCash = closedLeads.reduce((sum, l) => sum + (l.cash_collected || 0), 0);
    const totalPartsTech = closedLeads.reduce((sum, l) => sum + (l.parts_tech || 0), 0);
    const totalPartsCompany = closedLeads.reduce((sum, l) => sum + (l.parts_company || 0), 0);
    const totalParts = totalPartsTech + totalPartsCompany;
    const netJobValue = totalSales - totalParts;
    const techEarns = netJobValue * techInfo.commission;
    const techTotal = techEarns + totalPartsTech;
    const balance = techTotal - totalCash;

    grandTotalSales += totalSales;
    grandTotalParts += totalParts;

    const balanceText = balance > 0 
      ? `Company owes ${techName}: $${balance.toFixed(2)} 💸`
      : balance < 0 
        ? `${techName} owes company: $${Math.abs(balance).toFixed(2)} ⚠️`
        : `All settled ✅`;

    fullReport += `👤 ${techName} (${techInfo.commission * 100}%)\n`;
    fullReport += `   Leads: ${leads.length} | Closed: ${closedLeads.length}`;
    if (cancelledLeads.length > 0) fullReport += ` | Cancelled: ${cancelledLeads.length}`;
    fullReport += `\n   Sales: $${totalSales.toFixed(2)} | Earns: $${techTotal.toFixed(2)} | Cash: $${totalCash.toFixed(2)}\n`;
    fullReport += `   ${balanceText}\n\n`;
  }

  if (!hasData) fullReport += `No activity today.\n`;
  fullReport += `${'='.repeat(35)}\n💰 TOTAL SALES: $${grandTotalSales.toFixed(2)}`;

  return fullReport;
}

module.exports = { generateDailyReport };
