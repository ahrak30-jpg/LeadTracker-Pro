// Technician commission percentages
// Add their WhatsApp group IDs after setup
const TECHNICIANS = {
  "Ron":        { commission: 0.40, groupId: null },
  "Raz":        { commission: 0.50, groupId: null },
  "Yemini":     { commission: 0.38, groupId: null },
  "Tomer":      { commission: 0.38, groupId: null },
  "Drew":       { commission: 0.25, groupId: null },
  "Elron":      { commission: 0.45, groupId: null },
  "Sean":       { commission: 0.40, groupId: null },
  "Tampa":      { commission: 0.50, groupId: null },
  "Shlomi":     { commission: 0.50, groupId: null },
  "5star":      { commission: 0.50, groupId: null },
  "Ofek":       { commission: 0.50, groupId: null },
  "Abdallah":   { commission: 0.50, groupId: null },
  "Treza":      { commission: 0.40, groupId: null },
  "Daniel":     { commission: 0.35, groupId: null },
  "Chen":       { commission: 0.35, groupId: null },
  "Ari":        { commission: 0.35, groupId: null },
  "Dor":        { commission: 0.40, groupId: null },
  "Oren":       { commission: 0.35, groupId: null },
};

// Keywords that mean tech confirmed the lead
const CONFIRM_KEYWORDS = ['k', 'ok', 'okay', 'done', 'got it', 'on my way', 'omw', 'yes', 'yep', 'sure', 'confirmed'];

// Keywords that mean job is closed
// Format: "closed 300 cash" or "closed 500 card" or "closed 400 half"
const CLOSE_KEYWORD = 'closed';

module.exports = { TECHNICIANS, CONFIRM_KEYWORDS, CLOSE_KEYWORD };
