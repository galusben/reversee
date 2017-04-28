const http = require('http');
const https = require('https');
const zlib = require("zlib");
const path = require('path');
const interceptor = require(path.join(__dirname, 'interceptor.js'));

function getServerProtocol(protocol) {
    return (protocol == 'https') ? https : http
}

function handleRequest(clientReq, clientRes, userSettings, win) {
    console.log('Path Hit: ' + clientReq.url);
    var responseView = {
        headers: {},
        body: ''
    };
    var requestParams = {
        host: userSettings.dest,
        path: clientReq.url,
        method: clientReq.method,
        port: userSettings.destPort,
        headers: clientReq.headers
    };

    if(userSettings.requestInterceptor && userSettings.requestInterceptor.length > 0) {
        interceptor.interceptRequest(requestParams, userSettings.requestInterceptor);
    }

    var requestView = {
        url: requestParams.path,
        headers: requestParams.headers,
        method: requestParams.method,
        body: ''
    };
    requestView.headers.host = userSettings.dest + ":" + userSettings.destPort;

    var connector = getServerProtocol(userSettings.destProtocol).request(requestParams, (serverResponse) => {
        requestView.curl = connector.toCurl();
        var responseParams = {
            statusCode : serverResponse.statusCode,
            headers : Object.assign({}, serverResponse.headers)
        };

        if(userSettings.responseInterceptor && userSettings.responseInterceptor.length > 0) {
            interceptor.interceptResponse(responseParams, userSettings.responseInterceptor);
        }
        for (var key in responseParams.headers) {
            clientRes.setHeader(key, responseParams.headers[key]);
            responseView.headers[key] = responseParams.headers[key];
        }

        clientRes.statusCode = responseParams.statusCode;
        responseView.statusCode = responseParams.statusCode;
        serverResponse.on('data', (chunk) => {
            if(responseView.body) {
                responseView.body = Buffer.concat([responseView.body, chunk])
            }
            else {
                responseView.body = chunk
            }
            clientRes.write(chunk)
        });
        serverResponse.on('end', () => {
            if(responseView.headers['content-encoding'] == 'gzip') {
                zlib.gunzip(responseView.body, function (err, dezipped) {
                    if(err) {
                        console.log(err)
                    }
                    responseView.body = dezipped.toString();
                    win.webContents.send('trip-data', {request: requestView, response: responseView})
                });
            } else {
                win.webContents.send('trip-data', {request: requestView, response: responseView});
            }
            clientRes.end()
        })
    });

    clientReq.on('data', (chunk) => {
        connector.write(chunk);
        requestView.body = requestView.body + chunk;
    });
    clientReq.on('end', () => {
        connector.end()
    });
}

exports.handleRequest = handleRequest;