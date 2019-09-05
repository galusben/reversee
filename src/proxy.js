const http = require('http');
const https = require('https');
const zlib = require("zlib");
const path = require('path');
const {URL} = require('url');
require('request-to-curl');
const logger = require("electron-log");
const process = require('process');


const interceptor = require(path.join(__dirname, 'interceptor.js'));
let trafficId = 0;

function getServerProtocol(protocol) {
    return (protocol === 'https') ? https : http
}

function buildRequestParams(requestParams, userSettings, clientReq) {
    requestParams.host = requestParams.host || userSettings.dest;
    requestParams.path = requestParams.path || clientReq.url;
    requestParams.method = requestParams.method || clientReq.method;
    requestParams.port = requestParams.port || userSettings.destPort;
    requestParams.headers = requestParams.headers || clientReq.headers;
}

function handleRequest(clientReq, clientRes, userSettings, notify, requestParams) {
    const timings = {
        start: new Date(),
        startAt: process.hrtime.bigint(),
    };

    logger.info('Path Hit: ' + clientReq.url);
    let responseView = {
        headers: {},
        body: Buffer.alloc(0)
    };
    buildRequestParams(requestParams, userSettings, clientReq);

    if (userSettings.requestInterceptor && userSettings.interceptRequest) {
        interceptor.interceptRequest(requestParams, userSettings.requestInterceptor);
    }

    let requestView = {
        url: requestParams.path,
        headers: requestParams.headers,
        method: requestParams.method,
        body: Buffer.alloc(0)
    };

    let trafficView = {
        trafficId: trafficId++,
        request: requestView,
        response: responseView,
        timings: timings
    };

    const originalHost = requestView.headers.host;
    logger.info('originalHost: ' + originalHost);
    if (userSettings.hostRewrite) {
        requestView.headers.host = userSettings.dest + ":" + userSettings.destPort;
    }

    let connector = getServerProtocol(userSettings.destProtocol).request(requestParams, (serverResponse) => {
        requestView.curl = connector.toCurl();
        let responseParams = {
            statusCode: serverResponse.statusCode,
            headers: Object.assign({}, serverResponse.headers),
            body: Buffer.alloc(0)
        };

        serverResponse.once('readable', () => {
            timings.firstByte = parseInt(process.hrtime.bigint() - timings.startAt);
        });
        logger.info('status set');
        serverResponse.on('data', (chunk) => {
            responseParams.body = Buffer.concat([responseParams.body, chunk]);
        });
        serverResponse.on('end', () => {
            timings.total = parseInt(process.hrtime.bigint() - timings.startAt);
            let start = new Date().getTime();
            if (userSettings.responseInterceptor && userSettings.interceptResponse) {
                interceptor.interceptResponse(responseParams, userSettings.responseInterceptor, requestParams);
            }

            clientRes.statusCode = responseParams.statusCode;
            responseView.statusCode = responseParams.statusCode;

            for (let key in responseParams.headers) {
                clientRes.setHeader(key, responseParams.headers[key]);
                responseView.headers[key] = responseParams.headers[key];
            }

            logger.info('redirect :' + userSettings.redirect);
            if (userSettings.redirect && serverResponse.statusCode.toString().startsWith('30')) {
                let location = serverResponse.headers['location'];
                logger.info('handling redirects, location:' + location);
                if (location) {
                    try {
                        let url = new URL(location);
                        logger.info('originalHost: ' + originalHost);
                        url.host = originalHost || url.host;
                        url.protocol = userSettings.listenProtocol;
                        clientRes.setHeader('location', url.href);
                        responseView.headers['location'] = url.href;
                    } catch (e) {
                        logger.info(e);
                    }
                }
            }

            if (responseView.headers['content-encoding'] === 'gzip') {
                zlib.gunzip(responseParams.body, function (err, dezipped) {
                    if (err) {
                        logger.info(err)
                    }
                    responseView.body = dezipped && dezipped.toString();
                    clientRes.write(responseParams.body);
                    clientRes.end();
                    notify(trafficView)
                });
            } else {
                responseView.body = responseParams.body;
                clientRes.write(responseParams.body);
                clientRes.end();
                notify(trafficView)
            }
        })
    });
    connector.on('socket', (socket) => {
        socket.on('lookup', () => {
            timings.dnsLookup = parseInt(process.hrtime.bigint() - timings.startAt)
        });
        socket.on('connect', () => {
            timings.tcpConnection = parseInt(process.hrtime.bigint()  - timings.startAt)
        });
        socket.on('secureConnect', () => {
            timings.tlsHandshake = parseInt(process.hrtime.bigint()  - timings.startAt)
        })
    });

    connector.on('error', function (err) {
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
    requestView.body = requestParams.body
}

exports.handleRequest = handleRequest;