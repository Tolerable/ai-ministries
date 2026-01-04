const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const { action, email, password, redirectTo } = JSON.parse(event.body || '{}');

  if (!action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing action' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  try {
    let result;

    switch (action) {
      case 'signIn':
        result = await supabase.auth.signInWithPassword({ email, password });
        break;

      case 'signUp':
        result = await supabase.auth.signUp({ email, password });
        break;

      case 'signOut':
        result = await supabase.auth.signOut();
        break;

      case 'getSession':
        result = await supabase.auth.getSession();
        break;

      case 'getUser':
        result = await supabase.auth.getUser();
        break;

      case 'resetPassword':
        result = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        break;

      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
