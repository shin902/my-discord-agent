import { describe, it, expect } from 'vitest';
import { splitMessage } from './splitMessage.js';

const MAX = 2000;

describe('splitMessage', () => {
  it('2000文字以下は分割しない', () => {
    const text = 'a'.repeat(2000);
    const result = splitMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it('改行あり・2000文字超は改行位置で分割', () => {
    const line1 = 'a'.repeat(500) + '\n';
    const line2 = 'b'.repeat(500) + '\n';
    const line3 = 'c'.repeat(1500); // 合計2500文字超
    const text = line1 + line2 + line3;

    const result = splitMessage(text);

    expect(result).toHaveLength(2);
    // 最初のチャンクは line1 + line2 で終わる（改行位置で分割）
    expect(result[0]).toBe(line1 + line2.slice(0, -1));
    // 残りは line3
    expect(result[1]).toBe(line3);
  });

  it('改行なし・2000文字超は強制分割', () => {
    const text = 'x'.repeat(2500);
    const result = splitMessage(text);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe('x'.repeat(2000));
    expect(result[1]).toBe('x'.repeat(500));
  });

  it('連続する長いブロックは3チャンク以上になる', () => {
    // 4500文字で改行なし → 2000 + 2000 + 500 の3チャンク
    const text = 'z'.repeat(4500);
    const result = splitMessage(text);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe('z'.repeat(2000));
    expect(result[1]).toBe('z'.repeat(2000));
    expect(result[2]).toBe('z'.repeat(500));
  });

  it('先頭の改行は無視して強制分割', () => {
    const text = '\n' + 'y'.repeat(2500);
    const result = splitMessage(text);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe('\n' + 'y'.repeat(1999));
    expect(result[1]).toBe('y'.repeat(501));
  });

  it('分割後のチャンクはmaxLength以下', () => {
    const text = ('word '.repeat(100) + '\n').repeat(50); // 長めのテキスト
    const result = splitMessage(text);

    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('空文字列は空配列', () => {
    const result = splitMessage('');
    expect(result).toEqual(['']);
  });
});
