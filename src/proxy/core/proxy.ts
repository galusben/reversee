// The proxy core: forwards one client request to the upstream destination and
// records a traffic entry. Direct TypeScript port of the original src/proxy.js
// with the logger injected so the module stays Electron-free and
// headless-testable.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { URL } from 'node:url';
import { buildCurl } from './curl';
import { interceptRequest, interceptResponse } from './interceptor';
import type {
  Logger,
  ProxySettings,
  RequestParams,
  RequestView,
  ResponseView,
  Timings,
  TrafficEntry,
} from '../../shared/types';

let trafficId = 0;

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function getServerProtocol(protocol: string): typeof http | typeof https {
  return protocol === 'https' ? https : http;
}

export function buildRequestParams(
  requestParams: RequestParams,
  userSettings: ProxySettings,
  clientReq: http.IncomingMessage
): void {
  requestParams.host = requestParams.host || userSettings.dest;
  requestParams.path = requestParams.path || clientReq.url;
  requestParams.method = requestParams.method || clientReq.method;
  requestParams.port = requestParams.port || userSettings.destPort;
  requestParams.headers = requestParams.headers || clientReq.headers;
  // Self-signed upstreams are the common dev use case, so verification is
  // opt-in, and scoped to this request rather than process-global.
  requestParams.rejectUnauthorized = userSettings.allowSelfSignedUpstream === false;
}

const decoders: Record<
  string,
  (buf: zlib.InputType, cb: (err: Error | null, result: Buffer) => void) => void
> = {
  gzip: zlib.gunzip,
  br: zlib.brotliDecompress,
  deflate: zlib.inflate,
};

export function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  userSettings: ProxySettings,
  notify: (entry: TrafficEntry) => void,
  requestParams: RequestParams,
  logger: Logger = noop
): void {
  // startAt is a local only — a bigint must not live on the timings object,
  // which gets recorded and JSON-serialized (e.g. for the MCP tools).
  const startAt = process.hrtime.bigint();
  const timings: Timings = { start: new Date() };

  logger.info('path hit:', clientReq.url);
  const responseView: ResponseView = {
    headers: {},
    body: Buffer.alloc(0),
  };
  buildRequestParams(requestParams, userSettings, clientReq);

  if (userSettings.requestInterceptor && userSettings.interceptRequest) {
    interceptRequest(requestParams, userSettings.requestInterceptor, logger);
  }

  const requestView: RequestView = {
    url: requestParams.path as string,
    headers: requestParams.headers ?? {},
    method: requestParams.method as string,
    body: Buffer.alloc(0),
    target: {
      protocol: userSettings.destProtocol,
      host: requestParams.host as string,
      port: requestParams.port as number,
    },
  };

  const trafficView: TrafficEntry = {
    trafficId: trafficId++,
    request: requestView,
    response: responseView,
    timings,
  };

  const originalHost = requestView.headers['host'];
  if (userSettings.hostRewrite) {
    requestView.headers['host'] = userSettings.dest + ':' + userSettings.destPort;
  }
  requestView.curl = buildCurl(userSettings.destProtocol, requestParams);

  const connector = getServerProtocol(userSettings.destProtocol).request(
    requestParams as http.RequestOptions,
    (serverResponse) => {
      const responseParams = {
        statusCode: serverResponse.statusCode,
        headers: Object.assign({}, serverResponse.headers) as Record<string, unknown>,
        body: Buffer.alloc(0) as Buffer | string,
      };

      serverResponse.once('readable', () => {
        timings.firstByte = Number(process.hrtime.bigint() - startAt);
      });
      serverResponse.on('data', (chunk: Buffer) => {
        responseParams.body = Buffer.concat([responseParams.body as Buffer, chunk]);
      });
      serverResponse.on('end', () => {
        timings.total = Number(process.hrtime.bigint() - startAt);
        if (userSettings.responseInterceptor && userSettings.interceptResponse) {
          interceptResponse(
            responseParams,
            userSettings.responseInterceptor,
            requestParams,
            logger
          );
          // The interceptor may have replaced the body; a stale
          // content-length makes keep-alive clients hang or truncate.
          if (responseParams.headers['content-length'] !== undefined) {
            responseParams.headers['content-length'] = Buffer.byteLength(
              responseParams.body as string | Buffer
            );
          }
        }

        clientRes.statusCode = responseParams.statusCode ?? 200;
        responseView.statusCode = responseParams.statusCode;

        for (const key of Object.keys(responseParams.headers)) {
          const value = responseParams.headers[key] as string | string[];
          clientRes.setHeader(key, value);
          (responseView.headers as Record<string, unknown>)[key] = value;
        }

        if (userSettings.redirect && String(serverResponse.statusCode).startsWith('30')) {
          const location = serverResponse.headers['location'];
          logger.info('handling redirect, location:', location);
          if (location) {
            try {
              const url = new URL(location);
              url.host = (originalHost as string) || url.host;
              url.protocol = userSettings.listenProtocol;
              clientRes.setHeader('location', url.href);
              responseView.headers['location'] = url.href;
            } catch (e) {
              logger.info(e);
            }
          }
        }

        // Decompression is for the traffic view only; the wire body is
        // always passed through unmodified.
        const finish = (): void => {
          clientRes.write(responseParams.body);
          clientRes.end();
          notify(trafficView);
        };
        const decode = decoders[String(responseView.headers['content-encoding'])];
        if (decode) {
          decode(responseParams.body as Buffer, (err, decoded) => {
            if (err) {
              logger.info(err);
              responseView.body = responseParams.body as Buffer;
              responseView.decodeError = err.message;
            } else {
              responseView.body = decoded;
            }
            finish();
          });
        } else {
          responseView.body = responseParams.body;
          finish();
        }
      });
    }
  );

  connector.on('socket', (socket) => {
    socket.on('lookup', () => {
      timings.dnsLookup = Number(process.hrtime.bigint() - startAt);
    });
    socket.on('connect', () => {
      timings.tcpConnection = Number(process.hrtime.bigint() - startAt);
    });
    socket.on('secureConnect', () => {
      timings.tlsHandshake = Number(process.hrtime.bigint() - startAt);
    });
  });

  connector.on('error', (err) => {
    logger.info(err);
    clientRes.statusCode = 502;
    responseView.statusCode = 502;
    trafficView.connectorError = err;
    notify(trafficView);
    clientRes.end();
  });

  if (requestParams.body) {
    connector.write(requestParams.body);
  }
  connector.end();
  requestView.body = requestParams.body;
}
