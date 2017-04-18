const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const zlib = require("zlib");
const util = require('util');
const vm = require('vm');



process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const sslOptions = {
    key:  fs.readFileSync(path.join(__dirname,'..','resources','localhost.key')),
    cert: fs.readFileSync(path.join(__dirname,'..','resources','localhost.cert'))
};

var userSettings;
let win;
var server;


function createWindow() {
    win = new BrowserWindow({width: 950, height: 600});
    win.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

    // win.webContents.openDevTools()

    win.on('closed', () => {
        win = null
    });
    require(path.join(__dirname, 'menu.js'));
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
        app.quit()
});

app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
});

function getServerProtocol(protocol) {
    return (protocol == 'https') ? https : http
}

function interceptRequest(requestParams) {
    var sandbox = {
        requestParams: requestParams
    };

    console.log('request-interceptor :' + userSettings.requestInterceptor)
    var script = new vm.Script(userSettings.requestInterceptor);
    var context = new vm.createContext(sandbox);
    script.runInContext(context);
    console.log('after interception' + JSON.stringify(sandbox.requestParams));
}
function handleRequest(clientReq, clientRes) {
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
        interceptRequest(requestParams);
    }

    var requestView = {
        url: requestParams.path,
        headers: requestParams.headers,
        method: requestParams.method,
        body: ''
    };

    var connector = getServerProtocol(userSettings.destProtocol).request(requestParams, (serverResponse) => {
        for (var key in serverResponse.headers) {
            clientRes.setHeader(key, serverResponse.headers[key]);
            responseView.headers[key] = serverResponse.headers[key];
        }
        clientRes.statusCode = serverResponse.statusCode;
        responseView.statusCode = serverResponse.statusCode;
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

function startProxy(settings) {
    console.log("starting proxy to: " + settings.dest);
    userSettings = settings;
    if (userSettings.listenProtocol == 'http') {
        server = http.createServer(handleRequest);
    } else {
        server =https.createServer(sslOptions, handleRequest);
    }
    server.on('error', (err) => {
        win.webContents.send( 'server-error', {message: 'could not start server'} );
    });
    server.listen(userSettings.listenPort, function () {
        console.log("Server listening on: %s://localhost:%s", userSettings.listenProtocol, userSettings.listenPort);
    });

}

ipcMain.on('message-settings', (event, settings) => {
    startProxy(settings);
});

ipcMain.on('stop-proxy', (event, settings) => {
    if(server) {
        server.close();
        server = null;
    }
});

