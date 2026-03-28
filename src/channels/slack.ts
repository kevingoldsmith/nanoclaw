import { App } from '@slack/bolt';
import { SocketModeClient } from '@slack/socket-mode';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';
import { saveMediaToGroup } from '../media.js';
import { transcribeAudioBuffer } from '../transcription.js';

// ---- helpers ----------------------------------------------------------------

function slackDmJid(userId: string): string {
  return `slack-dm:${userId}`;
}

function slackChannelJid(channelId: string): string {
  return `slack-channel:${channelId}`;
}

/**
 * Download a file from Slack, following redirects manually so we can re-attach
 * the Authorization header after cross-origin redirects (Slack strips it).
 */
async function downloadSlackFile(
  url: string,
  token: string,
): Promise<Buffer | null> {
  const MAX_REDIRECTS = 5;
  let currentUrl = url;
  let redirectsLeft = MAX_REDIRECTS;

  while (redirectsLeft-- > 0) {
    const response = await fetch(currentUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      currentUrl = location;
      continue;
    }

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      // Got a login page — auth didn't work
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  }
  return null;
}

// ---- factory ----------------------------------------------------------------

registerChannel('slack', (opts: ChannelOpts): Channel | null => {
  const { onMessage, onChatMetadata } = opts;

  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!appToken || !botToken) {
    logger.debug(
      'Slack channel disabled — SLACK_APP_TOKEN / SLACK_BOT_TOKEN not set',
    );
    return null;
  }

  // ---- state ---------------------------------------------------------------

  let connected = false;
  let reconnectAttempts = 0;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 60_000;
  let shuttingDown = false;

  // The App + SocketModeClient pair is recreated on reconnect
  let app = createApp();
  let socketClient: SocketModeClient | null = null;

  // ---- App factory ---------------------------------------------------------

  function createApp(): App {
    return new App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      // Suppress Bolt's own logger noise — we use our own
      logLevel: 'error' as unknown as import('@slack/bolt').LogLevel,
    });
  }

  // ---- socket monitoring ---------------------------------------------------

  function attachSocketListeners(client: SocketModeClient): void {
    client.on('connecting', () => {
      logger.info('Slack socket connecting');
    });

    client.on('connected', () => {
      logger.info('Slack socket connected');
      connected = true;
      reconnectAttempts = 0;
      reconnectDelay = 1000;
    });

    client.on('disconnecting', () => {
      logger.info('Slack socket disconnecting');
    });

    client.on('disconnected', async (err?: Error) => {
      connected = false;
      if (shuttingDown) return;

      logger.warn(
        { err: err?.message, attempt: reconnectAttempts },
        'Slack socket disconnected — scheduling reconnect',
      );

      scheduleReconnect();
    });

    client.on('reconnecting', () => {
      logger.info({ attempt: reconnectAttempts }, 'Slack socket reconnecting');
    });
  }

  // ---- reconnect logic -----------------------------------------------------

  function scheduleReconnect(): void {
    reconnectAttempts += 1;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);

    logger.info(
      { delayMs: delay, attempt: reconnectAttempts },
      'Slack reconnect scheduled',
    );

    setTimeout(() => {
      if (shuttingDown) return;
      doReconnect();
    }, delay);
  }

  async function doReconnect(): Promise<void> {
    try {
      app = createApp();
      registerHandlers(app);

      // Extract the SocketModeClient from the new receiver
      const receiver = (
        app as unknown as { receiver: { client?: SocketModeClient } }
      ).receiver;
      if (receiver?.client) {
        socketClient = receiver.client;
        attachSocketListeners(socketClient);
      }

      await app.start();
      logger.info('Slack reconnected successfully');
    } catch (err) {
      logger.error({ err }, 'Slack reconnect attempt failed');
      scheduleReconnect();
    }
  }

  // ---- message handlers ----------------------------------------------------

  function registerHandlers(slackApp: App): void {
    // Direct messages
    slackApp.message(async ({ message, client, ack }) => {
      // Bolt message events don't have a standard ack, but handle subtypes
      const msg = message as {
        subtype?: string;
        user?: string;
        bot_id?: string;
        text?: string;
        ts: string;
        channel: string;
        files?: Array<{
          name?: string;
          url_private?: string;
          mimetype?: string;
        }>;
      };

      // Skip subtypes except file_share (which carries files with text)
      if (msg.subtype && msg.subtype !== 'file_share') return;
      // Skip bot messages
      if (msg.bot_id) return;
      if (!msg.user) return;

      const userId = msg.user;
      const chatJid = slackDmJid(userId);
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();

      // Look up display name
      let senderName = userId;
      try {
        const info = await client.users.info({ user: userId });
        senderName =
          info.user?.profile?.display_name ||
          info.user?.profile?.real_name ||
          info.user?.name ||
          userId;
      } catch {
        // non-fatal
      }

      // Build content — download and save files if present
      let content = msg.text ?? '';
      if (msg.files?.length) {
        const groups = opts.registeredGroups();
        const group = groups[chatJid];
        const fileLines: string[] = [];

        for (const file of msg.files) {
          const downloadUrl = file.url_private;
          if (!downloadUrl || !group) {
            fileLines.push(`[File: ${file.name ?? 'unknown'}]`);
            continue;
          }
          try {
            const buffer = await downloadSlackFile(downloadUrl, botToken!);
            if (!buffer) {
              fileLines.push(
                `[File: ${file.name ?? 'unknown'} - download failed]`,
              );
              continue;
            }
            const mimetype = file.mimetype ?? 'application/octet-stream';
            const saved = saveMediaToGroup(
              buffer,
              file.name ?? 'file',
              mimetype,
              group.folder,
            );
            fileLines.push(saved.contentLine);

            if (mimetype.startsWith('audio/')) {
              const transcript = await transcribeAudioBuffer(
                buffer,
                mimetype,
                file.name,
              );
              if (transcript) {
                fileLines.push(`[Transcript: ${transcript}]`);
              }
            }
          } catch (err) {
            logger.warn(
              { err, fileName: file.name },
              'Failed to process Slack file',
            );
            fileLines.push(`[File: ${file.name ?? 'unknown'} - error]`);
          }
        }
        const filePart = fileLines.join('\n');
        content = content ? `${content}\n${filePart}` : filePart;
      }
      if (!content.trim()) return;

      // Acknowledge with thumbs-up
      try {
        await client.reactions.add({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'thumbsup',
        });
      } catch {
        // reaction can fail silently
      }

      const newMessage: NewMessage = {
        id: `slack-${msg.ts}`,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      onChatMetadata(chatJid, timestamp, senderName, 'slack', false);
      onMessage(chatJid, newMessage);
    });

    // Channel mentions
    slackApp.event('app_mention', async ({ event, client }) => {
      const mentionEvent = event as {
        user: string;
        text: string;
        ts: string;
        channel: string;
        files?: Array<{
          name?: string;
          url_private?: string;
          mimetype?: string;
        }>;
      };

      const userId = mentionEvent.user;
      const channelId = mentionEvent.channel;
      const chatJid = slackChannelJid(channelId);
      const timestamp = new Date(
        parseFloat(mentionEvent.ts) * 1000,
      ).toISOString();

      let senderName = userId;
      try {
        const info = await client.users.info({ user: userId });
        senderName =
          info.user?.profile?.display_name ||
          info.user?.profile?.real_name ||
          info.user?.name ||
          userId;
      } catch {
        // non-fatal
      }

      let content = mentionEvent.text ?? '';
      if (mentionEvent.files?.length) {
        const groups = opts.registeredGroups();
        const group = groups[chatJid];
        const fileLines: string[] = [];

        for (const file of mentionEvent.files) {
          const downloadUrl = file.url_private;
          if (!downloadUrl || !group) {
            fileLines.push(`[File: ${file.name ?? 'unknown'}]`);
            continue;
          }
          try {
            const buffer = await downloadSlackFile(downloadUrl, botToken!);
            if (!buffer) {
              fileLines.push(
                `[File: ${file.name ?? 'unknown'} - download failed]`,
              );
              continue;
            }
            const mimetype = file.mimetype ?? 'application/octet-stream';
            const saved = saveMediaToGroup(
              buffer,
              file.name ?? 'file',
              mimetype,
              group.folder,
            );
            fileLines.push(saved.contentLine);

            if (mimetype.startsWith('audio/')) {
              const transcript = await transcribeAudioBuffer(
                buffer,
                mimetype,
                file.name,
              );
              if (transcript) {
                fileLines.push(`[Transcript: ${transcript}]`);
              }
            }
          } catch (err) {
            logger.warn(
              { err, fileName: file.name },
              'Failed to process Slack file',
            );
            fileLines.push(`[File: ${file.name ?? 'unknown'} - error]`);
          }
        }
        const filePart = fileLines.join('\n');
        content = content ? `${content}\n${filePart}` : filePart;
      }
      if (!content.trim()) return;

      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: mentionEvent.ts,
          name: 'thumbsup',
        });
      } catch {
        // non-fatal
      }

      const newMessage: NewMessage = {
        id: `slack-${mentionEvent.ts}`,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      onChatMetadata(chatJid, timestamp, senderName, 'slack', true);
      onMessage(chatJid, newMessage);
    });
  }

  // Register handlers on the initial App instance
  registerHandlers(app);

  // ---- send helpers --------------------------------------------------------

  async function resolveConversationId(jid: string): Promise<string> {
    if (jid.startsWith('slack-dm:')) {
      const userId = jid.slice('slack-dm:'.length);
      const result = await app.client.conversations.open({ users: userId });
      const channelId = (result as { channel?: { id?: string } }).channel?.id;
      if (!channelId) throw new Error(`Could not open DM with ${userId}`);
      return channelId;
    } else if (jid.startsWith('slack-channel:')) {
      return jid.slice('slack-channel:'.length);
    }
    throw new Error(`Unknown JID format: ${jid}`);
  }

  // ---- Channel interface ---------------------------------------------------

  const channel: Channel & {
    sendThreadedMessage(
      jid: string,
      text: string,
      threadTs?: string,
    ): Promise<string | undefined>;
  } = {
    name: 'slack',

    async connect(): Promise<void> {
      // Extract socket client from the receiver so we can attach listeners
      const receiver = (
        app as unknown as { receiver: { client?: SocketModeClient } }
      ).receiver;
      if (receiver?.client) {
        socketClient = receiver.client;
        attachSocketListeners(socketClient);
      }

      await app.start();
      connected = true;
      logger.info('Slack channel connected');
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      const conversationId = await resolveConversationId(jid);
      await app.client.chat.postMessage({
        channel: conversationId,
        text,
      });
    },

    async sendThreadedMessage(
      jid: string,
      text: string,
      threadTs?: string,
    ): Promise<string | undefined> {
      const conversationId = await resolveConversationId(jid);
      const result = await app.client.chat.postMessage({
        channel: conversationId,
        text,
        thread_ts: threadTs,
      });
      return (result as { ts?: string }).ts;
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid.startsWith('slack-dm:') || jid.startsWith('slack-channel:');
    },

    async disconnect(): Promise<void> {
      shuttingDown = true;
      await app.stop();
      connected = false;
      logger.info('Slack channel disconnected');
    },
  };

  return channel;
});
