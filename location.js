const db = require('./db');

// Haversine formula to calculate distance between two coordinates in miles
function getDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Update tech location from WhatsApp live location message
function updateTechLocation(techName, latitude, longitude) {
  db.prepare(`
    INSERT OR REPLACE INTO tech_locations (tech_name, latitude, longitude, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(techName, latitude, longitude);
  console.log(`📍 Location updated for ${techName}: ${latitude}, ${longitude}`);
}

// Get top 3 closest techs to a job location
function getClosestTechs(jobLat, jobLon, excludeTech = null) {
  const locations = db.prepare('SELECT * FROM tech_locations').all();
  
  const withDistance = locations
    .filter(loc => loc.tech_name !== excludeTech)
    .map(loc => ({
      techName: loc.tech_name,
      distance: getDistanceMiles(jobLat, jobLon, loc.latitude, loc.longitude),
      updatedAt: loc.updated_at
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);

  return withDistance;
}

module.exports = { updateTechLocation, getClosestTechs };
