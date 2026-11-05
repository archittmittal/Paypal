import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ToolModel, ToolModelRequest, ToolModelResult } from './models.js';

/** The fields read from a Messages API response. Anything else in the body is ignored. */
const ResponseShape = z.object({
  usage: z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() }),
  content: z.array(
    z.union([
      z.object({ type: z.literal('tool_use'), name: z.string(), input: z.unknown() }),
      z.object({ type: z.string().refine((type) => type !== 'tool_use') }),
    ]),
  ),
});

export type CreateMessage = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Live tool-use model for baselines (a) and (b). Only packages/evals may give a model tools (ADR 0004).
 * The SDK is pinned like the LLM layer's: explicit key and base URL, no SDK retries, logging and telemetry off.
 * VERIFY on the first live run: tool use together with Opus 5.5's always-on thinking within maxTokens.
 */
export class AnthropicToolModel implements ToolModel {
  readonly model: string;
  readonly #createMessage: CreateMessage;
  readonly #maxTokens: number;

  constructor(options: { model: string; apiKey?: string; maxTokens?: number; createMessage?: CreateMessage }) {
    this.model = options.model;
    this.#maxTokens = options.maxTokens ?? 8_192;
    if (options.createMessage) {
      this.#createMessage = options.createMessage;
    } else {
      if (!options.apiKey) throw new Error('AnthropicToolModel needs an API key');
      const client = new Anthropic({
        apiKey: options.apiKey,
        authToken: null,
        webhookKey: null,
        baseURL: 'https://api.anthropic.com',
        maxRetries: 0,
        logLevel: 'off',
        openTelemetry: false,
      });
      this.#createMessage = (params) => client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);
    }
  }

  async decide(request: ToolModelRequest): Promise<ToolModelResult> {
    const raw = await this.#createMessage({
      model: this.model,
      max_tokens: this.#maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    });
    const response = ResponseShape.parse(raw);
    const calls = response.content.flatMap((block) => ('name' in block ? [{ name: block.name, input: block.input }] : []));
    return { calls, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
  }
}
