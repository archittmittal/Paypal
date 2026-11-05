import type { ProviderAdapter, ProviderRequest, ProviderResponse, Usage } from '@mandate/llm';
import type { ScriptedToolCall } from './scenario.js';

/** A tool the naive baselines may call. `inputSchema` is JSON Schema, as tool-use APIs expect. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolModelRequest {
  system: string;
  user: string;
  tools: readonly ToolSpec[];
}

export interface ToolModelResult {
  calls: ScriptedToolCall[];
  usage: Usage;
}

/**
 * A model with tools: what configurations (a) and (b) use. It lives only in packages/evals; the LLM layer
 * has no tool surface (ADR 0004), and its boundary test forbids importing this package.
 */
export interface ToolModel {
  readonly model: string;
  decide(request: ToolModelRequest): Promise<ToolModelResult>;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Fake mode: replays one scripted list of tool calls per decide() call. */
export class ScriptedToolModel implements ToolModel {
  readonly model = 'scripted';
  readonly requests: ToolModelRequest[] = [];
  readonly #turns: ScriptedToolCall[][];

  constructor(turns: readonly ScriptedToolCall[][]) {
    this.#turns = turns.map((turn) => [...turn]);
  }

  decide(request: ToolModelRequest): Promise<ToolModelResult> {
    this.requests.push(request);
    const calls = this.#turns.shift();
    if (!calls) return Promise.reject(new Error('ScriptedToolModel: no scripted turn left'));
    return Promise.resolve({ calls, usage: ZERO_USAGE });
  }
}

// Matches a ranking-prompt candidate header and the title block two blocks later (llm/src/ranker.ts layout).
const CANDIDATE_BLOCK =
  /^Candidate (cand_[A-Za-z0-9]+): unit price[^\n]*\n\n<untrusted_data[^>]*label="candidate_retailer">\n[^\n]*\n<\/untrusted_data[^>]*>\n\n<untrusted_data[^>]*label="candidate_title">\n([^\n]*)\n/gm;

/** Candidate id whose title starts with `titlePrefix` in a ranking prompt, or undefined. */
export function candidateIdByTitle(userText: string, titlePrefix: string): string | undefined {
  let prefixMatch: string | undefined;
  for (const match of userText.matchAll(CANDIDATE_BLOCK)) {
    // An exact title wins over a longer title that merely starts with the same text.
    if (match[2] === titlePrefix) return match[1];
    if (prefixMatch === undefined && match[2]?.startsWith(titlePrefix)) prefixMatch = match[1];
  }
  return prefixMatch;
}

/**
 * Fake mode for configuration (c): replays scripted replies through the real LlmClient. `{{cand:<title>}}`
 * becomes the matching candidate id from the prompt; an unmatched placeholder is left as is, so the schema
 * rejects it, like a fabricated id.
 */
export class ScriptedProvider implements ProviderAdapter {
  readonly provider = 'scripted';
  readonly model = 'scripted';
  readonly #replies: string[];

  constructor(replies: readonly string[]) {
    this.#replies = [...replies];
  }

  complete(request: ProviderRequest): Promise<ProviderResponse> {
    const reply = this.#replies.shift();
    if (reply === undefined) return Promise.reject(new Error('ScriptedProvider: no scripted reply left'));
    const text = reply.replace(/\{\{cand:([^}]+)\}\}/g, (placeholder, title: string) => candidateIdByTitle(request.userText, title) ?? placeholder);
    return Promise.resolve({ text, usage: ZERO_USAGE, model: this.model, stopReason: 'end' });
  }
}
