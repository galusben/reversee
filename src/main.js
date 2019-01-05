const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('path');
const url = require('url');
const nativeImage = require('electron').nativeImage;
const windowStateKeeper = require('electron-window-state');
const {autoUpdater} = require("electron-updater");
const menu = require(path.join(__dirname, 'menu.js'));

const breakpointWindows = {};
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
let breakpointsEditWin;


let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'Reversee.png'));
const icon = process.platform === 'linux' ? image : null;

function createBreakpointsEditWin() {
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
        breakpointsEditWin.hide();
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
        proxyWin.destroy();
        proxyWin = null;
    });
    createBreakpointsEditWin();
    proxyWin = new BrowserWindow({width: 80, height: 60, show: false});
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
});

ipcMain.on('stop-proxy', (event, data) => {
    if (proxyWin != null) {
        proxyWin.webContents.send('win-stop-proxy', data);
        stats.reportProxyStopped();
    }
});

ipcMain.on('breakpoints-settings', (event, data) => {
    if (proxyWin != null) {
        proxyWin.webContents.send('win-breakpoints-settings', data);
    }
    if(breakpointsEditWin) {
        breakpointsEditWin.hide();
    }
});

ipcMain.on('breakpoints-create-window', (event, data) => {
    breakpointWindows[data.breakPointId] = createBreakpointWindow(data.breakPointId, data.request, data.body);
});

ipcMain.on('breakpoints-hide-window', (event, data) => {
    breakpointWindows[data.breakPointId].hide();
});

ipcMain.on('breakpoints-destroy-window', (event, data) => {
    breakpointWindows[data.breakPointId].destroy();
});

ipcMain.on('breakpoints-show-window', (event, data) => {
    breakpointWindows[data.breakPointId].show();
});


function createBreakpointWindow(breakPointId, request, body) {
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
    return breakpointWin;
}


ipcMain.on('continue', (event, data) => {
    logger.debug('got continue');
    proxyWin.webContents.send('win-continue', data);
});

ipcMain.on('proxy-started', (event, data) => {
    logger.info("proxy started");
    stats.reportProxyStarted()
});

ipcMain.on('server-error', (event, data) => {
    win.webContents.send('server-error', data);
});
