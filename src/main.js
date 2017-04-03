const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');


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

function handleRequest(clentReq, clientRes) {
    console.log('Path Hit: ' + clentReq.url)
    var requestView = {
        url: clentReq.url,
        headers: clentReq.headers,
        method: clentReq.method,
        body: ''
    };
    var responseView = {
        headers: {},
        body: ''
    };
    var connector = getServerProtocol(userSettings.destProtocol).request({
        host: userSettings.dest,
        path: clentReq.url,
        method: clentReq.method,
        port: userSettings.destPort,
        headers: clentReq.headers
    }, (serverResponse) => {
        for (var key in serverResponse.headers) {
            clientRes.setHeader(key, serverResponse.headers[key]);
            responseView.headers[key] = serverResponse.headers[key];
        }
        clientRes.statusCode = serverResponse.statusCode;
        responseView.statusCode = serverResponse.statusCode;
        serverResponse.on('data', (chunk) => {
            responseView.body = responseView.body + chunk;
            clientRes.write(chunk)
        });
        serverResponse.on('end', () => {
            console.log('ended, request: ' + JSON.stringify(requestView))
            console.log('ended, response: ' + JSON.stringify(responseView))
            win.webContents.send('trip-data', {request: requestView, response: responseView})
            clientRes.end()
        })
    });

    clentReq.on('data', (chunk) => {
        console.log('client chunk!!!!' + chunk);
        connector.write(chunk);
        requestView.body = requestView.body + chunk;
    });
    clentReq.on('end', () => {
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
    server.on('error', (err) -> {
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
    server.close();
    server = null;
});

