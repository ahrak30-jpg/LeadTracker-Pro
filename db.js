// In-memory database (resets on restart, but works without native dependencies)
// In-memory database (resets on restart, but works without native dependencies)
const data = {
  groups: {},      // group_id -> { tech_name, commission_pct }
  leads: {},       // lead_id -> lead object
  locations: {},   // tech_name -> { latitude, longitude, updated_at }
  nextId: 1
};

const db = {
  // Groups
  getGroup: (groupId) => data.groups[groupId] || null,
  setGroup: (groupId, techName, commissionPct) => {
    data.groups[groupId] = { group_id: groupId, tech_name: techName, commission_pct: commissionPct };
  },

  // Leads
  createLead: (groupId, techName, message) => {
    const id = data.nextId++;
    data.leads[id] = {
      id, group_id: groupId, tech_name: techName, message,
      status: 'pending',
      created_at: new Date().toISOString(),
      confirmed_at: null, closed_at: null,
      sale_amount: 0, cash_collected: 0,
      parts_tech: 0, parts_company: 0,
      follow_up_1_sent: false, boss_alerted: false,
      progress_asked: false, scheduled_time: null, cancel_reason: null
    };
    return id;
  },
  getLead: (id) => data.leads[id] || null,
  updateLead: (id, updates) => {
    if (data.leads[id]) {
      data.leads[id] = { ...data.leads[id], ...updates };
    }
  },
  getLatestLeadByStatus: (techName, ...statuses) => {
    return Object.values(data.leads)
      .filter(l => l.tech_name === techName && statuses.includes(l.status))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
  },
  getLeadsByTechAndDate: (techName, date) => {
    return Object.values(data.leads)
      .filter(l => l.tech_name === techName && l.created_at.startsWith(date));
  },

  // Locations
  updateLocation: (techName, latitude, longitude) => {
    data.locations[techName] = { tech_name: techName, latitude, longitude, updated_at: new Date().toISOString() };
  },
  getAllLocations: () => Object.values(data.locations),
};

module.exports = db;
