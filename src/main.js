const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const proxy = require(path.join(__dirname, 'proxy.js'));
require('request-to-curl');
const menu = require(path.join(__dirname, 'menu.js'));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, '..', 'resources', 'localhost.key')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'resources', 'localhost.cert'))
};

let win;
let server;
let breakpointsEditWin;
let haltedBreakpoints = [];
let breakpointsSettings = [];
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
    breakpointsEditWin = new BrowserWindow({width: 800, height: 600, frame: false});
    breakpointsEditWin.hide();
    menu.create(breakpointsEditWin);
    breakpointsEditWin.loadURL(url.format({
        pathname: path.join(__dirname, 'breakPointsEdit.html'),
        protocol: 'file:',
        slashes: true
    }));

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


function matchingBreakpoint(url) {
    console.log('url ' + url);
    for (var i = 0; i < breakpointsSettings.length; i++) {
        console.log('url ' + breakpointsSettings[i].path);
        if (url.match(new RegExp(breakpointsSettings[i].path))) {
            return breakpointsSettings[i]
        }
    }
}

function startProxy(settings) {
    console.log("starting proxy to: " + settings.dest);
    const handleRequestWrapper = (request, response) => {
        if (matchingBreakpoint(request.url)) {
            var breakpointWin = new BrowserWindow({width: 800, height: 600, frame: false});
            breakpointWin.loadURL(url.format({
                pathname: path.join(__dirname, 'breakpoint.html'),
                protocol: 'file:',
                slashes: true
            }));
            console.log('sending : breaking');
            breakpointWin.webContents.on('did-finish-load', () => {
                breakpointWin.webContents.send('breaking', {url: request.url});
            });
            haltedBreakpoints.push({
                action: function (breakpointData) {
                    proxy.handleRequest(request, response, settings, win, breakpointData)
                },
                bwin: breakpointWin
            })
        } else {
            proxy.handleRequest(request, response, settings, win, {})
        }
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
    if (server) {
        server.close();
        server = null;
    }
});

ipcMain.on('breakpoints-settings', (event, data) => {
    breakpointsEditWin.hide();
    console.log(data);
    breakpointsSettings = breakpointsSettings.concat(data);
});

ipcMain.on('continue', (event, data) => {
    console.log('continue');
    let breakpoint = haltedBreakpoints.shift();
    breakpoint.bwin.hide();
    breakpoint.action({path: data.url});

});

