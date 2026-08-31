const DISCORD_MAX_LENGTH = 2000;

type FenceState = {
  openingLine: string;
};

type SplitPoint = {
  index: number;
  state: FenceState | null;
};

function fenceAt(
  text: string,
  index: number,
  state: FenceState | null,
): SplitPoint | null {
  if (index > 0 && text[index - 1] !== "\n") return null;

  const newlineIndex = text.indexOf("\n", index);
  const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
  const line = text.slice(index, newlineIndex === -1 ? end : newlineIndex);
  const lineWithoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;

  if (state) {
    if (!/^```[ \t]*$/.test(lineWithoutCr)) return null;
    return { index: end, state: null };
  }

  if (!/^```[^`\r\n]*$/.test(lineWithoutCr)) return null;
  return {
    index: end,
    state: { openingLine: lineWithoutCr },
  };
}

function closingFence(content: string, state: FenceState | null): string {
  if (!state) return "";
  return content.endsWith("\n") ? "```" : "\n```";
}

function splitFencedMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  let state: FenceState | null = null;

  while (start < text.length) {
    const prefix = state ? `${state.openingLine}\n` : "";
    let scan = start;
    let scanState: FenceState | null = state;
    let lastValid: SplitPoint | null = null;
    let lastNewline: SplitPoint | null = null;

    while (scan < text.length) {
      const fence = fenceAt(text, scan, scanState);
      const nextIndex = fence?.index ?? scan + 1;
      const nextState: FenceState | null = fence ? fence.state : scanState;
      const content = text.slice(start, nextIndex);
      const suffix = closingFence(content, nextState);

      if (prefix.length + content.length + suffix.length > maxLength) break;

      scan = nextIndex;
      scanState = nextState;
      lastValid = { index: scan, state: scanState };
      if (text[scan - 1] === "\n") lastNewline = lastValid;
    }

    const splitPoint: SplitPoint | null =
      lastValid?.index === text.length
        ? lastValid
        : lastNewline && lastNewline.index - start > 1
          ? lastNewline
          : lastValid;

    // A fence marker or reopening prefix can only make a chunk impossible when
    // maxLength is unusually small. Fall back to the ordinary bounded split so
    // callers still make progress and never exceed their requested limit.
    if (!splitPoint) {
      return splitPlainMessage(text, maxLength);
    }

    const content = text.slice(start, splitPoint.index);
    chunks.push(prefix + content + closingFence(content, splitPoint.state));
    start = splitPoint.index;
    state = splitPoint.state;
  }

  return chunks;
}

function splitPlainMessage(text: string, maxLength: number): string[] {
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

/**
 * 改行を優先して Discord の文字数制限内に収めるようにメッセージを分割する。
 * 2000文字以内で最後の改行を探し、そこで分割。改行がなければ強制分割。
 * コードフェンス内で分割する場合は各チャンクでフェンスを閉じ、次のチャンクで
 * 同じ言語指定のフェンスを再開する。
 */
export function splitMessage(
  text: string,
  maxLength: number = DISCORD_MAX_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];

  return /(?:^|\n)```/.test(text)
    ? splitFencedMessage(text, maxLength)
    : splitPlainMessage(text, maxLength);
}
