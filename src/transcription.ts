import OpenAI from 'openai';
import fs from 'fs';
import { logger } from './logger.js';

export async function transcribeAudioBuffer(
  buffer: Buffer,
  mimetype: string,
  filename?: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.debug('OPENAI_API_KEY not set, skipping transcription');
    return null;
  }

  // Write buffer to temp file for OpenAI API
  const ext = mimetype.includes('ogg')
    ? '.ogg'
    : mimetype.includes('mp4')
      ? '.m4a'
      : '.wav';
  const tempPath = `/tmp/transcribe-${Date.now()}${ext}`;
  fs.writeFileSync(tempPath, buffer);

  try {
    const openai = new OpenAI({ apiKey });
    const file = fs.createReadStream(tempPath);

    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });

    logger.info(
      { filename, length: transcription.text.length },
      'Transcribed audio',
    );
    return transcription.text;
  } catch (err) {
    logger.warn({ err, filename }, 'Transcription failed');
    return null;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }
}
