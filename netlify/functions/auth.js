const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const { action, email, password, redirectTo, access_token, refresh_token } = JSON.parse(event.body || '{}');

  if (!action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing action' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  try {
    let result;

    switch (action) {
      case 'signIn':
        result = await supabase.auth.signInWithPassword({ email, password });
        if (result.data?.session) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: {
                user: result.data.user,
                session: {
                  access_token: result.data.session.access_token,
                  refresh_token: result.data.session.refresh_token,
                  expires_at: result.data.session.expires_at
                }
              },
              error: null
            })
          };
        }
        break;

      case 'signUp':
        result = await supabase.auth.signUp({ email, password });
        if (result.data?.session) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: {
                user: result.data.user,
                session: {
                  access_token: result.data.session.access_token,
                  refresh_token: result.data.session.refresh_token,
                  expires_at: result.data.session.expires_at
                }
              },
              error: null
            })
          };
        }
        break;

      case 'signOut':
        result = { data: {}, error: null };
        break;

      case 'validateToken':
        if (!access_token || !refresh_token) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { session: null, user: null }, error: null })
          };
        }
        const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token
        });
        if (sessionError || !sessionData.session) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { session: null, user: null }, error: sessionError })
          };
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: {
              user: sessionData.user,
              session: {
                access_token: sessionData.session.access_token,
                refresh_token: sessionData.session.refresh_token,
                expires_at: sessionData.session.expires_at
              }
            },
            error: null
          })
        };

      case 'getSession':
        if (!access_token || !refresh_token) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { session: null }, error: null })
          };
        }
        const { data: getSessionData, error: getSessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token
        });
        if (getSessionError || !getSessionData.session) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { session: null }, error: getSessionError })
          };
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: {
              session: {
                access_token: getSessionData.session.access_token,
                refresh_token: getSessionData.session.refresh_token,
                expires_at: getSessionData.session.expires_at,
                user: getSessionData.user
              }
            },
            error: null
          })
        };

      case 'getUser':
        if (!access_token) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { user: null }, error: null })
          };
        }
        const { data: userData, error: userError } = await supabase.auth.getUser(access_token);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: userData, error: userError })
        };

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
