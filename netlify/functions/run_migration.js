const SUPABASE_URL = process.env.SUPABASE_URL || 'https://todhqdgatlejylifqpni.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MIGRATION_SECRET = process.env.MIGRATION_SECRET;
const COLAB_API_KEY = process.env.COLAB_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { sql, secret } = JSON.parse(event.body || '{}');

  if (!secret || secret !== MIGRATION_SECRET) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Invalid secret' }) };
  }

  if (!sql) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing sql' }) };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/run_migration`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_key: COLAB_API_KEY,
        p_sql: sql
      })
    });

    const data = await response.json();
    return {
      statusCode: response.ok ? 200 : 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
