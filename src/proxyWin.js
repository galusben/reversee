const path = require('path');
let breakpointsSettings = {};
let haltedBreakpoints = {};
let currentViewingBreakpoint = null;
const proxy = require(path.join(__dirname, 'proxy.js'));
const {ipcRenderer} = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const logger = require("electron-log");
require('http-shutdown').extend();


ipcRenderer.on('start-proxy', (event, settings) => {
    startProxy(settings)
});


ipcRenderer.on('win-continue', (event, data) => {
    logger.info('win-continue');
    let breakpoint = haltedBreakpoints[data.id];
    ipcRenderer.send('breakpoints-destroy-window', {breakPointId: data.id});
    delete haltedBreakpoints[data.id];
    let breakpointWindows = Object.values(haltedBreakpoints);
    if (breakpointWindows.length > 0) {
        currentViewingBreakpoint = breakpointWindows[0];
        ipcRenderer.send('breakpoints-show-window', {breakPointId: data.id});
    } else {
        currentViewingBreakpoint = null;
    }
    breakpoint.action({path: data.url, method: data.method, headers: data.headers, body: data.body});
});


ipcRenderer.on('win-breakpoints-settings', (event, settings) => {
    breakpointsSettings = settings
});

const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'resources', 'localhost.key')),
    cert: fs.readFileSync(path.join(__dirname, 'resources', 'localhost.cert'))
};

let server;

function notify(data) {
    ipcRenderer.send('main-trip-data', data);
}


ipcRenderer.on('win-stop-proxy', (event, data) => {
    if (server) {
        console.log('shutting down server');
        server.shutdown(function () {
            server = null;
        });
    }
});


function matchingBreakpoint(url, method) {
    logger.info('searching for matching breakpoint. url: ' + url);
    logger.info(breakpointsSettings);
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
    logger.info("starting proxy to: " + settings.dest);
    // const redirect = menu.getMenuInstance().getMenuItemById('redirects');
    // const hostRewrite = menu.getMenuInstance().getMenuItemById('host');
    settings.redirect = true;
    settings.hostRewrite = true;
    logger.info('hostRewrite ' + settings.hostRewrite);
    const handleRequestWrapper = (request, response) => {

        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            logger.info("going to search for breakpoint");
            if (matchingBreakpoint(request.url, request.method)) {
                let breakPointId = generateId();
                // const breakpointWin = createBreakpointWindow(breakPointId, request, body)
                ipcRenderer.send('breakpoints-create-window', {breakPointId, request, body});

                haltedBreakpoints[breakPointId] = {
                    action: function (requestParams) {
                        proxy.handleRequest(request, response, settings, notify, requestParams)
                    }
                };
                //'breakpoints-hide-window'
                if (currentViewingBreakpoint) {
                    // breakpointWin.hide()
                    ipcRenderer.send('breakpoints-hide-window', {breakPointId});
                } else {
                    currentViewingBreakpoint = haltedBreakpoints[breakPointId]
                }
            } else {
                proxy.handleRequest(request, response, settings, notify, {body})
            }
        });

    };
    if (settings.listenProtocol === 'http') {
        server = http.createServer(handleRequestWrapper).withShutdown();
    } else {
        server = https.createServer(sslOptions, handleRequestWrapper).withShutdown();
    }
    server.on('error', (err) => {
        logger.info("error on server!!!", err);
        ipcRenderer.send('server-error', {code: err.code});
    });
    server.listen(settings.listenPort, function () {
        logger.info("Server listening on: %s://localhost:%s", settings.listenProtocol, settings.listenPort);
    });
    ipcRenderer.send('proxy-started', {});
}
