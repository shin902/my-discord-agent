const pendingBackfills = new Map<
  string,
  { done: Promise<boolean>; finish: (completed: boolean) => void }
>();

/** Register every root before scanning, including channels not reached yet. */
export function beginDiscordChannelBackfill(
  channelIds: readonly string[],
): void {
  for (const channelId of channelIds) {
    pendingBackfills.get(channelId)?.finish(false);
    let finish!: (completed: boolean) => void;
    const done = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    pendingBackfills.set(channelId, { done, finish });
  }
}

/** Failed scans keep the cursor gate closed, but release waiting live handlers. */
export function finishDiscordChannelBackfill(
  channelId: string,
  completed = true,
): void {
  pendingBackfills.get(channelId)?.finish(completed);
  if (completed) pendingBackfills.delete(channelId);
}

/** Captures must not pass older history from this root or any of its threads. */
export async function waitForDiscordChannelBackfill(
  channelId: string,
): Promise<boolean> {
  return (await pendingBackfills.get(channelId)?.done) ?? true;
}

/** Live cursors cannot skip history in a pending or failed root scan. */
export function isDiscordChannelBackfillPending(channelId: string): boolean {
  return pendingBackfills.has(channelId);
}
