const db = require('./db');

function getDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
    Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function updateTechLocation(techName, latitude, longitude) {
  db.updateLocation(techName, latitude, longitude);
  console.log(`📍 Location updated for ${techName}`);
}

function getClosestTechs(jobLat, jobLon, excludeTech = null) {
  return db.getAllLocations()
    .filter(loc => loc.tech_name !== excludeTech)
    .map(loc => ({
      techName: loc.tech_name,
      distance: getDistanceMiles(jobLat, jobLon, loc.latitude, loc.longitude)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
}

module.exports = { updateTechLocation, getClosestTechs };
