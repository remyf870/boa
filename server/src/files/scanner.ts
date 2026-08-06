// A.8.7: every uploaded file is virus-scanned BEFORE it is retrievable.
// Scanning is synchronous at upload time: an upload is only accepted once its
// verdict is known, so there is no window where an unscanned file exists.
//
//   SCANNER_MODE=clamd — ClamAV daemon over TCP (INSTREAM protocol). Required
//                        in production (config.ts refuses to start otherwise).
//   SCANNER_MODE=stub  — dev/test only: flags the EICAR test signature so the
//                        quarantine path (and its acceptance test) stays real
//                        without a ClamAV install.
import net from 'node:net';
import type { Config } from '../config.js';

export type ScanVerdict = { status: 'clean' } | { status: 'infected'; signature: string };

const EICAR_SIGNATURE = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';

export async function scanBuffer(config: Config, buffer: Buffer): Promise<ScanVerdict> {
  if (config.SCANNER_MODE === 'stub') {
    return buffer.toString('latin1').includes(EICAR_SIGNATURE)
      ? { status: 'infected', signature: 'Eicar-Test-Signature (stub scanner)' }
      : { status: 'clean' };
  }
  return clamdScan(config.CLAMD_HOST!, config.CLAMD_PORT, buffer);
}

/** ClamAV INSTREAM: zINSTREAM\0 then length-prefixed chunks, zero-length ends. */
function clamdScan(host: string, port: number, buffer: Buffer): Promise<ScanVerdict> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let response = '';
    const fail = (err: Error) => {
      socket.destroy();
      // A scanner outage must NEVER let a file through unscanned — the upload fails.
      reject(new Error(`virus scan unavailable: ${err.message}`));
    };
    socket.setTimeout(30_000, () => fail(new Error('clamd timeout')));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const size = Buffer.alloc(4);
      size.writeUInt32BE(buffer.length);
      socket.write(size);
      socket.write(buffer);
      socket.write(Buffer.from([0, 0, 0, 0]));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    socket.on('close', () => {
      const text = response.replace(/\0/g, '').trim();
      if (text.endsWith('OK')) return resolve({ status: 'clean' });
      const match = /:\s*(.+)\s+FOUND$/.exec(text);
      if (match) return resolve({ status: 'infected', signature: match[1]! });
      reject(new Error(`virus scan unavailable: unexpected clamd response "${text}"`));
    });
  });
}
