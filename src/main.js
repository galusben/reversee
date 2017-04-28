const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const proxy = require(path.join(__dirname, 'proxy.js'));
require('request-to-curl');


process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const sslOptions = {
    key:  fs.readFileSync(path.join(__dirname,'..','resources','localhost.key')),
    cert: fs.readFileSync(path.join(__dirname,'..','resources','localhost.cert'))
};

let win;
let server;


function createWindow() {
    win = new BrowserWindow({width: 950, height: 600});
    win.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

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


function startProxy(settings) {
    console.log("starting proxy to: " + settings.dest);
    const handleRequestWrapper = (request, response) => {
        proxy.handleRequest(request, response, settings, win)
    };
    if (settings.listenProtocol == 'http') {
        server = http.createServer(handleRequestWrapper);
    } else {
        server = https.createServer(sslOptions, handleRequestWrapper);
    }
    server.on('error', (err) => {
        win.webContents.send('server-error', {message: 'could not start server'});
    });
    server.listen(settings.listenPort, function () {
        console.log("Server listening on: %s://localhost:%s", settings.listenProtocol, settings.listenPort);
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

