import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from 'discord.js';

vi.mock('./client.js', () => ({
  client: { once: vi.fn(), on: vi.fn() },
}));

vi.mock('../queue/inbox.js', () => ({
  appendInbox: vi.fn(),
}));

vi.mock('../config/groups.js', () => ({
  findGroupByChannelId: vi.fn(),
}));

const { client } = await import('./client.js');
const { appendInbox } = await import('../queue/inbox.js');
const { findGroupByChannelId } = await import('../config/groups.js');
const { registerHandlers } = await import('./handler.js');

const mockAppendInbox = vi.mocked(appendInbox);
const mockFindGroup = vi.mocked(findGroupByChannelId);

// ハンドラーを一度だけ登録し、以降はコールバックを取り出して直接呼ぶ
registerHandlers();

function getMessageHandler(): (msg: Message) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = (client.on as any).mock.calls as [string, (msg: Message) => Promise<void>][];
  const call = calls.find(([event]) => event === 'messageCreate');
  if (!call) throw new Error('messageCreate ハンドラーが登録されていません');
  return call[1];
}

function makeMockMessage(opts: {
  isThread: boolean;
  channelId: string;
  parentId?: string | null;
  content?: string;
  isBot?: boolean;
}): Message {
  return {
    author: { bot: opts.isBot ?? false },
    channelId: opts.channelId,
    channel: {
      isThread: () => opts.isThread,
      parentId: opts.parentId ?? null,
    },
    content: opts.content ?? 'hello',
    createdAt: new Date(),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message;
}

describe('registerHandlers - MessageCreate', () => {
  beforeEach(() => {
    mockFindGroup.mockReset();
    mockAppendInbox.mockReset().mockResolvedValue(undefined);
  });

  it('bot のメッセージは無視される', async () => {
    const msg = makeMockMessage({ isBot: true, isThread: false, channelId: 'ch-1' });
    await getMessageHandler()(msg);
    expect(mockFindGroup).not.toHaveBeenCalled();
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it('グループ設定がないチャンネルは無視される', async () => {
    mockFindGroup.mockResolvedValue(null);
    const msg = makeMockMessage({ isThread: false, channelId: 'unknown-ch' });
    await getMessageHandler()(msg);
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it('shared モード: 直接メッセージはチャンネルIDをセッションIDとして積む', async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: 'default', channels: [] },
      channel: { channelId: 'ch-1', sessionMode: 'shared' },
    });
    const msg = makeMockMessage({ isThread: false, channelId: 'ch-1', content: 'テスト' });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith('ch-1');
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ch-1', groupName: 'default', content: 'テスト' }),
    );
  });

  it('shared モード: スレッドメッセージは親チャンネルIDで検索し無視される', async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: 'default', channels: [] },
      channel: { channelId: 'ch-1', sessionMode: 'shared' },
    });
    const msg = makeMockMessage({ isThread: true, channelId: 'thread-1', parentId: 'ch-1' });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith('ch-1'); // スレッドIDではなく parentId で検索
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it('thread モード: 直接メッセージはチャンネルIDで検索し無視される', async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: 'support', channels: [] },
      channel: { channelId: 'ch-1', sessionMode: 'thread' },
    });
    const msg = makeMockMessage({ isThread: false, channelId: 'ch-1' });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith('ch-1');
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it('thread モード: スレッドメッセージは親チャンネルIDで検索しスレッドIDをセッションIDとして積む', async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: 'support', channels: [] },
      channel: { channelId: 'ch-1', sessionMode: 'thread' },
    });
    const msg = makeMockMessage({
      isThread: true,
      channelId: 'thread-123',
      parentId: 'ch-1',
      content: 'こんにちは',
    });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith('ch-1'); // スレッドIDではなく parentId で検索
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'thread-123', groupName: 'support' }),
    );
  });
});
