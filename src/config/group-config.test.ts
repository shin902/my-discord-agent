import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

const { readFile } = await import('fs/promises');
const { loadGroupConfig, loadGroupSystemPrompt } = await import('./group-config.js');

// readFile はオーバーロードがあり vi.mocked がデフォルトで Buffer 返しの overload を選ぶため、
// string 返しの overload に一度だけキャストして各テストで as any を使わずに済むようにする。
const mockReadFile = vi.mocked(readFile) as unknown as Mock<() => Promise<string>>;

beforeEach(() => {
  mockReadFile.mockReset();
});

describe('loadGroupConfig', () => {
  it('パストラバーサルを含むグループ名はエラー', async () => {
    await expect(loadGroupConfig('../../etc/passwd')).rejects.toThrow('不正なグループ名');
  });

  it('ファイルが存在しない場合は空オブジェクトを返す', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await loadGroupConfig('nonexistent')).toEqual({});
  });

  it('ENOENT 以外のエラーは再スロー', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(loadGroupConfig('test')).rejects.toThrow('EACCES');
  });

  it('不正な JSON はグループ名入りのエラーを投げる', async () => {
    mockReadFile.mockResolvedValue('{ invalid json }');
    await expect(loadGroupConfig('test')).rejects.toThrow('グループ設定の JSON が不正です (test)');
  });

  it('空ファイルはグループ名入りのエラーを投げる', async () => {
    mockReadFile.mockResolvedValue('');
    await expect(loadGroupConfig('test')).rejects.toThrow('グループ設定の JSON が不正です (test)');
  });

  it('スキーマに合わない JSON はグループ名入りのエラーを投げる', async () => {
    mockReadFile.mockResolvedValue('{"model":"invalid"}');
    await expect(loadGroupConfig('test')).rejects.toThrow('グループ設定が不正です (test)');
  });

  it('model フィールドなしの空オブジェクトはそのまま返す', async () => {
    mockReadFile.mockResolvedValue('{}');
    expect(await loadGroupConfig('test')).toEqual({});
  });

  it('有効な model 設定をパースして返す', async () => {
    mockReadFile.mockResolvedValue('{"model":{"provider":"opencode-go","modelId":"kimi-k2.6"}}');
    const config = await loadGroupConfig('test');
    expect(config.model).toEqual({ provider: 'opencode-go', modelId: 'kimi-k2.6' });
  });
});

describe('loadGroupSystemPrompt', () => {
  it('パストラバーサルを含むグループ名はエラー', async () => {
    await expect(loadGroupSystemPrompt('../../etc/passwd')).rejects.toThrow('不正なグループ名');
  });

  it('ファイルが存在しない場合は null を返す', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await loadGroupSystemPrompt('test')).toBeNull();
  });

  it('ENOENT 以外のエラーは再スロー', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(loadGroupSystemPrompt('test')).rejects.toThrow('EACCES');
  });

  it('ファイルが存在する場合は内容を返す', async () => {
    mockReadFile.mockResolvedValue('あなたは役立つアシスタントです。');
    expect(await loadGroupSystemPrompt('test')).toBe('あなたは役立つアシスタントです。');
  });
});
