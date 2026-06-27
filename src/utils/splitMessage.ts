const DISCORD_MAX_LENGTH = 2000;

/**
 * 改行を優先して Discord の文字数制限内に収めるようにメッセージを分割する。
 * 2000文字以内で最後の改行を探し、そこで分割。改行がなければ強制分割。
 *
 * コードフェンス（```で囲まれたブロック）で始まる場合は、フェンスを保持したまま
 * 内部コンテンツを分割し、各チャンクを再度フェンスで包む。
 * これにより、分割点でフェンスが壊れるのを防ぐ。
 * また、trimStart() を使わず slice(splitIndex + 1) にすることで、
 * パディングされた数値列の先頭スペースを保持する。
 */
export function splitMessage(
  text: string,
  maxLength: number = DISCORD_MAX_LENGTH,
): string[] {
  // コードフェンス対応の分割: 各チャンクをフェンスで再ラップする
  const fenceMatch = text.match(/^```(\S*)\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    const lang = fenceMatch[1];
    const inner = fenceMatch[2];
    const openFence = `\`\`\`${lang}\n`;
    const closeFence = `\n\`\`\``;
    const maxInner = maxLength - openFence.length - closeFence.length;
    const chunks: string[] = [];
    let remaining = inner;

    while (remaining.length > maxInner) {
      let splitIndex = remaining.lastIndexOf("\n", maxInner);
      if (splitIndex < 1) {
        splitIndex = maxInner;
      }
      chunks.push(openFence + remaining.slice(0, splitIndex) + closeFence);
      remaining = remaining.slice(splitIndex + 1); // \n をスキップ、trimStart() しない
    }

    if (remaining.length > 0) {
      chunks.push(openFence + remaining + closeFence);
    }

    return chunks;
  }

  // 通常の分割ロジック
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < 1) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
