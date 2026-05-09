import { describe, it, expect, vi } from 'vitest';

vi.mock('@mariozechner/pi-ai', () => ({
  getProviders: () => ['provider-a'],
  getModels: () => [{ id: 'model-x', name: 'Model X' }],
}));

const { resolveModel } = await import('./manager.js');

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
