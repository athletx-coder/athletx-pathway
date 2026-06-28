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

exports.handler = async function (event) {
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return; // background functions don't return a body to the client
  }

  const { jobId, profile = {}, answers = {}, questions = [] } = payload;
  if (!jobId) return;

  const store = getStore('athletx-reports');

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
  } catch (err) {
    await store.setJSON(jobId, { status: 'error', error: err.message });
  }
};

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
