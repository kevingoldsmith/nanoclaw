import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- mocks (must be before any imports that trigger them) ----

vi.mock('dotenv/config', () => ({}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
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

  describe('downtime watchdog', () => {
    // The flap detector only counts 'disconnected' events, so it is blind to
    // a socket that wedges in 'connecting' or churns without ever completing
    // a handshake. Neither emits 'disconnected'.
    function handlersFor(event: string): Array<(...args: unknown[]) => void> {
      return mockReceiverClientOn.mock.calls
        .filter((c) => c[0] === event)
        .map((c) => c[1] as (...args: unknown[]) => void);
    }

    function fire(event: string): void {
      handlersFor(event).forEach((h) => h());
    }

    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      vi.useRealTimers();
      exitSpy.mockRestore();
    });

    it('exits when a handshake never completes', async () => {
      const channel = makeChannel()!;
      await channel.connect();

      fire('connecting');
      await vi.advanceTimersByTimeAsync(299_000);
      expect(exitSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits when the socket churns without ever connecting', async () => {
      // Observed live: connecting -> reconnecting -> connecting every ~15s,
      // never reaching 'connected'. A watchdog re-armed on each 'connecting'
      // would reset its clock forever and never fire.
      const channel = makeChannel()!;
      await channel.connect();

      fire('connecting');
      for (let elapsed = 0; elapsed < 300_000; elapsed += 15_000) {
        await vi.advanceTimersByTimeAsync(15_000);
        fire('reconnecting');
        fire('connecting');
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not exit when the handshake completes in time', async () => {
      const channel = makeChannel()!;
      await channel.connect();

      fire('connecting');
      await vi.advanceTimersByTimeAsync(51_000); // observed real-world handshake
      fire('connected');

      await vi.advanceTimersByTimeAsync(300_000);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('does not exit when a disconnect recovers within the window', async () => {
      const channel = makeChannel()!;
      await channel.connect();

      fire('connecting');
      fire('connected');
      fire('disconnected');
      await vi.advanceTimersByTimeAsync(60_000);
      fire('connecting');
      fire('connected');

      await vi.advanceTimersByTimeAsync(300_000);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits when a disconnect never recovers', async () => {
      const channel = makeChannel()!;
      await channel.connect();

      fire('connecting');
      fire('connected');
      fire('disconnected');

      await vi.advanceTimersByTimeAsync(301_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('does not exit when shutting down mid-handshake', async () => {
      const channel = makeChannel()!;
      await channel.connect();

      fire('connecting');
      await channel.disconnect();

      await vi.advanceTimersByTimeAsync(300_000);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
