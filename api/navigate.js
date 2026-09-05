// Turns a spoken destination into a real walking route.
//
// Two real calls to Mapbox, chained together:
//   1. Geocoding API v5  — destinationText -> { lat, lng, placeName }
//   2. Directions API v5 — (current lat/lng) -> (destination lat/lng), walking profile
//
// Migrated from Google Maps Platform (Geocoding + Directions) after billing
// setup couldn't be completed on that account. Mapbox's free tier covers
// 100,000 geocoding + 100,000 directions requests/month with no card
// required for signup. See project notes for the full comparison.
//
// The frontend is responsible for reading the device's position ONCE when
// navigation starts (getCurrentPosition) and sending it here as lat/lng —
// there is no live position tracking yet. Turn-by-turn steps come back as a
// plain ordered list; the frontend advances through them manually (tap or
// voice "next") rather than via GPS-triggered auto-advance. That's a
// deliberate, temporary scope cut for the prototype — see project notes.

const MAPBOX_GEOCODE_BASE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const MAPBOX_DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox/walking';

// Mapbox's `maneuver.instruction` field is already plain text (e.g. "Turn
// right onto Kenyatta Ave"), meant for both display and TTS — unlike
// Google's HTML-formatted `html_instructions`. So the old
// htmlInstructionToSpeech() tag-stripping/entity-decoding step is dead
// code now and has been dropped entirely rather than kept around unused.

function metersToWalkingText(meters) {
  if (meters < 1000) return `${Math.round(meters)} meters`;
  return `${(meters / 1000).toFixed(1)} kilometers`;
}

// Mapbox durations come back in seconds; Google's Directions API gave us a
// pre-formatted duration string, so we format one here to match.
function secondsToWalkingText(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes} min` : `${hours} hour${hours > 1 ? 's' : ''}`;
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

    const accessToken = process.env.MAPBOX_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'Server is missing its Mapbox access token configuration' });
    }

    // ---------- Step 1: Geocode the spoken destination ----------
    // Bias toward the user's current position two ways, same intent as the
    // old Google bounds box: a bbox around them (minLon,minLat,maxLon,maxLat)
    // plus a proximity point, so a vague spoken name like "the hospital"
    // resolves to a nearby match rather than the first same-named place
    // anywhere in Kenya.
    const BIAS_DEGREES = 0.5; // ~50km box around the user
    const bbox = [
      lng - BIAS_DEGREES,
      lat - BIAS_DEGREES,
      lng + BIAS_DEGREES,
      lat + BIAS_DEGREES
    ].join(',');

    const encodedQuery = encodeURIComponent(destinationText.trim());
    const geocodeParams = new URLSearchParams({
      access_token: accessToken,
      bbox,
      proximity: `${lng},${lat}`,
      country: 'ke',
      limit: '1'
    });

    const geocodeResponse = await fetch(`${MAPBOX_GEOCODE_BASE}/${encodedQuery}.json?${geocodeParams.toString()}`);
    const geocodeData = await geocodeResponse.json();

    if (!geocodeResponse.ok) {
      console.error('Geocoding error:', geocodeResponse.status, geocodeData);
      return res.status(502).json({ error: `Could not look up that destination (${geocodeResponse.status})` });
    }
    if (!geocodeData.features || geocodeData.features.length === 0) {
      return res.status(404).json({ error: `Could not find a place matching "${destinationText.trim()}"` });
    }

    const destination = geocodeData.features[0];
    const destLng = destination.center[0];
    const destLat = destination.center[1];
    const destinationName = destination.place_name || destinationText.trim();

    // ---------- Step 2: Get real walking directions ----------
    const coordinates = `${lng},${lat};${destLng},${destLat}`;
    const directionsParams = new URLSearchParams({
      access_token: accessToken,
      steps: 'true',
      geometries: 'geojson',
      overview: 'simplified'
    });

    const directionsResponse = await fetch(`${MAPBOX_DIRECTIONS_BASE}/${coordinates}?${directionsParams.toString()}`);
    const directionsData = await directionsResponse.json();

    if (!directionsResponse.ok || directionsData.code !== 'Ok') {
      console.error('Directions error:', directionsResponse.status, directionsData.code, directionsData.message);
      if (directionsData.code === 'NoRoute') {
        return res.status(404).json({ error: 'No walking route could be found to that destination' });
      }
      return res.status(502).json({ error: `Could not get directions (${directionsData.code || directionsResponse.status})` });
    }
    if (!directionsData.routes || directionsData.routes.length === 0) {
      return res.status(404).json({ error: 'No walking route could be found to that destination' });
    }

    const route = directionsData.routes[0];
    const leg = route.legs[0]; // Single-leg trip: one origin, one destination, no waypoints

    const steps = leg.steps.map((step, i) => {
      // maneuver.location is where this step's instruction applies —
      // used by the frontend to move a "you are here" marker as the user
      // advances through steps, not just to draw the route line.
      const loc = step.maneuver && step.maneuver.location;
      return {
        stepNumber: i + 1,
        instruction: (step.maneuver && step.maneuver.instruction) || '',
        // Structured maneuver info (e.g. type: 'turn', modifier: 'left'),
        // exposed alongside the full instruction text so the frontend can
        // build short spoken phrases ("Turn left") instead of relying on
        // Mapbox's longer sentence ("Turn left onto Kenyatta Ave").
        maneuverType: (step.maneuver && step.maneuver.type) || null,
        maneuverModifier: (step.maneuver && step.maneuver.modifier) || null,
        distanceMeters: step.distance,
        distanceText: metersToWalkingText(step.distance),
        lat: loc ? loc[1] : null,
        lng: loc ? loc[0] : null
      };
    });

    return res.status(200).json({
      destinationName,
      destinationLat: destLat,
      destinationLng: destLng,
      originLat: lat,
      originLng: lng,
      totalDistanceMeters: leg.distance,
      totalDistanceText: metersToWalkingText(leg.distance),
      totalDurationText: secondsToWalkingText(leg.duration),
      // GeoJSON LineString of the full walking path, for drawing the
      // route on the map. `overview: 'simplified'` above keeps this small.
      routeGeometry: route.geometry,
      steps
    });

  } catch (err) {
    console.error('Navigate error:', err);
    return res.status(500).json({ error: 'Something went wrong on the server' });
  }
}
