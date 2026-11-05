import { describe, expect, it, vi } from 'vitest';
import { AnthropicToolModel } from '../src/anthropic-tools.js';
import { liveModels } from '../src/cli.js';
import { NAIVE_TOOLS } from '../src/configs/naive.js';
import { SAMPLE_SCENARIOS } from '../src/scenarios/samples.js';

const ANY_SCENARIO = SAMPLE_SCENARIOS[0] as (typeof SAMPLE_SCENARIOS)[number];

describe('AnthropicToolModel', () => {
  it('sends tools as input_schema and returns tool_use blocks only', async () => {
    const createMessage = vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(() =>
      Promise.resolve({
        usage: { input_tokens: 11, output_tokens: 7 },
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'text', text: 'Paying now.' },
          { type: 'tool_use', id: 't1', name: 'pay', input: { totalMinor: 5 } },
        ],
      }),
    );
    const model = new AnthropicToolModel({ model: 'claude-opus-5-5', maxTokens: 1000, createMessage });
    const result = await model.decide({ system: 'S', user: 'U', tools: NAIVE_TOOLS });
    expect(result).toEqual({ calls: [{ name: 'pay', input: { totalMinor: 5 } }], usage: { inputTokens: 11, outputTokens: 7 } });
    const params = createMessage.mock.calls[0]?.[0];
    expect(params).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1000, system: 'S', messages: [{ role: 'user', content: 'U' }] });
    expect(params?.tools).toEqual(NAIVE_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
    // No sampling parameters: the API rejects them (docs/llm-layer.md section 10).
    expect(params).not.toHaveProperty('temperature');
  });

  it('rejects a body that is not a Message', async () => {
    const model = new AnthropicToolModel({ model: 'm', createMessage: () => Promise.resolve('<html>gateway</html>') });
    await expect(model.decide({ system: '', user: '', tools: [] })).rejects.toThrow();
  });

  it('builds a real SDK client from a key, and refuses to start without one', () => {
    expect(new AnthropicToolModel({ model: 'm', apiKey: 'test-key-not-real' }).model).toBe('m');
    expect(() => new AnthropicToolModel({ model: 'm' })).toThrow('needs an API key');
  });

  it('liveModels reads LLM config and fails without a key', () => {
    const models = liveModels({ ANTHROPIC_API_KEY: 'test-key-not-real', LLM_MODEL: 'claude-opus-5-5' });
    expect(models).toMatchObject({ mode: 'live', modelId: 'claude-opus-5-5' });
    expect(models.toolModel(ANY_SCENARIO, 'naive').model).toBe('claude-opus-5-5');
    expect(models.provider(ANY_SCENARIO).model).toBe('claude-opus-5-5');
    expect(() => liveModels({})).toThrow('ANTHROPIC_API_KEY');
  });
});
