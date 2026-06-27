// netlify/functions/generate-report.js
//
// Serverless function that takes the athlete's intake profile + assessment
// answers and calls the Anthropic API to generate the Phase 4-10 report
// from the Athlete Future Pathway master prompt, returned as strict JSON
// for the front-end to render.
//
// REQUIRED: set ANTHROPIC_API_KEY as an environment variable in
// Netlify (Site settings -> Environment variables) before deploying.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'ANTHROPIC_API_KEY is not configured on this Netlify site. Add it under Site settings -> Environment variables, then redeploy.'
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { profile = {}, answers = {}, questions = [] } = payload;

  // Re-attach question text to each answer so the model has full context,
  // not just keys.
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
      return { statusCode: 502, body: JSON.stringify({ error: `Anthropic API error: ${errText.slice(0, 500)}` }) };
    }

    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No text content returned from model.' }) };
    }

    const cleaned = textBlock.text.replace(/```json/g, '').replace(/```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON.', raw: cleaned.slice(0, 800) }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
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
  ],
  "topMajors": [
    { "major": "string", "why": "string 1 sentence", "difficulty": "string e.g. Moderate" }
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
  ],
  "wellness": {
    "strengths": ["string", "string"],
    "areasNeedingAttention": ["string", "string"],
    "recommendations": ["string", "string", "string"]
  },
  "nextFiveActions": [
    { "action": "string, specific and measurable", "why": "string, 1 sentence", "timeframe": "string e.g. Within 7 days" }
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
