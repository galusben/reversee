// ndjson client for the Reversee control socket (see
// src/main/mcp/control-server.ts in the app for the protocol and the
// security model). One connection per call: the bridge stays stateless and
// survives app restarts.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export class ReverseeNotRunningError extends Error {
  constructor() {
    super(
      'Reversee is not running (or MCP integration is disabled). ' +
        'Launch the Reversee app and make sure "Enable MCP Integration" is checked ' +
        'in the Proxy Settings menu, then try again.'
    );
    this.name = 'ReverseeNotRunningError';
  }
}

export interface ControlError {
  code?: string;
  message: string;
}

export class ControlCallError extends Error {
  constructor(public detail: ControlError) {
    super(detail.message);
    this.name = 'ControlCallError';
  }
}

export function defaultUserDataDir(): string {
  if (process.env['REVERSEE_USER_DATA']) return process.env['REVERSEE_USER_DATA'];
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Reversee');
    case 'win32':
      return path.join(process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'Reversee');
    default:
      return path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config'), 'Reversee');
  }
}

export function socketPathFor(dir: string): string {
  if (process.platform === 'win32') {
    const suffix = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\reversee-mcp-${suffix}`;
  }
  return path.join(dir, 'mcp.sock');
}

export class ReverseeClient {
  constructor(private dir: string = defaultUserDataDir()) {}

  async call(method: string, params?: unknown): Promise<unknown> {
    let token: string;
    try {
      token = fs.readFileSync(path.join(this.dir, 'mcp-token'), 'utf8');
    } catch {
      throw new ReverseeNotRunningError();
    }

    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPathFor(this.dir));
      let buffer = '';
      let sawHello = false;
      const fail = (error: Error): void => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new ReverseeNotRunningError());
        } else {
          reject(err);
        }
      });

      socket.once('connect', () => {
        socket.write(JSON.stringify({ token }) + '\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            fail(new Error('invalid response from Reversee'));
            return;
          }
          if (!sawHello) {
            if (message['ok']) {
              sawHello = true;
              socket.write(JSON.stringify({ id: 1, method, params }) + '\n');
            } else {
              fail(new ControlCallError((message['error'] as ControlError) ?? { message: 'handshake rejected' }));
            }
            continue;
          }
          if (message['error']) {
            fail(new ControlCallError(message['error'] as ControlError));
          } else {
            socket.destroy();
            resolve(message['result']);
          }
          return;
        }
      });
    });
  }
}
