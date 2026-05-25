import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export interface SavedMedia {
  filePath: string;
  contentLine: string;
}

export function saveMediaToGroup(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  groupFolder: string,
): SavedMedia {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`,
    );
  }

  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uploadsDir = path.join(GROUPS_DIR, groupFolder, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const storedName = `${Date.now()}-${sanitized}`;
  const filePath = path.join(uploadsDir, storedName);
  const relativePath = `uploads/${storedName}`;
  fs.writeFileSync(filePath, buffer);
  logger.info(
    { groupFolder, filename: sanitized, size: buffer.length },
    'Saved media file',
  );

  const contentLine = `[File: ${sanitized} (${mimetype}, ${Math.round(buffer.length / 1024)}KB) saved to ${relativePath}]`;
  return { filePath, contentLine };
}
