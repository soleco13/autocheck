import OpenAI from 'openai';

// Single shared client for all OpenRouter calls (ai-checker, report-generator, platform report).
// OpenRouter exposes an OpenAI-compatible /chat/completions endpoint — one key, many providers/models.
let client: OpenAI | null = null;
let visionClient: OpenAI | null = null;

function makeClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    maxRetries: 3,
    defaultHeaders: {
      'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:3000',
      'X-Title': 'AutoCheck',
    },
  });
}

export function getOpenRouterClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
      throw new Error('OPENROUTER_API_KEY not configured');
    }
    client = makeClient(apiKey);
  }
  return client;
}

// Client for the multimodal (vision) model that grades photo answers.
// Uses OPENROUTER_VISION_API_KEY when set, otherwise the shared OPENROUTER_API_KEY.
export function getOpenRouterVisionClient(): OpenAI {
  if (!visionClient) {
    const apiKey = process.env.OPENROUTER_VISION_API_KEY?.trim() || process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
      throw new Error('OPENROUTER_VISION_API_KEY / OPENROUTER_API_KEY not configured');
    }
    // Same key → reuse the shared client instance.
    if (apiKey === process.env.OPENROUTER_API_KEY) return getOpenRouterClient();
    visionClient = makeClient(apiKey);
  }
  return visionClient;
}
