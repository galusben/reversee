const http = require('http');
const https = require('https');
const zlib = require("zlib");
const path = require('path');
const {URL} = require('url');

const interceptor = require(path.join(__dirname, 'interceptor.js'));
let trafficId = 0;

function getServerProtocol(protocol) {
    return (protocol == 'https') ? https : http
}

function buildRequestParams(requestParams, userSettings, clientReq) {
    requestParams.host = requestParams.host || userSettings.dest;
    requestParams.path = requestParams.path || clientReq.url;
    requestParams.method = requestParams.method || clientReq.method;
    requestParams.port = requestParams.port || userSettings.destPort;
    requestParams.headers = requestParams.headers || clientReq.headers;
}

function handleRequest(clientReq, clientRes, userSettings, win, requestParams) {
    console.log('Path Hit: ' + clientReq.url);
    var responseView = {
        headers: {},
        body: Buffer.alloc(0)
    };
    buildRequestParams(requestParams, userSettings, clientReq);

    if (userSettings.requestInterceptor && userSettings.requestInterceptor.length > 0) {
        interceptor.interceptRequest(requestParams, userSettings.requestInterceptor);
    }

    var requestView = {
        url: requestParams.path,
        headers: requestParams.headers,
        method: requestParams.method,
        body: Buffer.alloc(0)
    };

    var trafficView = {
        trafficId: trafficId++,
        request: requestView,
        response: responseView
    };

    const originalHost = requestView.headers.host;
    console.log('originalHost: ' + originalHost);
    requestView.headers.host = userSettings.dest + ":" + userSettings.destPort;

    var connector = getServerProtocol(userSettings.destProtocol).request(requestParams, (serverResponse) => {
        requestView.curl = connector.toCurl();
        var responseParams = {
            statusCode: serverResponse.statusCode,
            headers: Object.assign({}, serverResponse.headers),
            body: Buffer.alloc(0)
        };


        console.log('status set');
        serverResponse.on('data', (chunk) => {
            responseParams.body = Buffer.concat([responseParams.body, chunk]);
        });
        serverResponse.on('end', () => {
            if (userSettings.responseInterceptor && userSettings.responseInterceptor.length > 0) {
                interceptor.interceptResponse(responseParams, userSettings.responseInterceptor, requestParams);
            }

            clientRes.statusCode = responseParams.statusCode;
            responseView.statusCode = responseParams.statusCode;

            for (let key in responseParams.headers) {
                clientRes.setHeader(key, responseParams.headers[key]);
                responseView.headers[key] = responseParams.headers[key];
            }

            console.log('redirect :' + userSettings.redirect);
            if (userSettings.redirect && serverResponse.statusCode.toString().startsWith('30')) {
                let location = serverResponse.headers['location'];
                console.log('handling redirects, location:' + location);
                if (location) {
                    try {
                        let url = new URL(location);
                        console.log('originalHost: ' + originalHost);
                        url.host = originalHost || url.host;
                        url.protocol = userSettings.listenProtocol;
                        clientRes.setHeader('location', url.href);
                        responseView.headers['location'] = url.href;
                    } catch (e) {
                        console.log(e);
                    }
                }
            }

            if (responseView.headers['content-encoding'] === 'gzip') {
                zlib.gunzip(responseParams.body, function (err, dezipped) {
                    if (err) {
                        console.log(err)
                    }
                    responseView.body = dezipped && dezipped.toString();
                    clientRes.write(responseParams.body);
                    clientRes.end();
                    win.webContents.send('trip-data', trafficView)
                });
            } else {
                responseView.body = responseParams.body;
                clientRes.write(responseParams.body);
                clientRes.end();
                win.webContents.send('trip-data', trafficView);
            }
        })
    });
    connector.on('error', function (err) {
        console.log(err);
        clientRes.statusCode = 502;
        responseView.statusCode = 502;
        trafficView.connectorError = err;
        win.webContents.send('trip-data', trafficView);
        clientRes.end();
    });
    if (requestParams.body) {
        connector.write(requestParams.body);
    }
    connector.end();
    requestView.body = requestParams.body
}

exports.handleRequest = handleRequest;