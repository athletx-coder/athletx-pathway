// netlify/functions/report-status.js
//
// Quick, regular (non-background) function. The front end calls this every
// few seconds with ?jobId=... to check whether generate-report-background.js
// has finished yet.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ status: 'error', error: 'Missing jobId' }) };
  }

  const store = getStore('athletx-reports');

  try {
    const result = await store.get(jobId, { type: 'json' });
    if (!result) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' })
      };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' })
    };
  }
};
