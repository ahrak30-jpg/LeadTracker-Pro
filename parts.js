/**
 * Parse closing message and calculate balances
 * 
 * Format: "closed [total] [cash]cash [amount]parts-tech [amount]parts-company"
 * Examples:
 *   "closed 105 50cash 5parts-tech"
 *   "closed 200 100cash 10parts-tech 5parts-company"
 *   "closed 300 card"
 *   "closed 500 cash"
 */
function parseCloseMessage(text, commissionPct) {
  const parts = text.toLowerCase().split(' ');
  
  const totalSale = parseFloat(parts[1]) || 0;
  let cashCollected = 0;
  let partsCostTech = 0;     // Tech paid for parts
  let partsCostCompany = 0;  // Company paid for parts

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];

    // Cash: "100cash" or just "cash" = full amount
    if (part.includes('cash')) {
      const cashMatch = part.match(/(\d+)cash/);
      cashCollected = cashMatch ? parseFloat(cashMatch[1]) : totalSale;
    }

    // Card = no cash
    if (part === 'card') {
      cashCollected = 0;
    }

    // Half cash
    if (part === 'half') {
      cashCollected = totalSale / 2;
    }

    // Parts paid by tech: "10parts-tech"
    if (part.includes('parts-tech')) {
      const match = part.match(/(\d+)parts-tech/);
      if (match) partsCostTech += parseFloat(match[1]);
    }

    // Parts paid by company: "5parts-company"
    if (part.includes('parts-company')) {
      const match = part.match(/(\d+)parts-company/);
      if (match) partsCostCompany += parseFloat(match[1]);
    }
  }

  const totalParts = partsCostTech + partsCostCompany;
  const netJobValue = totalSale - totalParts;
  const techEarns = netJobValue * commissionPct;
  
  // Tech reimbursement: gets back parts they paid for
  const techTotal = techEarns + partsCostTech;
  
  // Balance: positive = company owes tech, negative = tech owes company
  const balance = techTotal - cashCollected;

  return {
    totalSale,
    cashCollected,
    partsCostTech,
    partsCostCompany,
    totalParts,
    netJobValue,
    techEarns,
    techTotal,
    balance
  };
}

function formatCloseMessage(techName, commissionPct, calc) {
  const { totalSale, cashCollected, partsCostTech, partsCostCompany, netJobValue, techEarns, techTotal, balance } = calc;

  let msg = `✅ Job closed!\n`;
  msg += `💰 Total Sale: $${totalSale.toFixed(2)}\n`;
  
  if (partsCostTech > 0) msg += `🔧 Parts (tech paid): $${partsCostTech.toFixed(2)}\n`;
  if (partsCostCompany > 0) msg += `🔧 Parts (company paid): $${partsCostCompany.toFixed(2)}\n`;
  
  msg += `📊 Net Job: $${netJobValue.toFixed(2)}\n`;
  msg += `💵 ${techName} earns (${(commissionPct*100).toFixed(0)}%): $${techEarns.toFixed(2)}`;
  if (partsCostTech > 0) msg += ` + $${partsCostTech.toFixed(2)} parts reimbursement = $${techTotal.toFixed(2)}`;
  msg += `\n💵 Cash Collected: $${cashCollected.toFixed(2)}\n`;

  if (balance > 0) {
    msg += `\n📌 Company owes ${techName}: $${balance.toFixed(2)} 💸`;
  } else if (balance < 0) {
    msg += `\n📌 ${techName} owes company: $${Math.abs(balance).toFixed(2)} ⚠️`;
  } else {
    msg += `\n📌 All settled ✅`;
  }

  return msg;
}

module.exports = { parseCloseMessage, formatCloseMessage };
