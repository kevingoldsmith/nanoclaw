# Trip Map Skill Design

## Problem

When NanoClaw prepares trip recommendations, the user currently has to manually add places to Google Maps. The goal is to automatically generate a map with pins that can be referenced on mobile while at the destination.

## Solution

A NanoClaw skill (`trip-map`) that the agent invokes automatically at the end of trip planning conversations. It creates a Google Sheet of recommended places in Google Drive (account #2), where the user can import it into Google My Maps for mobile viewing.

## Design

### Skill Location

`skills_for_nanoclaw/trip-map/SKILL.md` — prompt-only skill, no code.

### Relationship to `travel-recs` Skill

The existing `travel-recs` skill generates recommendations (restaurants, record stores, photography spots). The `trip-map` skill is a follow-up step: after `travel-recs` produces recommendations, the agent should automatically invoke `trip-map` to create the map sheet. The `travel-recs` instructions will be updated to reference `trip-map` as a final step.

### Trigger

Automatic. When the agent has recommended specific places during trip planning (whether via `travel-recs` or ad-hoc), it creates the map sheet as a final step — no explicit user request needed.

### Sheet Format

A Google Sheet with three columns:

| Name | Address | Description |
|------|---------|-------------|
| Tsukiji Outer Market | 5-2-1 Tsukiji, Chuo City, Tokyo | Fresh seafood and street food stalls |
| TeamLab Borderless | 6-10 Aomi, Koto City, Tokyo | Immersive digital art museum |

- **Name**: Place name (shown as pin label in My Maps)
- **Address**: Full address or landmark name — Google My Maps geocodes both. For neighborhoods/areas without street addresses, use the landmark or area name (e.g., "Shibuya Crossing, Tokyo" or "Golden Gai, Shinjuku, Tokyo")
- **Description**: Brief note about why the place was recommended (shown on pin click)

### Drive MCP Tools Used

All operations use `drive_account2` (`@piotr-agier/google-drive-mcp`, kevin.goldsmith@gmail.com). Specific tools:

1. `mcp__drive_account2__search` — Find existing "Trip Maps" folder and existing sheets
2. `mcp__drive_account2__createFolder` — Create "Trip Maps" folder if it doesn't exist
3. `mcp__drive_account2__createGoogleSheet` — Create the sheet in the folder
4. `mcp__drive_account2__appendSpreadsheetRows` — Add place data rows
5. `mcp__drive_account2__deleteItem` — Remove old version before recreating (for updates)

### Drive Workflow

1. **Find/create folder**: Search for "Trip Maps" folder; create it if not found
2. **Check for existing sheet**: Search for a sheet matching the trip name in "Trip Maps"
3. **Delete if exists**: If updating, delete the old sheet (overwrite = delete + recreate)
4. **Create sheet**: Create `{Destination} {Month Year}` Google Sheet in "Trip Maps" folder
5. **Add header row**: Append row with Name, Address, Description
6. **Add place rows**: Append one row per recommended place

### File Naming

`{Destination} {Month Year}` (Google Sheet title)

Examples:
- `Tokyo June 2026`
- `Barcelona September 2026`
- `New York April 2026`

For multi-city trips (e.g., "Tokyo and Kyoto"), use the broader region or trip name (e.g., `Japan June 2026`) and include all cities' places in one sheet.

### User Message

After creating the sheet, the agent tells the user:

> Created "{sheet name}" with {N} places in Trip Maps on Google Drive. To view on your phone:
> 1. Open Google My Maps (mymaps.google.com)
> 2. Create New Map → Import
> 3. Select from Google Drive → Trip Maps → {sheet name}

### Fallback

If Drive upload fails (MCP error, auth issue), the agent should paste the places as a formatted table directly in the chat message so the user can manually add them.

### What This Does NOT Do

- No new MCP servers or third-party packages
- No Google Maps Platform API key
- No code changes to NanoClaw core (src/*)
- No container or Dockerfile changes
- No new credentials or OAuth setup

### Dependencies

- Existing `drive_account2` MCP server (already configured and authenticated)
- Google My Maps (free, uses same Google account)

## Implementation

Two deliverables:

1. **Create `skills_for_nanoclaw/trip-map/SKILL.md`** — Skill instructions telling the agent how to format the data and use Drive MCP to create the sheet
2. **Update `skills_for_nanoclaw/travel-recs/instructions.md`** — Add a final step referencing `trip-map` so the agent automatically creates the map after generating recommendations

No cache clear needed — skills in `skills_for_nanoclaw/` are synced into containers on each spawn.
