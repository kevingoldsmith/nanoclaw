/**
 * Check-in MCP Server
 *
 * Queries Kevin's own check-in app for the most recent check-in.
 *
 * Auth is OAuth2 client-credentials against Cognito. The agent credential is
 * scoped to `checkin-api/latest.read`, which reaches GET /checkins/latest and
 * nothing else — a 403 on any other route is the design working, not a bug.
 *
 * Access tokens are short-lived and held in memory only. They are never
 * written to disk.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const TOKEN_ENDPOINT = process.env.CHECKIN_APP_TOKEN_ENDPOINT;
const CLIENT_ID = process.env.CHECKIN_APP_AGENT_CLIENT_ID;
const CLIENT_SECRET = process.env.CHECKIN_APP_SECRET;
const API = process.env.CHECKIN_APP_API;

const SCOPE = 'checkin-api/latest.read';

/** Refresh this many ms before actual expiry, so a token can't die mid-flight. */
const EXPIRY_MARGIN_MS = 60_000;

interface Checkin {
  checkin_id: string;
  place_id: string;
  place_name: string;
  place_lat: number;
  place_lon: number;
  locality: string | null;
  country: string | null;
  note: string | null;
  created_at: string;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function requireConfig(): {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  api: string;
} {
  const missing = [
    ['CHECKIN_APP_TOKEN_ENDPOINT', TOKEN_ENDPOINT],
    ['CHECKIN_APP_AGENT_CLIENT_ID', CLIENT_ID],
    ['CHECKIN_APP_SECRET', CLIENT_SECRET],
    ['CHECKIN_APP_API', API],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Check-in app not configured: ${missing.join(', ')} not set`);
  }

  return {
    tokenEndpoint: TOKEN_ENDPOINT!,
    clientId: CLIENT_ID!,
    clientSecret: CLIENT_SECRET!,
    api: API!.replace(/\/+$/, ''),
  };
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  const { tokenEndpoint, clientId, clientSecret } = requireConfig();

  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: SCOPE,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Token response contained no access_token');
  }

  const lifetimeMs = (data.expires_in ?? 3600) * 1000;
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - EXPIRY_MARGIN_MS, 0),
  };

  return cachedToken.value;
}

/** `null` means the API answered 404 — an empty check-in table, not a failure. */
async function fetchLatestCheckin(): Promise<Checkin | null> {
  const { api } = requireConfig();
  const url = `${api}/checkins/latest`;

  const request = async (token: string) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  let res = await request(await getAccessToken());

  // A cached token can be rejected if it was revoked or rotated server-side.
  // Retry exactly once with a freshly minted token before giving up.
  if (res.status === 401) {
    cachedToken = null;
    res = await request(await getAccessToken(true));
  }

  if (res.status === 404) return null;

  if (res.status === 403) {
    throw new Error(
      'Check-in API returned 403. The agent credential is scoped to ' +
        `${SCOPE} (GET /checkins/latest only) and cannot reach other routes.`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Check-in API error ${res.status}: ${body}`);
  }

  return (await res.json()) as Checkin;
}

function describeAge(createdAt: Date): string {
  const ms = Date.now() - createdAt.getTime();
  if (ms < 0) return 'just now';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatCheckin(c: Checkin): string {
  const createdAt = new Date(c.created_at);
  const valid = !Number.isNaN(createdAt.getTime());

  const where = [c.place_name, c.locality, c.country].filter(Boolean).join(', ');

  const lines = [
    `Last check-in: **${c.place_name}**`,
    `When: ${c.created_at}${valid ? ` (${describeAge(createdAt)})` : ''}`,
    `Where: ${where}`,
    `Coordinates: ${c.place_lat}, ${c.place_lon}`,
  ];

  if (c.note) lines.push(`Note: ${c.note}`);

  lines.push(
    '',
    'This is where Kevin last chose to check in, which may be hours or days ' +
      'old. It is not a live location. Always state the check-in time when ' +
      'reporting this — say "Kevin last checked in at X on <time>", never ' +
      '"Kevin is at X".',
  );

  return lines.join('\n');
}

const server = new McpServer({
  name: 'checkin',
  version: '1.0.0',
});

server.tool(
  'get_last_checkin',
  "Get Kevin's most recent check-in from his check-in app (place, locality, " +
    'coordinates, note, and the time he checked in). This is a self-reported ' +
    'check-in, not a live location — it may be days old, so always report it ' +
    'with its timestamp.',
  async () => {
    const checkin = await fetchLatestCheckin();

    if (!checkin) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No check-ins yet — Kevin has not checked in anywhere.',
          },
        ],
      };
    }

    return { content: [{ type: 'text' as const, text: formatCheckin(checkin) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
