const pendingBackfills = new Set<string>();

/** 起動時バックフィルがまだ完了していないルートチャンネルを登録する。 */
export function beginDiscordChannelBackfill(channelIds: readonly string[]): void {
  for (const channelId of channelIds) pendingBackfills.add(channelId);
}

/** ルートチャンネルのバックフィル完了を記録する。 */
export function finishDiscordChannelBackfill(channelId: string): void {
  pendingBackfills.delete(channelId);
}

/**
 * ルートチャンネル、またはそのスレッドのバックフィルが未完了かを返す。
 *
 * バックフィルは設定されたチャンネル単位で逐次実行されるため、未到達の
 * チャンネルではライブ取り込みによるカーソル更新を止める必要がある。
 */
export function isDiscordChannelBackfillPending(channelId: string): boolean {
  return pendingBackfills.has(channelId);
}
