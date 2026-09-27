// Request replay (src/main/replay.ts) against real fixture upstreams: the
// agent-facing "resend with edits" path behind the replay_request MCP tool.
import { describe, it, expect, afterEach } from 'vitest';
import zlib from 'node:zlib';
import { replayRequest } from '../../src/main/replay';
import { startUpstream, closeAll } from './helpers.mjs';

let upstream;
afterEach(async () => {
  await closeAll(upstream?.server);
  upstream = undefined;
});

function recordingUpstream(respond, opts) {
  const seen = [];
  return startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      respond(req, res);
    });
  }, opts).then((u) => ({ ...u, seen }));
}

const source = (port, extra = {}) => ({
  target: { protocol: 'http', host: '127.0.0.1', port },
  method: 'POST',
  url: '/orig?q=1',
  headers: { 'content-type': 'text/plain', 'x-keep': 'k', 'x-drop': 'd' },
  body: Buffer.from('original body'),
  ...extra,
});

describe('replayRequest', () => {
  it('resends the original request unchanged', async () => {
    upstream = await recordingUpstream((_req, res) => res.end('ok'));
    const entry = await replayRequest(source(upstream.port), {}, false);

    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]).toMatchObject({
      method: 'POST',
      url: '/orig?q=1',
      body: 'original body',
    });
    expect(upstream.seen[0].headers['x-keep']).toBe('k');
    expect(entry.replay).toBe(true);
    expect(entry.response.statusCode).toBe(200);
    expect(Buffer.from(entry.response.body).toString()).toBe('ok');
    expect(entry.request.curl).toContain('/orig?q=1');
    expect(entry.timings.total).toBeGreaterThan(0);
  });

  it('applies method, url, header (set and delete), and body overrides', async () => {
    upstream = await recordingUpstream((_req, res) => res.end('ok'));
    const entry = await replayRequest(
      source(upstream.port),
      {
        method: 'PUT',
        url: '/edited',
        headers: { 'x-new': 'n', 'x-drop': null },
        body: 'edited body',
      },
      false
    );

    const seen = upstream.seen[0];
    expect(seen).toMatchObject({ method: 'PUT', url: '/edited', body: 'edited body' });
    expect(seen.headers['x-new']).toBe('n');
    expect(seen.headers['x-keep']).toBe('k');
    expect(seen.headers).not.toHaveProperty('x-drop');
    expect(entry.request).toMatchObject({ method: 'PUT', url: '/edited' });
    expect(entry.request.headers).not.toHaveProperty('x-drop');
  });

  it('decodes gzip and brotli response bodies for display', async () => {
    for (const [encoding, compress] of [
      ['gzip', zlib.gzipSync],
      ['br', zlib.brotliCompressSync],
      ['deflate', zlib.deflateSync],
    ]) {
      upstream = await recordingUpstream((_req, res) => {
        res.writeHead(200, { 'content-encoding': encoding });
        res.end(compress(Buffer.from(`hello ${encoding}`)));
      });
      const entry = await replayRequest(source(upstream.port), {}, false);
      expect(Buffer.from(entry.response.body).toString()).toBe(`hello ${encoding}`);
      await closeAll(upstream.server);
    }
    upstream = undefined;
  });

  it('keeps raw bytes when the declared encoding is wrong', async () => {
    upstream = await recordingUpstream((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('not actually gzip');
    });
    const entry = await replayRequest(source(upstream.port), {}, false);
    expect(Buffer.from(entry.response.body).toString()).toBe('not actually gzip');
  });

  it('reports a 502 with the connector error when the upstream is down', async () => {
    upstream = await recordingUpstream((_req, res) => res.end());
    const { port } = upstream;
    await closeAll(upstream.server);
    upstream = undefined;

    const entry = await replayRequest(source(port), {}, false);
    expect(entry.response.statusCode).toBe(502);
    expect(entry.connectorError).toBeInstanceOf(Error);
  });

  it('honours rejectUnauthorized for self-signed https upstreams', async () => {
    upstream = await recordingUpstream((_req, res) => res.end('tls ok'), { tls: true });
    const tlsSource = source(upstream.port, {
      target: { protocol: 'https', host: '127.0.0.1', port: upstream.port },
    });

    const allowed = await replayRequest(tlsSource, {}, false);
    expect(Buffer.from(allowed.response.body).toString()).toBe('tls ok');

    const rejected = await replayRequest(tlsSource, {}, true);
    expect(rejected.response.statusCode).toBe(502);
    expect(rejected.connectorError).toBeTruthy();
  });
});
