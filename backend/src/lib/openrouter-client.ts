import OpenAI from 'openai';

// Single shared client for all OpenRouter calls (ai-checker, report-generator, platform report).
// OpenRouter exposes an OpenAI-compatible /chat/completions endpoint — one key, many providers/models.
let client: OpenAI | null = null;

export function getOpenRouterClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
      throw new Error('OPENROUTER_API_KEY not configured');
    }
    client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 3,
      defaultHeaders: {
        'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:3000',
        'X-Title': 'AutoCheck',
      },
    });
  }
  return client;
}
