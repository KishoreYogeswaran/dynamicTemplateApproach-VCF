/**
 * Gemini API client — uses @google/genai SDK with API key auth.
 * Retry logic with exponential backoff on 429/503 errors.
 */

import { GoogleGenAI } from '@google/genai';
import { requireEnv } from '../utils/env.js';

let _client = null;

function getClient() {
  if (!_client) {
    _client = new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
  }
  return _client;
}

const DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const MAX_RETRIES = 3;

/**
 * Generate content with retry + exponential backoff.
 * @param {object} options
 * @param {string} options.prompt - The prompt text
 * @param {string} [options.model] - Model name override
 * @param {string} [options.thinkingLevel] - Thinking level: NONE, LOW, MEDIUM, HIGH
 * @returns {Promise<string>} - Response text
 */
export async function generateContent({
  prompt,
  model = DEFAULT_MODEL,
  thinkingLevel = 'HIGH',
}) {
  const client = getClient();
  let retryDelay = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay *= 2;
      }

      const response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          thinkingConfig: { thinkingLevel },
        },
      });

      return response.text?.trim() || '';
    } catch (err) {
      const msg = String(err);
      const retryable = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')
        || msg.includes('503') || msg.includes('UNAVAILABLE');

      if (attempt === MAX_RETRIES || !retryable) throw err;
      console.warn(`[gemini] Attempt ${attempt} failed (${msg.slice(0, 80)}), retrying...`);
    }
  }
}

/**
 * Generate content for multiple prompts in parallel.
 * @param {Array<{prompt: string, id: string}>} tasks
 * @param {object} [options] - model, thinkingLevel overrides
 * @returns {Promise<Map<string, string>>} - Map of id → response text
 */
export async function generateContentBatch(tasks, options = {}) {
  const results = new Map();
  const promises = tasks.map(async ({ prompt, id }) => {
    const text = await generateContent({ prompt, ...options });
    results.set(id, text);
  });
  await Promise.all(promises);
  return results;
}
