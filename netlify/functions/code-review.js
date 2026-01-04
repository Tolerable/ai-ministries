const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are CYAN, a code security reviewer for Rev's network.

Your ONLY job: Check code for security violations before push.

CHECK FOR:
1. eyJ strings (JWT tokens/keys) - ANY eyJ pattern = REJECT
2. Hardcoded keys - anything that looks like an API key, service key, secret = REJECT
3. createClient in frontend HTML/JS - should use Netlify functions instead = REJECT
4. Direct Supabase calls from browser code - supabase.from(), supabase.rpc() in frontend = REJECT
5. process.env in frontend code (frontend can't read these) = REJECT
6. Any URL containing actual key values = REJECT

SAFE PATTERNS:
- process.env.* in Netlify functions (server-side) = OK
- dbQuery(), authSignIn() helper calls = OK
- fetch('/.netlify/functions/...') = OK
- SUPABASE_URL constant (not a secret) = OK

RESPONSE FORMAT:
If clean: {"status": "APPROVE", "reason": "No violations found"}
If violations: {"status": "REJECT", "violations": ["violation 1", "violation 2"], "lines": [123, 456]}

Be strict. When in doubt, REJECT. Rev's network has been compromised 4+ times by exposed keys.
Respond ONLY with JSON. No explanation. No markdown.`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { code, filename, action } = body;

  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing code' }) };
  }

  const userMessage = `Review this code for security violations.
Filename: ${filename || 'unknown'}
Action: ${action || 'push'}

CODE:
${code}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: 'API error', details: data }) };
    }

    const reviewText = data.content[0].text;
    
    let review;
    try {
      review = JSON.parse(reviewText);
    } catch (e) {
      review = { status: 'REJECT', reason: 'Could not parse review - rejecting for safety', raw: reviewText };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(review)
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
