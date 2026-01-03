const SUPABASE_URL = process.env.SUPABASE_URL || 'https://todhqdgatlejylifqpni.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const { action, params } = JSON.parse(event.body || '{}');
  if (!action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing action' }) };
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${action}`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params || {})
    });
    const data = await response.json();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
