#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import fs from "fs";
import path from "path";
import http from "http";
import os from "os";

import { createEmailMessage, createEmailWithNodemailer, type EmailArgs } from "./email-utils.js";
import {
  createLabel,
  updateLabel,
  deleteLabel,
  listLabels,
  getOrCreateLabel,
} from "./label-manager.js";
import {
  createFilter,
  listFilters,
  getFilter,
  deleteFilter,
  filterTemplates,
} from "./filter-manager.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const oauthPath =
  process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const credentialsPath =
  process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, "credentials.json");

let oauth2Client: OAuth2Client;

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

function loadCredentials(): void {
  // Ensure config dir exists when using defaults
  if (!process.env.GMAIL_OAUTH_PATH && !process.env.GMAIL_CREDENTIALS_PATH) {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  // Also check cwd for a local copy of the keys (convenience for first-time setup)
  const localOAuthPath = path.join(process.cwd(), "gcp-oauth.keys.json");
  if (fs.existsSync(localOAuthPath) && !fs.existsSync(oauthPath)) {
    const dir = path.dirname(oauthPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(localOAuthPath, oauthPath);
    console.error("OAuth keys found in cwd, copied to", oauthPath);
  }

  if (!fs.existsSync(oauthPath)) {
    console.error(
      `Error: OAuth keys not found at ${oauthPath}. Set GMAIL_OAUTH_PATH or place gcp-oauth.keys.json in cwd / ${CONFIG_DIR}`,
    );
    process.exit(1);
  }

  const keysContent = JSON.parse(fs.readFileSync(oauthPath, "utf8"));
  const keys = keysContent.installed || keysContent.web;
  if (!keys) {
    console.error(
      'Error: Invalid OAuth keys — file must contain "installed" or "web" credentials.',
    );
    process.exit(1);
  }

  const callbackUrl =
    process.argv[2] === "auth" && process.argv[3]
      ? process.argv[3]
      : "http://localhost:3000/oauth2callback";

  oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, callbackUrl);

  if (fs.existsSync(credentialsPath)) {
    const tokens = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    oauth2Client.setCredentials(tokens);
  }

  // ------------------------------------------------------------------
  // CRITICAL: persist refreshed tokens so they survive process restarts
  // ------------------------------------------------------------------
  oauth2Client.on("tokens", (newTokens) => {
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(credentialsPath)) {
        existing = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
      }
      const merged = { ...existing, ...newTokens };
      const dir = path.dirname(credentialsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(credentialsPath, JSON.stringify(merged, null, 2));
      console.error(`Tokens refreshed and saved to ${credentialsPath}`);
    } catch (err) {
      console.error("Failed to persist refreshed tokens:", err);
    }
  });
}

// ---------------------------------------------------------------------------
// Interactive OAuth flow (auth subcommand)
// ---------------------------------------------------------------------------

async function authenticate(): Promise<void> {
  const server = http.createServer();
  server.listen(3000);

  return new Promise<void>((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ],
    });

    console.error("Visit this URL to authenticate:\n");
    console.error(authUrl);
    console.error("\nWaiting for callback on http://localhost:3000 ...");

    server.on("request", async (req, res) => {
      if (!req.url?.startsWith("/oauth2callback")) return;
      const url = new URL(req.url, "http://localhost:3000");
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("No code provided");
        reject(new Error("No code provided"));
        return;
      }
      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const dir = path.dirname(credentialsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(credentialsPath, JSON.stringify(tokens, null, 2));
        res.writeHead(200);
        res.end("Authentication successful! You can close this window.");
        server.close();
        resolve();
      } catch (error) {
        res.writeHead(500);
        res.end("Authentication failed");
        reject(error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Gmail helpers
// ---------------------------------------------------------------------------

interface EmailContent {
  text: string;
  html: string;
}

function extractEmailContent(part: gmail_v1.Schema$MessagePart): EmailContent {
  let textContent = "";
  let htmlContent = "";

  if (part.body?.data) {
    const content = Buffer.from(part.body.data, "base64").toString("utf8");
    if (part.mimeType === "text/plain") textContent = content;
    else if (part.mimeType === "text/html") htmlContent = content;
  }

  if (part.parts) {
    for (const sub of part.parts) {
      const { text, html } = extractEmailContent(sub);
      if (text) textContent += text;
      if (html) htmlContent += html;
    }
  }

  return { text: textContent, html: htmlContent };
}

function encodeRaw(message: string): string {
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Send or draft an email, with optional attachments. */
async function handleEmailAction(
  gmail: gmail_v1.Gmail,
  action: "send" | "draft",
  args: EmailArgs,
) {
  let rawMessage: string;

  if (args.attachments && args.attachments.length > 0) {
    rawMessage = await createEmailWithNodemailer(args);
  } else {
    rawMessage = createEmailMessage(args);
  }

  const encoded = encodeRaw(rawMessage);
  const messageBody: Record<string, string> = { raw: encoded };
  if (args.threadId) messageBody.threadId = args.threadId;

  if (action === "send") {
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: messageBody,
    });
    return `Email sent successfully with ID: ${res.data.id}`;
  } else {
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: messageBody },
    });
    return `Email draft created successfully with ID: ${res.data.id}`;
  }
}

/** Process items in batches, falling back to individual items on batch failure. */
async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (batch: T[]) => Promise<R[]>,
): Promise<{ successes: R[]; failures: { item: T; error: Error }[] }> {
  const successes: R[] = [];
  const failures: { item: T; error: Error }[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    try {
      successes.push(...(await fn(batch)));
    } catch {
      for (const item of batch) {
        try {
          successes.push(...(await fn([item])));
        } catch (err: any) {
          failures.push({ item, error: err });
        }
      }
    }
  }
  return { successes, failures };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadCredentials();

  // --- Auth subcommand ---------------------------------------------------
  if (process.argv[2] === "auth") {
    await authenticate();
    console.error("Authentication completed successfully");
    process.exit(0);
  }

  // --- MCP server --------------------------------------------------------
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const server = new McpServer({
    name: "gmail",
    version: "1.0.0",
  });

  // ---- send_email / draft_email ----------------------------------------

  const emailSchema = {
    to: z.array(z.string()).describe("List of recipient email addresses"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
    htmlBody: z.string().optional().describe("HTML version of the email body"),
    mimeType: z
      .enum(["text/plain", "text/html", "multipart/alternative"])
      .optional()
      .default("text/plain")
      .describe("Email content type"),
    cc: z.array(z.string()).optional().describe("List of CC recipients"),
    bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
    threadId: z.string().optional().describe("Thread ID to reply to"),
    inReplyTo: z.string().optional().describe("Message ID being replied to"),
    attachments: z.array(z.string()).optional().describe("List of file paths to attach"),
  };

  server.tool("send_email", "Sends a new email", emailSchema, async (args) => {
    const result = await handleEmailAction(gmail, "send", args as EmailArgs);
    return text(result);
  });

  server.tool("draft_email", "Drafts a new email", emailSchema, async (args) => {
    const result = await handleEmailAction(gmail, "draft", args as EmailArgs);
    return text(result);
  });

  // ---- read_email ------------------------------------------------------

  server.tool(
    "read_email",
    "Retrieves the content of a specific email",
    { messageId: z.string().describe("ID of the email message to retrieve") },
    async ({ messageId }) => {
      const response = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const headers = response.data.payload?.headers || [];
      const hdr = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const subject = hdr("subject");
      const from = hdr("from");
      const to = hdr("to");
      const date = hdr("date");
      const threadId = response.data.threadId || "";

      const { text: plainText, html } = extractEmailContent(response.data.payload || {});
      const body = plainText || html || "";
      const note =
        !plainText && html
          ? "[Note: This email is HTML-formatted. Plain text version not available.]\n\n"
          : "";

      // Collect attachment info
      interface AttachmentInfo {
        id: string;
        filename: string;
        mimeType: string;
        size: number;
      }
      const attachments: AttachmentInfo[] = [];
      const walk = (part: gmail_v1.Schema$MessagePart) => {
        if (part.body?.attachmentId) {
          attachments.push({
            id: part.body.attachmentId,
            filename: part.filename || `attachment-${part.body.attachmentId}`,
            mimeType: part.mimeType || "application/octet-stream",
            size: part.body.size || 0,
          });
        }
        if (part.parts) part.parts.forEach(walk);
      };
      if (response.data.payload) walk(response.data.payload);

      const attachInfo =
        attachments.length > 0
          ? `\n\nAttachments (${attachments.length}):\n` +
            attachments
              .map(
                (a) =>
                  `- ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)} KB, ID: ${a.id})`,
              )
              .join("\n")
          : "";

      return text(
        `Thread ID: ${threadId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${note}${body}${attachInfo}`,
      );
    },
  );

  // ---- search_emails ---------------------------------------------------

  server.tool(
    "search_emails",
    "Searches for emails using Gmail search syntax",
    {
      query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
      maxResults: z.number().optional().describe("Maximum number of results to return"),
    },
    async ({ query, maxResults }) => {
      const response = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: maxResults || 10,
      });

      const messages = response.data.messages || [];
      const results = await Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });
          const h = detail.data.payload?.headers || [];
          return {
            id: msg.id,
            subject: h.find((x) => x.name === "Subject")?.value || "",
            from: h.find((x) => x.name === "From")?.value || "",
            date: h.find((x) => x.name === "Date")?.value || "",
          };
        }),
      );

      return text(
        results
          .map((r) => `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`)
          .join("\n"),
      );
    },
  );

  // ---- modify_email ----------------------------------------------------

  server.tool(
    "modify_email",
    "Modifies email labels (move to different folders)",
    {
      messageId: z.string().describe("ID of the email message to modify"),
      labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
      addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add"),
      removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove"),
    },
    async ({ messageId, labelIds, addLabelIds, removeLabelIds }) => {
      const requestBody: gmail_v1.Schema$ModifyMessageRequest = {};
      if (labelIds) requestBody.addLabelIds = labelIds;
      if (addLabelIds) requestBody.addLabelIds = addLabelIds;
      if (removeLabelIds) requestBody.removeLabelIds = removeLabelIds;

      await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody });
      return text(`Email ${messageId} labels updated successfully`);
    },
  );

  // ---- delete_email ----------------------------------------------------

  server.tool(
    "delete_email",
    "Permanently deletes an email",
    { messageId: z.string().describe("ID of the email message to delete") },
    async ({ messageId }) => {
      await gmail.users.messages.delete({ userId: "me", id: messageId });
      return text(`Email ${messageId} deleted successfully`);
    },
  );

  // ---- list_email_labels -----------------------------------------------

  server.tool(
    "list_email_labels",
    "Retrieves all available Gmail labels",
    {},
    async () => {
      const result = await listLabels(gmail);
      return text(
        `Found ${result.count.total} labels (${result.count.system} system, ${result.count.user} user):\n\n` +
          "System Labels:\n" +
          result.system.map((l) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n") +
          "\nUser Labels:\n" +
          result.user.map((l) => `ID: ${l.id}\nName: ${l.name}\n`).join("\n"),
      );
    },
  );

  // ---- batch_modify_emails ---------------------------------------------

  server.tool(
    "batch_modify_emails",
    "Modifies labels for multiple emails in batches",
    {
      messageIds: z.array(z.string()).describe("List of message IDs to modify"),
      addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
      removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
      batchSize: z.number().optional().default(50).describe("Batch size (default 50)"),
    },
    async ({ messageIds, addLabelIds, removeLabelIds, batchSize }) => {
      const requestBody: gmail_v1.Schema$ModifyMessageRequest = {};
      if (addLabelIds) requestBody.addLabelIds = addLabelIds;
      if (removeLabelIds) requestBody.removeLabelIds = removeLabelIds;

      const { successes, failures } = await processBatches(
        messageIds,
        batchSize || 50,
        async (batch) =>
          Promise.all(
            batch.map(async (id) => {
              await gmail.users.messages.modify({ userId: "me", id, requestBody });
              return { messageId: id, success: true };
            }),
          ),
      );

      let out = `Batch label modification complete.\nSuccessfully processed: ${successes.length} messages\n`;
      if (failures.length > 0) {
        out += `Failed to process: ${failures.length} messages\n\nFailed message IDs:\n`;
        out += failures
          .map((f) => `- ${String(f.item).substring(0, 16)}... (${f.error.message})`)
          .join("\n");
      }
      return text(out);
    },
  );

  // ---- batch_delete_emails ---------------------------------------------

  server.tool(
    "batch_delete_emails",
    "Permanently deletes multiple emails in batches",
    {
      messageIds: z.array(z.string()).describe("List of message IDs to delete"),
      batchSize: z.number().optional().default(50).describe("Batch size (default 50)"),
    },
    async ({ messageIds, batchSize }) => {
      const { successes, failures } = await processBatches(
        messageIds,
        batchSize || 50,
        async (batch) =>
          Promise.all(
            batch.map(async (id) => {
              await gmail.users.messages.delete({ userId: "me", id });
              return { messageId: id, success: true };
            }),
          ),
      );

      let out = `Batch delete operation complete.\nSuccessfully deleted: ${successes.length} messages\n`;
      if (failures.length > 0) {
        out += `Failed to delete: ${failures.length} messages\n\nFailed message IDs:\n`;
        out += failures
          .map((f) => `- ${String(f.item).substring(0, 16)}... (${f.error.message})`)
          .join("\n");
      }
      return text(out);
    },
  );

  // ---- create_label ----------------------------------------------------

  server.tool(
    "create_label",
    "Creates a new Gmail label",
    {
      name: z.string().describe("Name for the new label"),
      messageListVisibility: z.enum(["show", "hide"]).optional().describe("Show/hide in message list"),
      labelListVisibility: z
        .enum(["labelShow", "labelShowIfUnread", "labelHide"])
        .optional()
        .describe("Visibility in label list"),
    },
    async (args) => {
      const result = await createLabel(gmail, args.name, {
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
      });
      return text(`Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`);
    },
  );

  // ---- update_label ----------------------------------------------------

  server.tool(
    "update_label",
    "Updates an existing Gmail label",
    {
      id: z.string().describe("ID of the label to update"),
      name: z.string().optional().describe("New name for the label"),
      messageListVisibility: z.enum(["show", "hide"]).optional().describe("Show/hide in message list"),
      labelListVisibility: z
        .enum(["labelShow", "labelShowIfUnread", "labelHide"])
        .optional()
        .describe("Visibility in label list"),
    },
    async (args) => {
      const updates: gmail_v1.Schema$Label = {};
      if (args.name) updates.name = args.name;
      if (args.messageListVisibility) updates.messageListVisibility = args.messageListVisibility;
      if (args.labelListVisibility) updates.labelListVisibility = args.labelListVisibility;
      const result = await updateLabel(gmail, args.id, updates);
      return text(`Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`);
    },
  );

  // ---- delete_label ----------------------------------------------------

  server.tool(
    "delete_label",
    "Deletes a Gmail label",
    { id: z.string().describe("ID of the label to delete") },
    async ({ id }) => {
      const result = await deleteLabel(gmail, id);
      return text(result.message);
    },
  );

  // ---- get_or_create_label ---------------------------------------------

  server.tool(
    "get_or_create_label",
    "Gets an existing label by name or creates it if it doesn't exist",
    {
      name: z.string().describe("Name of the label to get or create"),
      messageListVisibility: z.enum(["show", "hide"]).optional().describe("Show/hide in message list"),
      labelListVisibility: z
        .enum(["labelShow", "labelShowIfUnread", "labelHide"])
        .optional()
        .describe("Visibility in label list"),
    },
    async (args) => {
      const result = await getOrCreateLabel(gmail, args.name, {
        messageListVisibility: args.messageListVisibility,
        labelListVisibility: args.labelListVisibility,
      });
      const action =
        result.type === "user" && result.name === args.name ? "found existing" : "created new";
      return text(
        `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
      );
    },
  );

  // ---- create_filter ---------------------------------------------------

  server.tool(
    "create_filter",
    "Creates a new Gmail filter with custom criteria and actions",
    {
      criteria: z
        .object({
          from: z.string().optional().describe("Sender email to match"),
          to: z.string().optional().describe("Recipient email to match"),
          subject: z.string().optional().describe("Subject text to match"),
          query: z.string().optional().describe("Gmail search query"),
          negatedQuery: z.string().optional().describe("Text that must NOT be present"),
          hasAttachment: z.boolean().optional().describe("Match emails with attachments"),
          excludeChats: z.boolean().optional().describe("Exclude chat messages"),
          size: z.number().optional().describe("Email size in bytes"),
          sizeComparison: z
            .enum(["unspecified", "smaller", "larger"])
            .optional()
            .describe("Size comparison"),
        })
        .describe("Criteria for matching emails"),
      action: z
        .object({
          addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
          removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
          forward: z.string().optional().describe("Email address to forward to"),
        })
        .describe("Actions to perform on matching emails"),
    },
    async ({ criteria, action }) => {
      const result = await createFilter(gmail, criteria, action);
      const criteriaText = Object.entries(criteria)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const actionText = Object.entries(action)
        .filter(([, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join(", ");
      return text(`Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`);
    },
  );

  // ---- list_filters ----------------------------------------------------

  server.tool("list_filters", "Retrieves all Gmail filters", {}, async () => {
    const result = await listFilters(gmail);
    if (result.filters.length === 0) return text("No filters found.");

    const filtersText = result.filters
      .map((f) => {
        const crit = Object.entries(f.criteria || {})
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        const act = Object.entries(f.action || {})
          .filter(([, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join(", ");
        return `ID: ${f.id}\nCriteria: ${crit}\nActions: ${act}\n`;
      })
      .join("\n");

    return text(`Found ${result.count} filters:\n\n${filtersText}`);
  });

  // ---- get_filter ------------------------------------------------------

  server.tool(
    "get_filter",
    "Gets details of a specific Gmail filter",
    { filterId: z.string().describe("ID of the filter to retrieve") },
    async ({ filterId }) => {
      const result = await getFilter(gmail, filterId);
      const crit = Object.entries(result.criteria || {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const act = Object.entries(result.action || {})
        .filter(([, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join(", ");
      return text(`Filter details:\nID: ${result.id}\nCriteria: ${crit}\nActions: ${act}`);
    },
  );

  // ---- delete_filter ---------------------------------------------------

  server.tool(
    "delete_filter",
    "Deletes a Gmail filter",
    { filterId: z.string().describe("ID of the filter to delete") },
    async ({ filterId }) => {
      const result = await deleteFilter(gmail, filterId);
      return text(result.message);
    },
  );

  // ---- create_filter_from_template -------------------------------------

  server.tool(
    "create_filter_from_template",
    "Creates a filter using a pre-defined template for common scenarios",
    {
      template: z
        .enum([
          "fromSender",
          "withSubject",
          "withAttachments",
          "largeEmails",
          "containingText",
          "mailingList",
        ])
        .describe("Pre-defined filter template to use"),
      parameters: z
        .object({
          senderEmail: z.string().optional().describe("Sender email (fromSender template)"),
          subjectText: z.string().optional().describe("Subject text (withSubject template)"),
          searchText: z.string().optional().describe("Search text (containingText template)"),
          listIdentifier: z.string().optional().describe("Mailing list ID (mailingList template)"),
          sizeInBytes: z.number().optional().describe("Size threshold (largeEmails template)"),
          labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
          archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
          markAsRead: z.boolean().optional().describe("Whether to mark as read"),
          markImportant: z.boolean().optional().describe("Whether to mark as important"),
        })
        .describe("Template-specific parameters"),
    },
    async ({ template, parameters: params }) => {
      let filterConfig: { criteria: any; action: any };

      switch (template) {
        case "fromSender":
          if (!params.senderEmail)
            throw new Error("senderEmail is required for fromSender template");
          filterConfig = filterTemplates.fromSender(params.senderEmail, params.labelIds, params.archive);
          break;
        case "withSubject":
          if (!params.subjectText)
            throw new Error("subjectText is required for withSubject template");
          filterConfig = filterTemplates.withSubject(params.subjectText, params.labelIds, params.markAsRead);
          break;
        case "withAttachments":
          filterConfig = filterTemplates.withAttachments(params.labelIds);
          break;
        case "largeEmails":
          if (!params.sizeInBytes)
            throw new Error("sizeInBytes is required for largeEmails template");
          filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
          break;
        case "containingText":
          if (!params.searchText)
            throw new Error("searchText is required for containingText template");
          filterConfig = filterTemplates.containingText(params.searchText, params.labelIds, params.markImportant);
          break;
        case "mailingList":
          if (!params.listIdentifier)
            throw new Error("listIdentifier is required for mailingList template");
          filterConfig = filterTemplates.mailingList(params.listIdentifier, params.labelIds, params.archive);
          break;
        default:
          throw new Error(`Unknown template: ${template}`);
      }

      const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);
      return text(`Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`);
    },
  );

  // ---- download_attachment ---------------------------------------------

  server.tool(
    "download_attachment",
    "Downloads an email attachment to a specified location",
    {
      messageId: z.string().describe("ID of the email message containing the attachment"),
      attachmentId: z.string().describe("ID of the attachment to download"),
      filename: z.string().optional().describe("Filename to save as (defaults to original)"),
      savePath: z.string().optional().describe("Directory to save to (defaults to cwd)"),
    },
    async ({ messageId, attachmentId, filename, savePath }) => {
      const attachmentResponse = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });

      if (!attachmentResponse.data.data) throw new Error("No attachment data received");

      const buffer = Buffer.from(attachmentResponse.data.data, "base64url");
      const dir = savePath || process.cwd();

      if (!filename) {
        // Look up original filename from the message
        const msgResponse = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });
        const find = (part: gmail_v1.Schema$MessagePart): string | null => {
          if (part.body?.attachmentId === attachmentId) {
            return part.filename || `attachment-${attachmentId}`;
          }
          if (part.parts) {
            for (const sub of part.parts) {
              const found = find(sub);
              if (found) return found;
            }
          }
          return null;
        };
        filename = find(msgResponse.data.payload!) || `attachment-${attachmentId}`;
      }

      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fullPath = path.join(dir, filename);
      fs.writeFileSync(fullPath, buffer);

      return text(
        `Attachment downloaded successfully:\nFile: ${filename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
      );
    },
  );

  // ---- Start transport -------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
