// netlify/functions/capture-lead.js
//
// Quick, regular (non-background) function. Called the moment someone
// clicks "Start Assessment" — saves their contact info immediately so a
// lead exists even if they never finish the assessment.
//
// View captured leads anytime in the Netlify dashboard: Project >
// Blobs > "athletx-leads" store. No extra admin page needed.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let profile;
  try {
    profile = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!profile.email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing email' }) };
  }

  const store = getStore('athletx-leads');
  const key = `${Date.now()}-${profile.email}`;

  try {
    await store.setJSON(key, {
      ...profile,
      capturedAt: new Date().toISOString()
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
