import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// vi.resetModules() 後も同じ関数参照を保つためにホイスト
const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  registerHandlers: vi.fn(),
  startPoller: vi.fn(),
  loadGroups: vi.fn(),
  initGroupConfigs: vi.fn(),
  validateModel: vi.fn(),
}));

vi.mock('./discord/client.js', () => ({ client: { login: mocks.login } }));
vi.mock('./discord/handler.js', () => ({ registerHandlers: mocks.registerHandlers }));
vi.mock('./queue/poller.js', () => ({ startPoller: mocks.startPoller, stopPoller: vi.fn() }));
vi.mock('./config/groups.js', () => ({ loadGroups: mocks.loadGroups }));
vi.mock('./config/group-config.js', () => ({ initGroupConfigs: mocks.initGroupConfigs }));
vi.mock('./agent/manager.js', () => ({
  validateModel: mocks.validateModel,
  DEFAULT_PROVIDER: 'opencode-go',
  DEFAULT_MODEL_ID: 'kimi-k2.6',
}));

describe('index: 起動時バリデーション', () => {
  const ORIGINAL_TOKEN = process.env.DISCORD_BOT_TOKEN;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    // デフォルトは空グループ（上書きしないテスト用）
    mocks.loadGroups.mockResolvedValue([]);
    mocks.initGroupConfigs.mockResolvedValue(new Map());
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.DISCORD_BOT_TOKEN;
    } else {
      process.env.DISCORD_BOT_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it('DISCORD_BOT_TOKEN 未設定は起動時にスロー', async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    await expect(import('./index.js')).rejects.toThrow('DISCORD_BOT_TOKEN が設定されていません');
  });

  it('不明なプロバイダーは起動時にスロー', async () => {
    mocks.loadGroups.mockResolvedValue([{ name: 'bad-group', channels: [] }]);
    mocks.initGroupConfigs.mockResolvedValue(
      new Map([['bad-group', { model: { provider: 'unknown', modelId: 'x' } }]]),
    );
    mocks.validateModel.mockImplementation((provider: string) => {
      throw new Error(`不明なプロバイダ: ${provider}`);
    });

    await expect(import('./index.js')).rejects.toThrow('不明なプロバイダ: unknown');
  });

  it('有効な設定では registerHandlers・startPoller・login が呼ばれる', async () => {
    mocks.loadGroups.mockResolvedValue([{ name: 'ok-group', channels: [] }]);
    mocks.initGroupConfigs.mockResolvedValue(
      new Map([['ok-group', { model: { provider: 'opencode-go', modelId: 'kimi-k2.6' } }]]),
    );
    mocks.validateModel.mockReturnValue({ id: 'kimi-k2.6', name: 'Kimi K2.6' });

    await import('./index.js');

    expect(mocks.registerHandlers).toHaveBeenCalledOnce();
    expect(mocks.startPoller).toHaveBeenCalledOnce();
    expect(mocks.login).toHaveBeenCalledWith('test-token');
  });
});
