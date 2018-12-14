const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const url = require('url');
const nativeImage = require('electron').nativeImage;
const windowStateKeeper = require('electron-window-state');
const {autoUpdater} = require("electron-updater");
const menu = require(path.join(__dirname, 'menu.js'));
let stats;

const logger = require("electron-log");
autoUpdater.logger = logger;
logger.transports.file.level = "info";
logger.transports.console.level = "info";



autoUpdater.setFeedURL("https://download.reversee.ninja");
autoUpdater.checkForUpdatesAndNotify();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let win;
let proxyWin;
let server;
let breakpointsEditWin;


let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'Reversee.png'));
const icon = process.platform === 'linux' ? image : null;

function createBreakpointWin() {
    breakpointsEditWin = new BrowserWindow({width: 800, height: 600, icon: icon});
    breakpointsEditWin.hide();
    menu.create(breakpointsEditWin, win);
    breakpointsEditWin.loadURL(url.format({
        pathname: path.join(__dirname, 'breakPointsEdit.html'),
        protocol: 'file:',
        slashes: true
    }));
    breakpointsEditWin.on('close', (event) => {
        breakpointsEditWin.webContents.send('window-closed', {});
        breakpointsEditWin.hide()
        event.preventDefault();
    })
}

function createWindows() {
    let mainWindowState = windowStateKeeper({
        defaultWidth: 1000,
        defaultHeight: 600
    });
    stats = require(path.join(__dirname, 'reportingStats.js'));
    stats.reportAppLoaded();

    win = new BrowserWindow({
        'x': mainWindowState.x,
        'y': mainWindowState.y,
        'width': mainWindowState.width,
        'height': mainWindowState.height,
        icon: icon,
        show: false
    });
    mainWindowState.manage(win);

    win.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

    win.on('ready-to-show', function () {
        win.show();
        win.focus();
    });

    win.on('closed', () => {
        win = null;
        breakpointsEditWin.destroy();
        breakpointsEditWin = null;
    });
    createBreakpointWin();
    proxyWin = new BrowserWindow({width: 800, height: 600, show: true});
    proxyWin.loadURL(url.format({
        pathname: path.join(__dirname, 'proxyWin.html'),
        protocol: 'file:',
        slashes: true
    }));
}

app.on('ready', createWindows);

app.on('window-all-closed', () => {
    app.quit()
});

app.on('activate', () => {
    if (win === null) {
        createWindows()
    }
});


ipcMain.on('message-settings', (event, settings) => {
    console.log(settings);
    proxyWin.webContents.send('start-proxy', settings);
});

ipcMain.on('main-trip-data', (event, data) => {
    win.webContents.send('trip-data', data);
})

ipcMain.on('stop-proxy', (event, settings) => {
    if (server) {
        console.log('shutting down server')
        server.shutdown(function () {
            server = null;
        });
    }
    stats.reportProxyStopped();
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
    breakpoint.action({path: data.url, method: data.method, headers: data.headers, body: data.body});
});

ipcMain.on('proxy-started', (event, data) => {
    logger.info("LOGGER proxy started main")
    stats.reportProxyStarted()
});

ipcMain.on('server-error', (event, data) => {
    win.webContents.send('server-error', data);
});
