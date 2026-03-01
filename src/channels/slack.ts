import { App } from '@slack/bolt';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

export interface SlackChannelOpts {
  appToken: string;
  botToken: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private connected = false;
  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
    });

    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype) return; // Ignore bot messages, edits, etc.

      const msg = message as any;
      if (!msg.user || !msg.ts) return; // Skip if missing required fields

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

  async connect(): Promise<void> {
    try {
      await this.app.start();
      this.connected = true;
      logger.info('Connected to Slack');
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Slack');
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
    try {
      await this.app.stop();
      this.connected = false;
      logger.info('Disconnected from Slack');
    } catch (err) {
      logger.error({ err }, 'Error disconnecting from Slack');
    }
  }
}
