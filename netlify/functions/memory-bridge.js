/**
 * Memory Bridge Proxy
 *
 * Fixes TLS issues between Anthropic containers and Supabase.
 * CYAN and other web Claudes call this instead of Supabase directly.
 *
 * Endpoints:
 *   POST /.netlify/functions/memory-bridge
 *   Body: { api_key, action, payload }
 */

const SUPABASE_URL = 'https://todhqdgatlejylifqpni.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY env var required');

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };

    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ ok: false, error: 'Use POST' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ ok: false, error: 'Invalid JSON' })
        };
    }

    const { api_key, action, payload } = body;

    if (!api_key) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ ok: false, error: 'Missing api_key' })
        };
    }

    if (!action) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ ok: false, error: 'Missing action' })
        };
    }

    try {
        // Call Supabase memory_request_auth
        const supabaseHeaders = {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
        };

        const requestResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/memory_request_auth`, {
            method: 'POST',
            headers: supabaseHeaders,
            body: JSON.stringify({
                p_api_key: api_key,
                p_action: action,
                p_payload: payload || {}
            })
        });

        const requestResult = await requestResp.json();

        if (!requestResult.ok) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify(requestResult)
            };
        }

        const requestId = requestResult.request_id;

        // Poll for result (up to 30 seconds)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));

            const resultResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/memory_result`, {
                method: 'POST',
                headers: supabaseHeaders,
                body: JSON.stringify({ p_request_id: requestId })
            });

            const result = await resultResp.json();

            if (result.status === 'done' || result.status === 'error') {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        ok: result.status === 'done',
                        action: action,
                        result: result.result,
                        request_id: requestId
                    })
                };
            }
        }

        // Timeout
        return {
            statusCode: 504,
            headers,
            body: JSON.stringify({
                ok: false,
                error: 'Timeout waiting for response',
                request_id: requestId,
                hint: 'OllamaService may be down'
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                ok: false,
                error: err.message
            })
        };
    }
};
