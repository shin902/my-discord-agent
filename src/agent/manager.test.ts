import { describe, it, expect, vi, beforeEach } from 'vitest';

const { AgentMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getProviders: () => ['provider-a', 'opencode-go'],
  getModels: (provider: string) =>
    provider === 'opencode-go'
      ? [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }]
      : [{ id: 'model-x', name: 'Model X' }],
}));

vi.mock('@mariozechner/pi-agent-core', () => ({
  Agent: AgentMock,
}));

vi.mock('./session.js', () => ({
  loadMessages: vi.fn(),
  appendMessage: vi.fn(),
}));

vi.mock('../config/group-config.js', () => ({
  loadGroupConfig: vi.fn(),
  loadGroupSystemPrompt: vi.fn(),
}));

const { resolveModel, sendMessage } = await import('./manager.js');
const { loadMessages, appendMessage } = await import('./session.js');
const { loadGroupConfig, loadGroupSystemPrompt } = await import('../config/group-config.js');
let lastAgentOptions: unknown;

function createMockAgent(deltas: string[], endMessage: unknown) {
  const subscribers: Array<(event: unknown) => void> = [];
  return {
    subscribe: vi.fn((cb: (event: unknown) => void) => subscribers.push(cb)),
    prompt: vi.fn(async () => {
      for (const delta of deltas) {
        for (const cb of subscribers) {
          cb({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta },
          });
        }
      }
      for (const cb of subscribers) {
        cb({ type: 'message_end', message: endMessage });
      }
    }),
  };
}

describe('resolveModel', () => {
  it('有効なプロバイダとモデルIDはモデルを返す', () => {
    const model = resolveModel('provider-a', 'model-x');
    expect(model.id).toBe('model-x');
  });

  it('不明なプロバイダはエラー', () => {
    expect(() => resolveModel('unknown-provider', 'model-x')).toThrow('不明なプロバイダ: unknown-provider');
  });

  it('不明なモデルIDはエラー', () => {
    expect(() => resolveModel('provider-a', 'unknown-model')).toThrow('不明なモデル: unknown-model (provider: provider-a)');
  });
});

describe('sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastAgentOptions = undefined;
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(loadGroupConfig).mockResolvedValue({});
    vi.mocked(loadGroupSystemPrompt).mockResolvedValue(null);
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return createMockAgent(['OK'], { role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
    } as any);
  });

  it('メッセージを送信して返答テキストを返す', async () => {
    const mockAgent = createMockAgent(['Hello', ' world'], { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    } as any);

    const result = await sendMessage('test-group', 'session-1', 'こんにちは');

    expect(loadMessages).toHaveBeenCalledWith('test-group', 'session-1');
    expect(loadGroupConfig).toHaveBeenCalledWith('test-group');
    expect(loadGroupSystemPrompt).toHaveBeenCalledWith('test-group');
    expect(lastAgentOptions).toEqual({
      initialState: {
        systemPrompt: 'あなたは役立つDiscordアシスタントです。',
        model: { id: 'kimi-k2.6', name: 'Kimi K2.6' },
        messages: [],
      },
    });
    expect(mockAgent.prompt).toHaveBeenCalledWith('こんにちは');
    expect(result).toBe('Hello world');
    expect(appendMessage).toHaveBeenCalledWith('test-group', 'session-1', { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] });
  });

  it('グループ設定のモデルを使用する', async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({
      model: { provider: 'provider-a', modelId: 'model-x' },
    });

    const mockAgent = createMockAgent(['OK'], { role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    } as any);

    await sendMessage('test-group', 'session-1', 'hi');

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: { id: 'model-x', name: 'Model X' },
        }),
      }),
    );
  });

  it('カスタム systemPrompt を使用する', async () => {
    vi.mocked(loadGroupSystemPrompt).mockResolvedValue('カスタムプロンプト');

    const mockAgent = createMockAgent(['OK'], { role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    } as any);

    await sendMessage('test-group', 'session-1', 'hi');

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          systemPrompt: 'カスタムプロンプト',
        }),
      }),
    );
  });

  it('resolveModel 失敗時はエラーメッセージを返す', async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({
      model: { provider: 'unknown', modelId: 'model-x' },
    });

    const result = await sendMessage('test-group', 'session-1', 'hi');

    expect(result).toBe('設定エラー: 不明なプロバイダ: unknown');
    expect(lastAgentOptions).toBeUndefined();
  });

  it('メッセージ履歴を Agent に引き継ぐ', async () => {
    const history = [{ role: 'user' as const, content: '前回のメッセージ', timestamp: Date.now() }];
    vi.mocked(loadMessages).mockResolvedValue(history);

    const mockAgent = createMockAgent(['OK'], { role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    } as any);

    await sendMessage('test-group', 'session-1', 'hi');

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          messages: history,
        }),
      }),
    );
  });
});
