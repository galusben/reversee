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
let haltedBreakpoints = {};
let breakpointsSettings = {};
let currentViewingBreakpoint = null;

function createBreakpointWin() {
    breakpointsEditWin = new BrowserWindow({width: 800, height: 600});
    breakpointsEditWin.hide();
    menu.create(breakpointsEditWin);
    breakpointsEditWin.loadURL(url.format({
        pathname: path.join(__dirname, 'breakPointsEdit.html'),
        protocol: 'file:',
        slashes: true
    }));
    breakpointsEditWin.on('close', (event) => {
            if (win) {
                event.preventDefault()
            }
        }
    )
}

function createWindow() {
    win = new BrowserWindow({width: 1000, height: 600});
    win.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

    win.on('closed', () => {
        win = null;
        breakpointsEditWin.destroy();
        breakpointsEditWin = null;
    });

    createBreakpointWin();

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


function matchingBreakpoint(url, method) {
    console.log('url ' + url);
    for (var key in breakpointsSettings) {
        let breakpointSetting = breakpointsSettings[key];
        console.log('url ' + breakpointSetting.path);
        if (breakpointSetting.methods.includes(method) && url.match(new RegExp(breakpointSetting.path))) {
            return breakpointSetting;
        }
    }
    return null;
}


var generateId = function generateId() {
    var i = 0;
    return function () {
        return i++
    };
}();

function startProxy(settings) {
    console.log("starting proxy to: " + settings.dest);
    const handleRequestWrapper = (request, response) => {
        if (matchingBreakpoint(request.url, request.method)) {
            var breakpointWin = new BrowserWindow({width: 400, height: 400});
            breakpointWin.loadURL(url.format({
                pathname: path.join(__dirname, 'breakpoint.html'),
                protocol: 'file:',
                slashes: true
            }));
            breakpointWin.on('close', (event) => {
                    if (win) {
                        event.preventDefault()
                    }
                }
            );

            var breakPointId = generateId();
            breakpointWin.webContents.on('did-finish-load', () => {
                breakpointWin.webContents.send('breaking',
                    {
                        id: breakPointId,
                        url: request.url,
                        method: request.method,
                        headers: new Object(request.headers)
                    });
            });
            haltedBreakpoints[breakPointId] = {
                action: function (breakpointData) {
                    proxy.handleRequest(request, response, settings, win, breakpointData)
                }
                ,
                bwin: breakpointWin
            };
            if (currentViewingBreakpoint && currentViewingBreakpoint.bwin.isVisible()) {
                breakpointWin.hide()
            } else {
                currentViewingBreakpoint = haltedBreakpoints[breakPointId]
            }
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
    breakpointsSettings = data
});

ipcMain.on('continue', (event, data) => {
    let breakpoint = haltedBreakpoints[data.id];
    breakpoint.bwin.destroy();
    delete haltedBreakpoints[data.id];
    var breakpointWindows = Object.values(haltedBreakpoints);
    if (breakpointWindows.length > 0) {
        currentViewingBreakpoint = breakpointWindows[0];
        currentViewingBreakpoint.bwin.show()
    } else {
        currentViewingBreakpoint = null;
    }
    breakpoint.action({path: data.url, method: data.method, headers: data.headers});

});

