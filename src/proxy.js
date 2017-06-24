const http = require('http');
const https = require('https');
const zlib = require("zlib");
const path = require('path');
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
    requestView.headers.host = userSettings.dest + ":" + userSettings.destPort;
    console.log('setting connector ');

    var connector = getServerProtocol(userSettings.destProtocol).request(requestParams, (serverResponse) => {
        console.log('server response');
        requestView.curl = connector.toCurl();
        var responseParams = {
            statusCode: serverResponse.statusCode,
            headers: Object.assign({}, serverResponse.headers)
        };

        if (userSettings.responseInterceptor && userSettings.responseInterceptor.length > 0) {
            interceptor.interceptResponse(responseParams, userSettings.responseInterceptor);
        }
        for (var key in responseParams.headers) {
            clientRes.setHeader(key, responseParams.headers[key]);
            responseView.headers[key] = responseParams.headers[key];
        }

        clientRes.statusCode = responseParams.statusCode;
        responseView.statusCode = responseParams.statusCode;
        console.log('status set')
        serverResponse.on('data', (chunk) => {
            clientRes.write(chunk);
            responseView.body = Buffer.concat([responseView.body, chunk]);
            win.webContents.send('trip-data', trafficView);
        });
        serverResponse.on('end', () => {
            if (responseView.headers['content-encoding'] == 'gzip') {
                zlib.gunzip(responseView.body, function (err, dezipped) {
                    if (err) {
                        console.log(err)
                    }
                    responseView.body = dezipped.toString();
                    win.webContents.send('trip-data', trafficView)
                });
            } else {
                win.webContents.send('trip-data', trafficView);
            }
            clientRes.end()
        })
    });
    if (requestParams.body) {
        connector.write(requestParams.body);
    }
    connector.end();
    requestView.body = requestParams.body
}

exports.handleRequest = handleRequest;