import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- mocks (must be before any imports that trigger them) ----

vi.mock('dotenv/config', () => ({}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockPostMessage = vi.fn().mockResolvedValue({ ts: '1234.5678' });
const mockConversationsOpen = vi
  .fn()
  .mockResolvedValue({ channel: { id: 'D_RESOLVED' } });
const mockReactionsAdd = vi.fn().mockResolvedValue({});
const mockUsersInfo = vi.fn().mockResolvedValue({
  user: { profile: { display_name: 'Test User' }, name: 'testuser' },
});

const mockMessageHandler = vi.fn();
const mockEventHandler = vi.fn();
const mockReceiverClientOn = vi.fn();

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    start = mockStart;
    stop = mockStop;
    client = {
      chat: { postMessage: mockPostMessage },
      conversations: { open: mockConversationsOpen },
      reactions: { add: mockReactionsAdd },
      users: { info: mockUsersInfo },
    };
    message = mockMessageHandler;
    event = mockEventHandler;
    receiver = { client: { on: mockReceiverClientOn } };
  },
}));

vi.mock('@slack/socket-mode', () => ({
  SocketModeClient: vi.fn(),
}));

// ---- imports ----

import { getChannelFactory } from './registry.js';

// Importing slack.ts triggers registerChannel as a side effect
import './slack.js';

// ---- helpers ----

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

function makeChannel() {
  process.env.SLACK_APP_TOKEN = 'xapp-test-token';
  process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  const factory = getChannelFactory('slack')!;
  return factory(makeOpts());
}

// ---- tests ----

describe('Slack channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: tokens set
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
  });

  it('registers a factory named "slack"', () => {
    expect(getChannelFactory('slack')).toBeDefined();
  });

  it('factory returns null when tokens are missing', () => {
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    const factory = getChannelFactory('slack')!;
    const channel = factory(makeOpts());
    expect(channel).toBeNull();
  });

  it('factory returns null when only app token is missing', () => {
    delete process.env.SLACK_APP_TOKEN;
    const factory = getChannelFactory('slack')!;
    const channel = factory(makeOpts());
    expect(channel).toBeNull();
  });

  it('factory returns null when only bot token is missing', () => {
    delete process.env.SLACK_BOT_TOKEN;
    const factory = getChannelFactory('slack')!;
    const channel = factory(makeOpts());
    expect(channel).toBeNull();
  });

  it('factory returns a channel with name "slack" when tokens are set', () => {
    const channel = makeChannel();
    expect(channel).not.toBeNull();
    expect(channel?.name).toBe('slack');
  });

  describe('ownsJid', () => {
    it('returns true for slack-dm: JIDs', () => {
      const channel = makeChannel()!;
      expect(channel.ownsJid('slack-dm:U01ABC123')).toBe(true);
    });

    it('returns true for slack-channel: JIDs', () => {
      const channel = makeChannel()!;
      expect(channel.ownsJid('slack-channel:C01ABC123')).toBe(true);
    });

    it('returns false for non-Slack JIDs', () => {
      const channel = makeChannel()!;
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
      expect(channel.ownsJid('telegram-dm:123')).toBe(false);
    });
  });

  describe('connect', () => {
    it('sets isConnected to true', async () => {
      const channel = makeChannel()!;
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('calls app.start()', async () => {
      const channel = makeChannel()!;
      await channel.connect();
      expect(mockStart).toHaveBeenCalledOnce();
    });
  });

  describe('disconnect', () => {
    it('sets isConnected to false after connect', async () => {
      const channel = makeChannel()!;
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('calls app.stop()', async () => {
      const channel = makeChannel()!;
      await channel.connect();
      await channel.disconnect();
      expect(mockStop).toHaveBeenCalledOnce();
    });
  });

  describe('sendMessage', () => {
    it('posts to channel directly for slack-channel: JIDs', async () => {
      const channel = makeChannel()!;
      await channel.sendMessage('slack-channel:C01TEST', 'hello world');
      expect(mockConversationsOpen).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C01TEST',
        text: 'hello world',
      });
    });

    it('opens a conversation for slack-dm: JIDs then posts', async () => {
      const channel = makeChannel()!;
      await channel.sendMessage('slack-dm:U01TEST', 'hello dm');
      expect(mockConversationsOpen).toHaveBeenCalledWith({ users: 'U01TEST' });
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'D_RESOLVED',
        text: 'hello dm',
      });
    });
  });

  describe('sendThreadedMessage', () => {
    it('passes thread_ts when provided', async () => {
      const channel = makeChannel()! as {
        sendThreadedMessage(
          jid: string,
          text: string,
          threadTs?: string,
        ): Promise<string | undefined>;
      } & ReturnType<typeof makeChannel>;
      await channel.sendThreadedMessage(
        'slack-channel:C01TEST',
        'reply text',
        '9999.0001',
      );
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C01TEST',
        text: 'reply text',
        thread_ts: '9999.0001',
      });
    });

    it('returns the ts from the post result', async () => {
      const channel = makeChannel()! as {
        sendThreadedMessage(
          jid: string,
          text: string,
          threadTs?: string,
        ): Promise<string | undefined>;
      } & ReturnType<typeof makeChannel>;
      const ts = await channel.sendThreadedMessage(
        'slack-channel:C01TEST',
        'msg',
      );
      expect(ts).toBe('1234.5678');
    });
  });
});
