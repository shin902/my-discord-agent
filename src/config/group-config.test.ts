import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const { readFile } = await import('fs/promises');
const { loadGroupConfig } = await import('./group-config.js');

beforeEach(() => {
  vi.mocked(readFile).mockReset();
});

describe('loadGroupConfig', () => {
  it('パストラバーサルを含むグループ名はエラー', async () => {
    await expect(loadGroupConfig('../../etc/passwd')).rejects.toThrow('不正なグループ名');
  });

  it('ファイルが存在しない場合は空オブジェクトを返す', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await loadGroupConfig('nonexistent')).toEqual({});
  });

  it('ENOENT 以外のエラーは再スロー', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(loadGroupConfig('test')).rejects.toThrow('EACCES');
  });

  it('不正な JSON は SyntaxError を投げる', async () => {
    vi.mocked(readFile).mockResolvedValue('{ invalid json }' as any);
    await expect(loadGroupConfig('test')).rejects.toThrow(SyntaxError);
  });

  it('model フィールドなしの空オブジェクトはそのまま返す', async () => {
    vi.mocked(readFile).mockResolvedValue('{}' as any);
    expect(await loadGroupConfig('test')).toEqual({});
  });

  it('有効な model 設定をパースして返す', async () => {
    vi.mocked(readFile).mockResolvedValue(
      '{"model":{"provider":"opencode-go","modelId":"kimi-k2.6"}}' as any,
    );
    const config = await loadGroupConfig('test');
    expect(config.model).toEqual({ provider: 'opencode-go', modelId: 'kimi-k2.6' });
  });
});
