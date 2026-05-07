const DISCORD_MAX_LENGTH = 2000;

/**
 * 改行を優先して Discord の文字数制限内に収めるようにメッセージを分割する。
 * 2000文字以内で最後の改行を探し、そこで分割。改行がなければ強制分割。
 */
export function splitMessage(
  text: string,
  maxLength: number = DISCORD_MAX_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
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
