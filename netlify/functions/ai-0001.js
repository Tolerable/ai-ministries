/**
 * AI Gateway - MUD-Style API for AI-to-AI Communication
 *
 * Any AI can navigate this API and talk to other AI models.
 * Responses guide the AI to the next action.
 *
 * Endpoints:
 *   GET  /api/ai           - Entry point, list available models
 *   GET  /api/ai?help      - Full command reference
 *   POST /api/ai           - Query a model { model, prompt }
 */

// Models from gen.pollinations.ai/models (updated Dec 2025)
const MODELS = {
    // === OPENAI ===
    'openai': {
        name: 'OpenAI GPT-5 Mini',
        description: 'Fast & Balanced',
        supportsSystem: true
    },
    'openai-fast': {
        name: 'OpenAI GPT-5 Nano',
        description: 'Ultra Fast & Affordable',
        supportsSystem: true
    },
    'openai-large': {
        name: 'OpenAI GPT-5.2',
        description: 'Most Powerful & Intelligent (reasoning)',
        supportsSystem: true,
        reasoning: true
    },

    // === ANTHROPIC ===
    'claude': {
        name: 'Claude Sonnet 4.5',
        description: 'Most Capable & Balanced',
        supportsSystem: true
    },
    'claude-fast': {
        name: 'Claude Haiku 4.5',
        description: 'Fast & Intelligent',
        supportsSystem: true
    },
    'claude-large': {
        name: 'Claude Opus 4.5',
        description: 'Most Intelligent Model',
        supportsSystem: true
    },

    // === GOOGLE ===
    'gemini': {
        name: 'Gemini 3 Flash',
        description: 'Pro-Grade Reasoning at Flash Speed',
        supportsSystem: true
    },
    'gemini-fast': {
        name: 'Gemini 2.5 Flash Lite',
        description: 'Ultra Fast & Cost-Effective',
        supportsSystem: true
    },
    'gemini-large': {
        name: 'Gemini 3 Pro',
        description: 'Most Intelligent with 1M Context',
        supportsSystem: true,
        reasoning: true
    },
    'gemini-search': {
        name: 'Gemini 3 Flash + Search',
        description: 'With Google Search',
        supportsSystem: true
    },

    // === REASONING ===
    'deepseek': {
        name: 'DeepSeek V3.2',
        description: 'Efficient Reasoning & Agentic AI',
        supportsSystem: true,
        reasoning: true
    },
    'kimi-k2-thinking': {
        name: 'Moonshot Kimi K2',
        description: 'Deep Reasoning & Tool Orchestration',
        supportsSystem: true,
        reasoning: true
    },

    // === SEARCH-AUGMENTED ===
    'perplexity-fast': {
        name: 'Perplexity Sonar',
        description: 'Fast with Web Search',
        supportsSystem: true
    },
    'perplexity-reasoning': {
        name: 'Perplexity Sonar Reasoning',
        description: 'Advanced Reasoning with Web Search',
        supportsSystem: true,
        reasoning: true
    },

    // === OTHER ===
    'mistral': {
        name: 'Mistral Small 3.2 24B',
        description: 'Efficient & Cost-Effective',
        supportsSystem: true
    },
    'grok': {
        name: 'xAI Grok 4 Fast',
        description: 'High Speed & Real-Time',
        supportsSystem: true
    },
    'qwen-coder': {
        name: 'Qwen 2.5 Coder 32B',
        description: 'Specialized for Code Generation',
        supportsSystem: true
    },
    'nova-micro': {
        name: 'Amazon Nova Micro',
        description: 'Ultra Fast & Ultra Cheap',
        supportsSystem: true
    },

    // === SPECIALIZED ===
    'chickytutor': {
        name: 'ChickyTutor',
        description: 'AI Language Tutor',
        supportsSystem: true,
        specialized: true
    },
    'midijourney': {
        name: 'MIDIjourney',
        description: 'AI Music Composition Assistant',
        supportsSystem: true,
        specialized: true
    },
    'openai-audio': {
        name: 'OpenAI GPT-4o Audio',
        description: 'Voice Input & Output',
        supportsSystem: true,
        audio: true
    },

    // === IMAGE ===
    'image': {
        name: 'Image Generator',
        description: 'Generate images from text',
        type: 'image'
    }
};

// New unified API endpoints (legacy text.pollinations.ai deprecated)
const TEXT_ENDPOINT = 'https://gen.pollinations.ai/text/';
const IMAGE_ENDPOINT = 'https://gen.pollinations.ai/image/';

// Pollinations API key for FLOWER tier access
const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || '';

exports.handler = async (event, context) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    const params = event.queryStringParameters || {};

    // GET /api/ai?help - Full command reference
    if (params.help !== undefined) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                where: 'AI Gateway Help',
                commands: {
                    'GET /api/ai': 'List available models',
                    'GET /api/ai?help': 'This help',
                    'GET /api/ai?model=deepseek&q=your+question': 'Quick query',
                    'GET /api/ai?model=X&q=Y&system=Z': 'Query with system message',
                    'POST /api/ai': 'Full control: { model, prompt, system }'
                },
                models: Object.keys(MODELS),
                categories: {
                    reasoning: ['deepseek', 'openai', 'openai-fast', 'gemini', 'mistral'],
                    search: ['gemini-search'],
                    coding: ['qwen-coder'],
                    unrestricted: ['unity', 'evil'],
                    specialized: ['bidara', 'chickytutor', 'midijourney', 'rtist', 'roblox-rp'],
                    image: ['image']
                },
                system_messages: {
                    note: 'Some models support native system messages, others get it prepended',
                    native_support: ['deepseek', 'openai', 'gemini', 'mistral', 'qwen-coder', 'bidara'],
                    prepend_mode: ['unity', 'evil', 'midijourney', 'rtist', 'roblox-rp']
                },
                examples: [
                    { method: 'GET', url: '/api/ai?model=deepseek&q=hello' },
                    { method: 'GET', url: '/api/ai?model=unity&q=be+creative&system=You+are+a+poet' },
                    { method: 'POST', body: { model: 'qwen-coder', prompt: 'Write a Python hello world', system: 'Be concise' } }
                ],
                next: 'Try: /api/ai?model=deepseek&q=hello'
            }, null, 2)
        };
    }

    // GET /api/ai - Entry point OR quick query
    if (event.httpMethod === 'GET') {
        // Quick query: /api/ai?model=X&q=Y&system=Z
        if (params.model && params.q) {
            return await queryModel(params.model, params.q, params.system, headers);
        }

        // Entry point - list models
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                where: 'AI Gateway',
                you: 'visiting_ai',
                available_models: Object.entries(MODELS).map(([id, m]) => ({
                    id,
                    name: m.name,
                    description: m.description
                })),
                next: 'Query a model: /api/ai?model=deepseek&q=your+question',
                help: '/api/ai?help for full commands'
            }, null, 2)
        };
    }

    // POST /api/ai - Query a model
    if (event.httpMethod === 'POST') {
        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch (e) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    ok: false,
                    error: 'invalid_json',
                    why: 'Could not parse request body',
                    fix: 'Send valid JSON: { "model": "deepseek", "prompt": "your question" }',
                    next: '/api/ai?help for examples'
                })
            };
        }

        const { model, prompt, system } = body;

        if (!model) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    ok: false,
                    error: 'missing_model',
                    why: 'No model specified',
                    fix: 'Add "model" to your request',
                    available: Object.keys(MODELS),
                    next: 'Try: { "model": "deepseek", "prompt": "hello" }'
                })
            };
        }

        if (!prompt) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    ok: false,
                    error: 'missing_prompt',
                    why: 'No prompt specified',
                    fix: 'Add "prompt" to your request',
                    next: 'Try: { "model": "' + model + '", "prompt": "your question" }'
                })
            };
        }

        return await queryModel(model, prompt, system, headers);
    }

    return {
        statusCode: 405,
        headers,
        body: JSON.stringify({
            ok: false,
            error: 'method_not_allowed',
            why: 'Use GET or POST',
            next: '/api/ai for entry point'
        })
    };
};

async function queryModel(modelId, prompt, system, headers) {
    const model = MODELS[modelId.toLowerCase()];

    if (!model) {
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({
                ok: false,
                error: 'unknown_model',
                why: `Model "${modelId}" not found`,
                available: Object.keys(MODELS),
                fix: 'Pick from available models',
                next: '/api/ai to see all models'
            })
        };
    }

    // Image generation
    if (model.type === 'image') {
        // Build image URL with auth params (gen.pollinations.ai format)
        let imageUrl = IMAGE_ENDPOINT + encodeURIComponent(prompt);
        const imageParams = new URLSearchParams();
        imageParams.set('nologo', 'true');
        if (POLLINATIONS_KEY) {
            imageParams.set('token', POLLINATIONS_KEY);
        }
        imageUrl += '?' + imageParams.toString();

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                model: modelId,
                type: 'image',
                prompt: prompt,
                image_url: imageUrl,
                next: 'Open image_url to view, or try another prompt'
            })
        };
    }

    // Text generation via Pollinations
    try {
        // Build the effective prompt
        let effectivePrompt = prompt;

        // Handle system message
        if (system) {
            if (model.supportsSystem) {
                // Model supports system param - will add to URL
            } else {
                // Prepend system to prompt for models without system support
                effectivePrompt = `[SYSTEM: ${system}]\n\n${prompt}`;
            }
        }

        // Build URL with prompt in path (Pollinations format)
        let url = TEXT_ENDPOINT + encodeURIComponent(effectivePrompt);

        // Add query params for model and system
        const params = new URLSearchParams();
        params.set('model', modelId);
        if (system && model.supportsSystem) {
            params.set('system', system);
        }
        url += '?' + params.toString();

        // Build request headers with auth if key available
        const requestHeaders = { 'Accept': 'text/plain' };
        if (POLLINATIONS_KEY) {
            requestHeaders['Authorization'] = `Bearer ${POLLINATIONS_KEY}`;
        }

        const response = await fetch(url, {
            method: 'GET',
            headers: requestHeaders
        });

        if (!response.ok) {
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({
                    ok: false,
                    error: 'upstream_error',
                    why: `Model returned ${response.status}`,
                    fix: 'Try again or use different model',
                    next: '/api/ai to see alternatives'
                })
            };
        }

        const text = await response.text();

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                ok: true,
                model: modelId,
                prompt: prompt,
                system_used: system ? (model.supportsSystem ? 'native' : 'prepended') : null,
                response: text,
                next: 'Send another prompt or try /api/ai?model=image&q=a+sunset for images'
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                ok: false,
                error: 'request_failed',
                why: err.message,
                fix: 'Check your prompt and try again',
                next: '/api/ai?help for examples'
            })
        };
    }
}
