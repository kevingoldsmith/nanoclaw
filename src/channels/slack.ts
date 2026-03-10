import { App } from '@slack/bolt';
import { logger } from '../logger.js';
import { Channel, OnConnectionStatus, OnInboundMessage, OnChatMetadata } from '../types.js';

export interface SlackChannelOpts {
  appToken: string;
  botToken: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onConnectionStatus?: OnConnectionStatus;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app!: App;
  private connected = false;
  private opts: SlackChannelOpts;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60_000;
  private intentionalDisconnect = false;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.createApp();
  }

  private createApp(): void {
    this.app = new App({
      token: this.opts.botToken,
      appToken: this.opts.appToken,
      socketMode: true,
    });

    this.setupMessageHandlers();
  }

  private setupMessageHandlers(): void {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype) return; // Ignore bot messages, edits, etc.

      const msg = message as any;
      if (!msg.user || !msg.ts) return; // Skip if missing required fields

      // Acknowledge receipt with thumbs up
      this.addReaction(msg.channel, msg.ts);

      const chatJid = `slack-dm:${msg.user}`;
      const content = (msg.text || '').trim();
      const timestamp = new Date(parseFloat(msg.ts || '0') * 1000).toISOString();

      // Notify about chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', false);

      // Deliver message
      this.opts.onMessage(chatJid, {
        id: msg.ts,
        chat_jid: chatJid,
        sender: msg.user,
        sender_name: msg.user, // Will be enriched with actual name if needed
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: msg.bot_id !== undefined,
      });
    });

    // Handle app mentions (for channels/threads)
    this.app.event('app_mention', async ({ event }) => {
      if (!event.user || !event.ts || !event.channel) return; // Skip if missing required fields

      // Acknowledge receipt with thumbs up
      this.addReaction(event.channel, event.ts);

      const chatJid = `slack-channel:${event.channel}`;
      const content = (event.text || '').trim();
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();

      // Notify about chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      // Deliver message
      this.opts.onMessage(chatJid, {
        id: event.ts,
        chat_jid: chatJid,
        sender: event.user,
        sender_name: event.user,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    });
  }

  private addReaction(channel: string, timestamp: string): void {
    this.app.client.reactions.add({
      channel,
      timestamp,
      name: 'thumbsup',
    }).catch(err => {
      logger.warn({ err, channel, timestamp }, 'Failed to add reaction');
    });
  }

  private attachSocketListeners(): void {
    const receiver = (this.app as any).receiver;
    const client = receiver?.client;
    if (!client) {
      logger.warn('Could not access Slack SocketModeClient for monitoring');
      return;
    }

    // SocketModeClient emits state events: 'connected', 'reconnecting', 'disconnected'
    client.on('reconnecting', () => {
      logger.warn('Slack socket reconnecting (built-in)');
    });

    client.on('connected', () => {
      logger.info('Slack socket connected');
      this.connected = true;
      this.reconnectAttempts = 0;
    });

    // 'disconnected' means the built-in reconnect gave up
    client.on('disconnected', () => {
      logger.error('Slack socket fully disconnected (built-in reconnect exhausted)');
      this.connected = false;
      if (!this.intentionalDisconnect) {
        this.opts.onConnectionStatus?.('slack', 'disconnected', 'Socket disconnected');
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionalDisconnect) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling Slack reconnect');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        try { await this.app.stop(); } catch { /* ignore */ }

        this.createApp();
        await this.app.start();
        this.attachSocketListeners();
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.info('Slack reconnected successfully');
        this.opts.onConnectionStatus?.('slack', 'connected', 'Reconnected');
      } catch (err) {
        logger.error({ err, attempt: this.reconnectAttempts }, 'Slack reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  async connect(): Promise<void> {
    try {
      await this.app.start();
      this.attachSocketListeners();
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('Connected to Slack');
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Slack');
      this.opts.onConnectionStatus?.('slack', 'disconnected', `Failed to connect: ${err}`);
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      if (jid.startsWith('slack-dm:')) {
        const userId = jid.replace('slack-dm:', '');
        // Open DM channel and send
        const result = await this.app.client.conversations.open({
          users: userId,
        });
        if (result.channel?.id) {
          await this.app.client.chat.postMessage({
            channel: result.channel.id,
            text,
          });
          logger.info({ jid, length: text.length }, 'Slack DM sent');
        }
      } else if (jid.startsWith('slack-channel:')) {
        const channelId = jid.replace('slack-channel:', '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
        });
        logger.info({ jid, length: text.length }, 'Slack channel message sent');
      }
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send Slack message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack-dm:') || jid.startsWith('slack-channel:');
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      await this.app.stop();
      this.connected = false;
      logger.info('Disconnected from Slack');
    } catch (err) {
      logger.error({ err }, 'Error disconnecting from Slack');
    }
  }
}
