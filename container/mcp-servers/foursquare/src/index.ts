/**
 * Foursquare/Swarm Check-in MCP Server
 * Provides tools to query the user's Swarm check-in history.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const token = process.env.FOURSQUARE_TOKEN;
const API_VERSION = '20250101';
const BASE_URL = 'https://api.foursquare.com/v2/users/self/checkins';

interface Checkin {
  id: string;
  createdAt: number;
  venue: {
    name: string;
    location: {
      address?: string;
      city?: string;
      state?: string;
      country?: string;
      formattedAddress?: string[];
      lat: number;
      lng: number;
    };
    categories: Array<{ name: string }>;
  };
  shout?: string;
}

async function fetchCheckins(limit: number): Promise<Checkin[]> {
  if (!token) throw new Error('FOURSQUARE_TOKEN not set');

  const url = `${BASE_URL}?oauth_token=${token}&v=${API_VERSION}&limit=${limit}&sort=newestfirst`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Foursquare API error ${res.status}: ${body}`);
  }

  const data = await res.json() as { response: { checkins: { items: Checkin[] } } };
  return data.response.checkins.items;
}

function formatCheckin(c: Checkin): string {
  const time = new Date(c.createdAt * 1000).toISOString();
  const venue = c.venue;
  const category = venue.categories[0]?.name || 'Unknown';
  const address = venue.location.formattedAddress?.join(', ')
    || [venue.location.address, venue.location.city, venue.location.state].filter(Boolean).join(', ')
    || 'No address';
  const coords = `${venue.location.lat}, ${venue.location.lng}`;

  let text = `**${venue.name}** (${category})\n`;
  text += `Address: ${address}\n`;
  text += `Coordinates: ${coords}\n`;
  text += `Time: ${time}`;
  if (c.shout) text += `\nNote: ${c.shout}`;
  return text;
}

const server = new McpServer({
  name: 'foursquare',
  version: '1.0.0',
});

server.tool(
  'get_last_checkin',
  'Get the most recent Swarm check-in (location, venue, time)',
  async () => {
    const checkins = await fetchCheckins(1);
    if (checkins.length === 0) {
      return { content: [{ type: 'text', text: 'No check-ins found.' }] };
    }
    return { content: [{ type: 'text', text: formatCheckin(checkins[0]) }] };
  },
);

server.tool(
  'get_recent_checkins',
  'Get recent Swarm check-ins',
  { count: z.number().min(1).max(50).default(5).describe('Number of check-ins to retrieve') },
  async ({ count }) => {
    const checkins = await fetchCheckins(count);
    if (checkins.length === 0) {
      return { content: [{ type: 'text', text: 'No check-ins found.' }] };
    }
    const text = checkins.map((c, i) => `${i + 1}. ${formatCheckin(c)}`).join('\n\n');
    return { content: [{ type: 'text', text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
