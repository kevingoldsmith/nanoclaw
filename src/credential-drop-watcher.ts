import os from 'os';
import path from 'path';

export interface DropTarget {
  target: string;
  label: string;
}

const HOME = os.homedir();

const MAPPING: Record<string, DropTarget> = {
  'tokens-account3-drive.json.age': {
    target: path.join(HOME, '.config', 'google-drive-mcp-account3', 'tokens.json'),
    label: 'account3 drive',
  },
  'tokens-account3-calendar.json.age': {
    target: path.join(HOME, '.config', 'google-calendar-mcp-account3', 'tokens.json'),
    label: 'account3 calendar',
  },
};

export function lookupTarget(filename: string): DropTarget | null {
  return MAPPING[filename] ?? null;
}
