const {BrowserWindow} = require('electron').remote
const path = require('path');
let breakpointsSettings = {};
let haltedBreakpoints = {};
let currentViewingBreakpoint = null;
const proxy = require(path.join(__dirname, 'proxy.js'));
// stats = require(path.join(__dirname, 'reportingStats.js'));
const {ipcRenderer} = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
require('http-shutdown').extend();


ipcRenderer.on('start-proxy', (event, settings) => {
    startProxy(settings)
});

const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'resources', 'localhost.key')),
    cert: fs.readFileSync(path.join(__dirname, 'resources', 'localhost.cert'))
};



let server;

function notify(data) {
    ipcRenderer.send('main-trip-data', data);
}

function matchingBreakpoint(url, method) {
    console.log('url ' + url);
    for (let key in breakpointsSettings) {
        let breakpointSetting = breakpointsSettings[key];
        console.log('url ' + breakpointSetting.path);
        if (breakpointSetting.methods.includes(method) && url.match(new RegExp(breakpointSetting.path))) {
            return breakpointSetting;
        }
    }
    return null;
}



let generateId = function generateId() {
    let i = 0;
    return function () {
        return i++
    };
}();


function startProxy(settings) {
    console.log("starting proxy to: " + settings.dest);
    // const redirect = menu.getMenuInstance().getMenuItemById('redirects');
    // const hostRewrite = menu.getMenuInstance().getMenuItemById('host');
    settings.redirect = true;
    settings.hostRewrite = true;
    console.log('hostRewrite ' + settings.hostRewrite);
    const handleRequestWrapper = (request, response) => {

        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);

            if (matchingBreakpoint(request.url, request.method)) {
                const breakpointWin = new BrowserWindow({width: 400, height: 400, icon: icon});
                breakpointWin.loadURL(url.format({
                    pathname: path.join(__dirname, 'breakPoint.html'),
                    protocol: 'file:',
                    slashes: true
                }));
                breakpointWin.on('close', (event) => {
                        // if (win) {
                            event.preventDefault()
                        // }
                    }
                );

                let breakPointId = generateId();

                breakpointWin.webContents.on('did-finish-load', () => {
                    breakpointWin.webContents.send('breaking',
                        {
                            id: breakPointId,
                            url: request.url,
                            method: request.method,
                            headers: new Object(request.headers),
                            body: body
                        });
                });
                haltedBreakpoints[breakPointId] = {
                    action: function (requestParams) {
                        proxy.handleRequest(request, response, settings, notify, requestParams)
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
                proxy.handleRequest(request, response, settings, notify, {body})
            }
        });

    };
    if (settings.listenProtocol == 'http') {
        server = http.createServer(handleRequestWrapper).withShutdown();
    } else {
        server = https.createServer(sslOptions, handleRequestWrapper).withShutdown();
    }
    server.on('error', (err) => {
        console.log("error on server!!!", err);
        // win.webContents.send('server-error', {code: err.code});
    });
    server.listen(settings.listenPort, function () {
        console.log("Server listening on: %s://localhost:%s", settings.listenProtocol, settings.listenPort);
    });
    // stats.reportProxyStarted();
}
