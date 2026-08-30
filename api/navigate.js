// Turns a spoken destination into a real walking route.
//
// Two real calls to Google Maps Platform, chained together:
//   1. Geocoding API  — destinationText -> { lat, lng, formattedAddress }
//   2. Directions API — (current lat/lng) -> (destination lat/lng), walking mode
//
// The frontend is responsible for reading the device's position ONCE when
// navigation starts (getCurrentPosition) and sending it here as lat/lng —
// there is no live position tracking yet. Turn-by-turn steps come back as a
// plain ordered list; the frontend advances through them manually (tap or
// voice "next") rather than via GPS-triggered auto-advance. That's a
// deliberate, temporary scope cut for the prototype — see project notes.

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Google's step instructions come back as HTML (e.g. "Turn <b>right</b> onto
// <b>Kenyatta Ave</b>"), meant for on-screen display, not text-to-speech.
// Strip tags and decode the handful of entities Google actually uses here.
function htmlInstructionToSpeech(html) {
  if (!html) return '';
  return html
    .replace(/<div[^>]*>/gi, '. ')     // Google nests "Restriction" notes in a <div>; treat as a new clause
    .replace(/<\/div>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

function metersToWalkingText(meters) {
  if (meters < 1000) return `${Math.round(meters)} meters`;
  return `${(meters / 1000).toFixed(1)} kilometers`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { destinationText, lat, lng } = req.body || {};

    if (!destinationText || !destinationText.trim()) {
      return res.status(400).json({ error: 'Missing destination' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Missing current location' });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server is missing its Google Maps API key configuration' });
    }

    // ---------- Step 1: Geocode the spoken destination ----------
    // Bias results toward the user's current position (a rough bounding box
    // around them) so a vague spoken name like "the hospital" resolves to a
    // nearby match rather than the first same-named place anywhere in Kenya.
    const BIAS_DEGREES = 0.5; // ~50km box around the user
    const bounds = [
      `${lat - BIAS_DEGREES},${lng - BIAS_DEGREES}`,
      `${lat + BIAS_DEGREES},${lng + BIAS_DEGREES}`
    ].join('|');

    const geocodeParams = new URLSearchParams({
      address: destinationText.trim(),
      bounds,
      region: 'ke',
      key: apiKey
    });

    const geocodeResponse = await fetch(`${GOOGLE_GEOCODE_URL}?${geocodeParams.toString()}`);
    const geocodeData = await geocodeResponse.json();

    if (geocodeData.status === 'ZERO_RESULTS' || !geocodeData.results || geocodeData.results.length === 0) {
      return res.status(404).json({ error: `Could not find a place matching "${destinationText.trim()}"` });
    }
    if (geocodeData.status !== 'OK') {
      console.error('Geocoding error:', geocodeData.status, geocodeData.error_message);
      return res.status(502).json({ error: `Could not look up that destination (${geocodeData.status})` });
    }

    const destination = geocodeData.results[0];
    const destLat = destination.geometry.location.lat;
    const destLng = destination.geometry.location.lng;
    const destinationName = destination.formatted_address || destinationText.trim();

    // ---------- Step 2: Get real walking directions ----------
    const directionsParams = new URLSearchParams({
      origin: `${lat},${lng}`,
      destination: `${destLat},${destLng}`,
      mode: 'walking',
      key: apiKey
    });

    const directionsResponse = await fetch(`${GOOGLE_DIRECTIONS_URL}?${directionsParams.toString()}`);
    const directionsData = await directionsResponse.json();

    if (directionsData.status === 'ZERO_RESULTS') {
      return res.status(404).json({ error: 'No walking route could be found to that destination' });
    }
    if (directionsData.status !== 'OK') {
      console.error('Directions error:', directionsData.status, directionsData.error_message);
      return res.status(502).json({ error: `Could not get directions (${directionsData.status})` });
    }

    const route = directionsData.routes[0];
    const leg = route.legs[0]; // Single-leg trip: one origin, one destination, no waypoints

    const steps = leg.steps.map((step, i) => ({
      stepNumber: i + 1,
      instruction: htmlInstructionToSpeech(step.html_instructions),
      distanceMeters: step.distance.value,
      distanceText: step.distance.text
    }));

    return res.status(200).json({
      destinationName,
      destinationLat: destLat,
      destinationLng: destLng,
      totalDistanceMeters: leg.distance.value,
      totalDistanceText: metersToWalkingText(leg.distance.value),
      totalDurationText: leg.duration.text,
      steps
    });

  } catch (err) {
    console.error('Navigate error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
