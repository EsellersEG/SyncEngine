import { Router, type Request, type Response } from 'express';

const router = Router();

const OPENAI_MODEL = 'gpt-4o-mini';
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

async function callOpenAIWithRetry(prompt: string, retries = 0): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured on server');

  const url = 'https://api.openai.com/v1/chat/completions';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError' && retries < MAX_RETRIES) {
      const backoff = BASE_DELAY_MS * Math.pow(2, retries);
      console.log(`[OpenAI] Request timed out, retrying in ${Math.round(backoff)}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, backoff));
      return callOpenAIWithRetry(prompt, retries + 1);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  // Retry on 429 (rate limit) or 503 (overloaded) with exponential backoff
  if (res.status === 429 || res.status === 503) {
    if (retries >= MAX_RETRIES) {
      const errBody = await res.text();
      throw new Error(`OpenAI API ${res.status} after ${MAX_RETRIES} retries: ${errBody.slice(0, 300)}`);
    }
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : 0;
    const backoff = Math.max(retryAfterMs, BASE_DELAY_MS * Math.pow(2, retries));
    console.log(`[OpenAI] ${res.status} — retrying in ${Math.round(backoff)}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
    await new Promise(r => setTimeout(r, backoff));
    return callOpenAIWithRetry(prompt, retries + 1);
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data?.choices?.[0]?.message?.content || '{}';
}

// POST /api/tools/gemini/generate  (kept same path for frontend compat)
router.post('/gemini/generate', async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const text = await callOpenAIWithRetry(prompt);

    return res.json({ text });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[OpenAI] Error:', message);
    return res.status(502).json({ error: message });
  }
});

export default router;
