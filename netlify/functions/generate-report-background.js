// netlify/functions/generate-report-background.js
//
// BACKGROUND function (note the -background suffix in the filename —
// that's what tells Netlify to run this asynchronously with a 15-minute
// limit instead of the ~10-30 second limit on regular functions).
//
// The client calls this and gets an empty 202 response immediately, while
// this keeps running in the background. It stores its result in Netlify
// Blobs keyed by the jobId the client generated, and report-status.js
// reads that store so the front end can poll for completion.
//
// REQUIRED: set ANTHROPIC_API_KEY as an environment variable in
// Netlify (Site settings -> Environment variables) before deploying.

const { getStore } = require('@netlify/blobs');
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return; // background functions don't return a body to the client
  }

  const { jobId, profile = {}, answers = {}, questions = [] } = payload;
  if (!jobId) return;

  const store = getStore({
  name: 'athletx-reports',
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
});

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await store.setJSON(jobId, {
      status: 'error',
      error: 'ANTHROPIC_API_KEY is not configured on this Netlify site. Add it under Project configuration -> Environment variables, then redeploy.'
    });
    return;
  }

  const answeredQA = questions.map(q => ({
    phase: q.phase,
    question: q.title,
    answer: answers[q.key]
  })).filter(qa => qa.answer !== undefined && qa.answer !== '');

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(profile, answeredQA);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      await store.setJSON(jobId, { status: 'error', error: `Anthropic API error: ${errText.slice(0, 500)}` });
      return;
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      await store.setJSON(jobId, { status: 'error', error: 'No text content returned from model.' });
      return;
    }

    const cleaned = textBlock.text.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      await store.setJSON(jobId, { status: 'error', error: 'Model did not return valid JSON.' });
      return;
    }

    await store.setJSON(jobId, { status: 'complete', report: parsed });

    // Email delivery is best-effort: the result is already saved above,
    // so a failure here doesn't lose the report, it just means email
    // didn't go out. Note the failure on the stored record either way.
    try {
      await sendEmails(profile, parsed);
    } catch (emailErr) {
      await store.setJSON(jobId, { status: 'complete', report: parsed, emailError: emailErr.message });
    }
  } catch (err) {
    await store.setJSON(jobId, { status: 'error', error: err.message });
  }
};

async function sendEmails(profile, report) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    throw new Error('GMAIL_USER or GMAIL_APP_PASSWORD is not configured in Netlify environment variables.');
  }

  const notifyEmail = process.env.ATHLETX_NOTIFY_EMAIL || gmailUser;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass }
  });

  // Email 1: to the parent/guardian, the actual report.
  await transporter.sendMail({
    from: `"AthletX Future Pathway" <${gmailUser}>`,
    to: profile.email,
    subject: `${profile.name || 'Your athlete'}'s Future Pathway Report is ready`,
    html: buildEmailHtml(profile, report, false)
  });

  // Email 2: to AthletX, same report plus the lead's contact info, so every
  // completed assessment also lands as a notification for follow-up.
  await transporter.sendMail({
    from: `"AthletX Future Pathway" <${gmailUser}>`,
    to: notifyEmail,
    subject: `New report completed: ${profile.name || 'Unnamed'}${profile.sport ? ' (' + profile.sport + ')' : ''}`,
    html: buildEmailHtml(profile, report, true)
  });
}

function buildEmailHtml(profile, report, includeContact) {
  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const contactBlock = includeContact ? `
    <div style="background:#fef3cd;border:1px solid #f0a202;border-radius:8px;padding:14px 16px;margin-bottom:20px;font-size:14px;">
      <strong>Lead contact info</strong><br>
      Name: ${esc(profile.name)}<br>
      Email: ${esc(profile.email)}<br>
      Phone: ${esc(profile.phone)}<br>
      Age: ${esc(profile.age)} &nbsp; Grade: ${esc(profile.grade)} &nbsp; Sport: ${esc(profile.sport)}
    </div>` : '';

  const careers = (report.topCareers || []).slice(0, 5).map(c =>
    `<li style="margin-bottom:8px;"><strong>${esc(c.career)}</strong>${c.matchPct ? ' (' + esc(c.matchPct) + '% match)' : ''} — ${esc(c.why)}</li>`
  ).join('');

  const actions = (report.nextFiveActions || []).map(a =>
    `<li style="margin-bottom:8px;"><strong>${esc(a.action)}</strong> — ${esc(a.why)} <em>(${esc(a.timeframe)})</em></li>`
  ).join('');

  const snapshot = report.snapshot || {};
  const score = report.actionAspirationScore || {};

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.5;">
    ${contactBlock}
    <h2 style="color:#0b1f33;margin-bottom:4px;">${esc(profile.name)}'s Future Pathway Report</h2>
    <p style="font-size:15px;color:#444;">${esc(snapshot.headline)}</p>

    <h3 style="color:#c97f00;border-bottom:2px solid #f0a202;padding-bottom:4px;">Snapshot</h3>
    <p><strong>Current trajectory:</strong> ${esc(snapshot.currentTrajectory)}</p>
    <p><strong>If nothing changes:</strong> ${esc(snapshot.futureTrajectory)}</p>

    <h3 style="color:#c97f00;border-bottom:2px solid #f0a202;padding-bottom:4px;">Action vs. Aspiration Score: ${esc(score.score)}/100</h3>
    <p>${esc(score.explanation)}</p>

    <h3 style="color:#c97f00;border-bottom:2px solid #f0a202;padding-bottom:4px;">Top Career Matches</h3>
    <ul>${careers}</ul>

    <h3 style="color:#c97f00;border-bottom:2px solid #f0a202;padding-bottom:4px;">Next 5 Actions — Start This Week</h3>
    <ol>${actions}</ol>

    <p style="margin-top:24px;font-size:12px;color:#888;">Built by AthletX™ — part of the AthletX sports intelligence ecosystem.</p>
  </div>`;
}

function buildSystemPrompt() {
  return `You are the AI engine behind ATHLETE FUTURE PATHWAY (TM), part of the AthletX sports intelligence ecosystem.

You operate as an integrated team: College Admissions Officer, Career Psychologist, Developmental Psychologist, Executive Function Specialist, High School Guidance Counselor, NCAA Academic Eligibility Expert, Adolescent Motivation Researcher, Occupational Psychologist, Behavioral Economist, Workforce Forecaster, College Success Coach, Mental Wellness Coach, and Life Strategy Consultant.

Your purpose is not just to recommend careers. It is to help a teenage athlete see clearly: who they naturally are, whether their current behaviors support the future they say they want, exactly what must change, and how to realistically get there.

Rules:
- Never shame or discourage. Every gap you identify must come with a path to close it.
- Never diagnose any mental health condition. Phase 9 (wellness) identifies protective factors and areas needing attention only, with recommendations, never a label.
- Ground career, income, and outlook claims in realistic, generally-accepted labor market knowledge. If you are not certain of a precise figure, give a reasonable, clearly-rounded range rather than a falsely precise number.
- Be specific to the individual student's actual answers. Do not produce generic filler — reference their stated sport, goals, and behaviors directly in the gap analysis, risks, and roadmap.
- Tone: direct, warm, respectful of the student's intelligence. No corporate filler language.

You must respond with ONLY valid JSON matching this exact schema (no markdown fences, no commentary before or after):

{
  "snapshot": {
    "headline": "string, 3-6 words, punchy",
    "currentTrajectory": "string, 1-2 sentences",
    "futureTrajectory": "string, 1-2 sentences, where current habits lead if unchanged",
    "topStrengths": ["string", "string", "string"],
    "topOpportunities": ["string", "string", "string"]
  },
  "actionAspirationScore": {
    "score": 0-100 integer,
    "explanation": "string, 2-3 sentences, how closely current behavior matches stated goals"
  },
  "futureProbability": {
    "ifNothingChangesPct": 0-100 integer,
    "ifNothingChangesNote": "string, 1 sentence",
    "ifFollowedPct": 0-100 integer,
    "ifFollowedNote": "string, 1 sentence"
  },
  "gapAnalysis": [
    { "stated": "string - a goal they expressed", "evidence": "string - what current behavior actually shows", "fix": "string - one concrete way to close this specific gap" }
    // 3-5 of these, drawn directly from their actual answers
  ],
  "hiddenPotential": "string, 2-3 sentences describing an underestimated talent",
  "biggestRisks": ["string", "string", "string"],
  "readinessScores": {
    "academicReadiness": 0-100,
    "lifeSkills": 0-100,
    "emotionalReadiness": 0-100,
    "independence": 0-100,
    "persistence": 0-100,
    "executiveFunction": 0-100,
    "leadership": 0-100,
    "careerReadiness": 0-100
  },
  "topCareers": [
    { "career": "string", "why": "string 1 sentence", "avgIncome": "string e.g. $58K", "topIncome": "string e.g. $120K+", "education": "string e.g. Bachelor's", "outlook": "string e.g. Strong growth", "matchPct": 0-100 }
    // exactly 8, ranked best fit first
  ],
  "topMajors": [
    { "major": "string", "why": "string 1 sentence", "difficulty": "string e.g. Moderate" }
    // exactly 8
  ],
  "roadmap": {
    "thisWeek": ["string", "string", "string"],
    "thisMonth": ["string", "string"],
    "thisQuarter": ["string", "string"],
    "oneYear": ["string", "string", "string"],
    "threeYear": ["string", "string"],
    "fiveYear": ["string", "string"]
  },
  "missingLifeSkills": [
    { "skill": "string", "why": "string", "priority": "High|Medium|Low" }
    // 4-6 of these, prioritized to this student specifically
  ],
  "wellness": {
    "strengths": ["string", "string"],
    "areasNeedingAttention": ["string", "string"],
    "recommendations": ["string", "string", "string"]
  },
  "nextFiveActions": [
    { "action": "string, specific and measurable", "why": "string, 1 sentence", "timeframe": "string e.g. Within 7 days" }
    // exactly 5
  ]
}`;
}

function buildUserPrompt(profile, answeredQA) {
  const qaText = answeredQA.map(qa => `[${qa.phase}] Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n');
  return `ATHLETE PROFILE
Name: ${profile.name || 'Not provided'}
Age: ${profile.age || 'Not provided'}
Grade: ${profile.grade || 'Not provided'}
Sport(s): ${profile.sport || 'Not provided'}
Approximate GPA: ${profile.gpa || 'Not provided'}
Attendance: ${profile.attendance || 'Not provided'}

ASSESSMENT ANSWERS
${qaText}

Using the rules and JSON schema in your system prompt, generate this student's complete Athlete Future Pathway report now. Respond with ONLY the JSON object.`;
}
