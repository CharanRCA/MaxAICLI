import { parseSSE } from './sse.js';

const API_VERSION = '2023-06-01';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function failure(res) {
  let detail;
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  const hint =
    res.status === 401 ? ' (check your API key)' : res.status === 429 ? ' (rate limited, retry shortly)' : '';
  return new ApiError(`API error ${res.status}: ${detail}${hint}`, res.status);
}

function buildRequest({ apiKey, baseUrl, model, system, messages, maxTokens }, stream) {
  const body = { model, max_tokens: maxTokens, messages, stream };
  if (system) body.system = system;
  return {
    url: `${baseUrl}/v1/messages`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
    },
  };
}

/** Yields text deltas as they arrive. */
export async function* streamMessage(opts) {
  const { fetchImpl = fetch, signal } = opts;
  const { url, init } = buildRequest(opts, true);
  const res = await fetchImpl(url, { ...init, signal });
  if (!res.ok) throw await failure(res);
  for await (const { event, data } of parseSSE(res.body)) {
    if (event === 'error') {
      const err = JSON.parse(data).error;
      throw new ApiError(`API stream error: ${err?.message ?? data}`, 0);
    }
    if (event === 'content_block_delta') {
      const delta = JSON.parse(data).delta;
      if (delta?.type === 'text_delta' && delta.text) yield delta.text;
    }
  }
}

/** Non-streaming request; returns the full reply text. */
export async function sendMessage(opts) {
  const { fetchImpl = fetch, signal } = opts;
  const { url, init } = buildRequest(opts, false);
  const res = await fetchImpl(url, { ...init, signal });
  if (!res.ok) throw await failure(res);
  const json = await res.json();
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
