// Attachment storage (plan §2 Files row): private directory, random storage
// keys, never a path the web server executes or serves statically. Infected
// files go to a quarantine subdirectory that no download path ever reads.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function storageRoot(config: Config): string {
  return path.resolve(config.ATTACHMENT_DIR);
}

/** Two-level fanout from a random key: ab/cdef123... */
function pathForKey(config: Config, key: string, quarantined = false): string {
  return path.join(storageRoot(config), quarantined ? 'quarantine' : 'clean', key.slice(0, 2), key);
}

export async function saveAttachmentFile(
  config: Config,
  buffer: Buffer,
  opts: { quarantined: boolean },
): Promise<{ storageKey: string }> {
  const key = randomBytes(24).toString('hex');
  const target = pathForKey(config, key, opts.quarantined);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, buffer, { flag: 'wx' });
  return { storageKey: key };
}

export async function quarantineExisting(config: Config, storageKey: string): Promise<void> {
  const from = pathForKey(config, storageKey, false);
  const to = pathForKey(config, storageKey, true);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

/** Read stream for a CLEAN file only — there is deliberately no API to read
 * from the quarantine directory. */
export function openCleanFile(config: Config, storageKey: string): NodeJS.ReadableStream {
  if (!/^[0-9a-f]{48}$/.test(storageKey)) throw new Error('malformed storage key');
  return createReadStream(pathForKey(config, storageKey, false));
}
