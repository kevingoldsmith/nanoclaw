import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

export interface EmailArgs {
  to: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  mimeType?: "text/plain" | "text/html" | "multipart/alternative";
  cc?: string[];
  bcc?: string[];
  threadId?: string;
  inReplyTo?: string;
  attachments?: string[];
}

/** RFC 2047 MIME-encode a header value if it contains non-ASCII characters. */
function encodeEmailHeader(text: string): string {
  if (/[^\x00-\x7F]/.test(text)) {
    return "=?UTF-8?B?" + Buffer.from(text).toString("base64") + "?=";
  }
  return text;
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Build a simple RFC 822 message string (no attachments).
 * For messages with attachments use createEmailWithNodemailer instead.
 */
export function createEmailMessage(args: EmailArgs): string {
  const encodedSubject = encodeEmailHeader(args.subject);

  let mimeType: string = args.mimeType || "text/plain";
  if (args.htmlBody && mimeType !== "text/plain") {
    mimeType = "multipart/alternative";
  }

  const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

  for (const email of args.to) {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  }

  const emailParts: string[] = [
    "From: me",
    `To: ${args.to.join(", ")}`,
    args.cc ? `Cc: ${args.cc.join(", ")}` : "",
    args.bcc ? `Bcc: ${args.bcc.join(", ")}` : "",
    `Subject: ${encodedSubject}`,
    args.inReplyTo ? `In-Reply-To: ${args.inReplyTo}` : "",
    args.inReplyTo ? `References: ${args.inReplyTo}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  if (mimeType === "multipart/alternative") {
    emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    emailParts.push("");
    emailParts.push(`--${boundary}`);
    emailParts.push("Content-Type: text/plain; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(args.body);
    emailParts.push("");
    emailParts.push(`--${boundary}`);
    emailParts.push("Content-Type: text/html; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(args.htmlBody || args.body);
    emailParts.push("");
    emailParts.push(`--${boundary}--`);
  } else if (mimeType === "text/html") {
    emailParts.push("Content-Type: text/html; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(args.htmlBody || args.body);
  } else {
    emailParts.push("Content-Type: text/plain; charset=UTF-8");
    emailParts.push("Content-Transfer-Encoding: 7bit");
    emailParts.push("");
    emailParts.push(args.body);
  }

  return emailParts.join("\r\n");
}

/**
 * Build an RFC 822 message with attachments using nodemailer.
 * Returns the raw message string ready for base64 encoding.
 */
export async function createEmailWithNodemailer(args: EmailArgs): Promise<string> {
  for (const email of args.to) {
    if (!validateEmail(email)) {
      throw new Error(`Recipient email address is invalid: ${email}`);
    }
  }

  const transporter = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
    buffer: true,
  });

  const attachments: { filename: string; path: string }[] = [];
  for (const filePath of args.attachments || []) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }
    attachments.push({
      filename: path.basename(filePath),
      path: filePath,
    });
  }

  const info = await transporter.sendMail({
    from: "me",
    to: args.to.join(", "),
    cc: args.cc?.join(", "),
    bcc: args.bcc?.join(", "),
    subject: args.subject,
    text: args.body,
    html: args.htmlBody,
    attachments,
    inReplyTo: args.inReplyTo,
    references: args.inReplyTo,
  });

  return info.message.toString();
}
