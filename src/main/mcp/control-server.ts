// Local control socket for the MCP bridge (and nothing else). Security model:
// - No TCP port: a localhost HTTP port would be reachable by any local
//   process AND by browsers (DNS-rebinding / drive-by fetch) — a real attack
//   class for a tool that proxies traffic and runs user JS. A filesystem
//   socket is not web-reachable.
// - Unix domain socket (mode 0600) on macOS/Linux; named pipe on Windows.
// - Random per-boot token (file mode 0600) must be presented in the first
//   frame; mandatory because Windows named-pipe ACLs have no mode bits.
// - Mutating methods are rejected unless the user enabled control in the app.
//
// This module is Electron-free so it can be unit-tested headlessly.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../../shared/types';

export const PROTOCOL_VERSION = 1;

export interface ControlRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export type ControlHandler = (params: unknown) => Promise<unknown> | unknown;

export interface ControlServerOptions {
  /** Directory for the socket and token files (the app passes userData). */
  dir: string;
  handlers: Record<string, ControlHandler>;
  /** Methods rejected unless isControlAllowed() returns true. */
  mutatingMethods: ReadonlySet<string>;
  isControlAllowed(): boolean;
  appVersion: string;
  logger?: Logger;
}

export interface ControlServer {
  socketPath: string;
  tokenPath: string;
  close(): Promise<void>;
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function socketPathFor(dir: string): string {
  if (process.platform === 'win32') {
    const suffix = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\reversee-mcp-${suffix}`;
  }
  return path.join(dir, 'mcp.sock');
}

export function tokenPathFor(dir: string): string {
  return path.join(dir, 'mcp-token');
}

function tokensMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const logger = options.logger ?? noop;
  const socketPath = socketPathFor(options.dir);
  const tokenPath = tokenPathFor(options.dir);

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });

  // Remove a stale socket from a previous crash (unix only).
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((socket) => {
    let authenticated = false;
    let buffer = '';

    const send = (message: unknown): void => {
      socket.write(JSON.stringify(message) + '\n');
    };

    socket.on('error', (err) => logger.debug('mcp socket error', err));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        void handleLine(line);
      }
    });

    async function handleLine(line: string): Promise<void> {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        send({ error: { code: 'bad-json', message: 'invalid JSON' } });
        socket.destroy();
        return;
      }

      if (!authenticated) {
        if (tokensMatch(message['token'], token)) {
          authenticated = true;
          send({ ok: true, server: 'reversee', protocol: PROTOCOL_VERSION, version: options.appVersion });
        } else {
          logger.warn('mcp control: handshake with bad token rejected');
          send({ ok: false, error: { code: 'bad-token', message: 'invalid token' } });
          socket.destroy();
        }
        return;
      }

      const { id, method, params } = message as Partial<ControlRequest>;
      if (id === undefined || typeof method !== 'string') {
        send({ error: { code: 'bad-request', message: 'expected {id, method, params?}' } });
        return;
      }
      const handler = options.handlers[method];
      if (!handler) {
        send({ id, error: { code: 'unknown-method', message: `unknown method ${method}` } });
        return;
      }
      if (options.mutatingMethods.has(method) && !options.isControlAllowed()) {
        send({
          id,
          error: {
            code: 'control-disabled',
            message:
              'MCP control is disabled. Enable "Allow MCP to control the proxy" in Reversee (Proxy Settings menu) to use this tool.',
          },
        });
        return;
      }
      try {
        const result = await handler(params);
        send({ id, result: result ?? null });
      } catch (error) {
        send({ id, error: { code: 'handler-error', message: (error as Error).message } });
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (process.platform !== 'win32') {
        fs.chmodSync(socketPath, 0o600);
      }
      logger.info(`mcp control socket listening at ${socketPath}`);
      resolve({
        socketPath,
        tokenPath,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => {
              try {
                if (process.platform !== 'win32') fs.unlinkSync(socketPath);
                fs.unlinkSync(tokenPath);
              } catch {
                // best-effort cleanup
              }
              r();
            });
          }),
      });
    });
  });
}
