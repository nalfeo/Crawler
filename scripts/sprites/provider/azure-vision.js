/**
 * Azure OpenAI vision/chat-completions adapter used by the VLM judge.
 *
 * The judge sends ONE chat-completion request per variant with:
 *   - a system message containing the evaluator definitions and rubric,
 *   - a user message containing the prompt + multiple labelled images
 *     attached as `image_url` parts with base64 `data:` URLs.
 *
 * Conventions mirror `azure-openai.ts` and `azure-chat.ts`:
 *
 *   - Constructor takes `fetch` so unit tests stub the network.
 *   - No retries here — the caller (the orchestrator) decides whether a
 *     failed judge call is fatal or worth retrying. The judge itself is
 *     local-only and per-variant, so a retry loop would burn Azure credits
 *     silently; we surface every failure as a typed error and let the
 *     human inspect.
 *   - All failures surface as `VisionProviderError` with a typed `kind`.
 *
 * The provider validates that the model returned a JSON object (parses
 * with `JSON.parse` after stripping markdown fences) but does NOT
 * validate the shape — the judge's Zod schema does that. Keeping the
 * provider schema-agnostic means adding a fourth evaluator doesn't
 * touch this file.
 */
import { VisionProviderError } from './vision-types.js';
export class AzureOpenAIVisionProvider {
  endpoint;
  modelDeployment;
  apiKey;
  apiVersion;
  fetchImpl;
  constructor(opts) {
    this.endpoint = stripTrailingSlash(opts.endpoint);
    this.modelDeployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetch ?? fetch;
  }
  async evaluate(request) {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(this.modelDeployment)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    const userContent = [{ type: 'text', text: request.userPrompt }];
    for (const image of request.images) {
      userContent.push(buildImagePart(image));
    }
    const body = {
      messages: [
        { role: 'system', content: request.systemInstructions },
        { role: 'user', content: userContent },
      ],
      // Near-deterministic by default. Judges are evaluations, not
      // creative work; we want the same verdict on a re-run.
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 800,
      response_format: { type: 'json_object' },
    };
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new VisionProviderError(
        'network',
        `network error calling Azure vision: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!response.ok) {
      const kind = httpStatusToKind(response.status);
      const bodyText = await safeText(response);
      throw new VisionProviderError(
        kind,
        `Azure vision returned ${response.status}: ${truncate(bodyText, 500)}`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new VisionProviderError(
        'malformed',
        `Azure vision response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (payload.error) {
      throw new VisionProviderError(
        'provider-error',
        `Azure vision error ${payload.error.code ?? '<unknown>'}: ${payload.error.message ?? ''}`,
      );
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new VisionProviderError(
        'malformed',
        'Azure vision response missing choices[0].message.content',
      );
    }
    const json = parseJsonObject(content);
    if (json === null) {
      throw new VisionProviderError(
        'malformed',
        `Azure vision response did not contain a JSON object: ${truncate(content, 200)}`,
      );
    }
    return {
      json,
      usage: extractUsage(payload),
      modelDeployment: this.modelDeployment,
    };
  }
}
function buildImagePart(image) {
  const dataUrl = `data:image/png;base64,${image.png.toString('base64')}`;
  return {
    type: 'image_url',
    image_url: { url: dataUrl, detail: 'high' },
  };
}
/**
 * Parse a JSON OBJECT from a model response that may have prose, code
 * fences, or trailing commentary. Strategy mirrors `azure-chat.ts` but
 * returns the parsed object directly (the chat provider returns an array
 * of strings, which is a slightly different post-processing problem).
 *
 * Returns `null` when no JSON object can be extracted — the caller
 * surfaces this as `VisionProviderError(malformed)`.
 */
function parseJsonObject(content) {
  const candidates = [content];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = content.indexOf('{');
  if (firstBrace > 0) candidates.push(content.slice(firstBrace));
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try next strategy
    }
  }
  return null;
}
function extractUsage(payload) {
  const usage = payload.usage;
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}
function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
function httpStatusToKind(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  return 'provider-error';
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
//# sourceMappingURL=azure-vision.js.map
