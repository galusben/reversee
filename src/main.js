const {app, BrowserWindow, ipcMain, dialog} = require('electron');
const path = require('path');
const url = require('url');
const nativeImage = require('electron').nativeImage;
const windowStateKeeper = require('electron-window-state');
const {autoUpdater} = require("electron-updater");
const menu = require(path.join(__dirname, 'menu.js'));
const cert = require(path.join(__dirname,'certs', 'cert.js'));
const license = require(path.join(__dirname,'licence.js'));
const fs = require('fs');

const breakpointWindows = {};

const logger = require("electron-log");
autoUpdater.logger = logger;
logger.transports.file.level = "info";
logger.transports.console.level = "info";

autoUpdater.setFeedURL("https://download.reversee.ninja");
autoUpdater.checkForUpdatesAndNotify();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let pem = cert.generateAndSignCert();

let win;
let proxyWin;
let breakpointsEditWin;
let addLicenseWin;


let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'Reversee.png'));
const icon = process.platform === 'linux' ? image : null;

function createBreakpointsEditWin() {
    breakpointsEditWin = new BrowserWindow({width: 800, height: 600, icon: icon,
        webPreferences: {
            nodeIntegration: true
        }});
    breakpointsEditWin.hide();
    breakpointsEditWin.loadURL(url.format({
        pathname: path.join(__dirname, 'breakPointsEdit.html'),
        protocol: 'file:',
        slashes: true
    }));
    breakpointsEditWin.on('close', (event) => {
        breakpointsEditWin.webContents.send('window-closed', {});
        breakpointsEditWin.hide();
        event.preventDefault();
    });
}

function createAddLicenseWin() {
    addLicenseWin = new BrowserWindow({width: 800, height: 450, icon: icon,
        webPreferences: {
            nodeIntegration: true
        }});
    addLicenseWin.hide();
    addLicenseWin.loadURL(url.format({
        pathname: path.join(__dirname, 'addLicenseWin.html'),
        protocol: 'file:',
        slashes: true
    }));
    addLicenseWin.on('close', (event) => {
        addLicenseWin.hide();
        event.preventDefault();
    });
    return addLicenseWin;
}

function createWindows() {
    let mainWindowState = windowStateKeeper({
        defaultWidth: 1000,
        defaultHeight: 600
    });
    win = new BrowserWindow({
        'x': mainWindowState.x,
        'y': mainWindowState.y,
        'width': mainWindowState.width,
        'height': mainWindowState.height,
        icon: icon,
        show: false,
        webPreferences: {
            nodeIntegration: true
        }
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
        addLicenseWin.destroy();
    });
    createBreakpointsEditWin();
    let licenseWin = createAddLicenseWin();
    menu.create(breakpointsEditWin, win, licenseWin);
    proxyWin = new BrowserWindow({width: 80, height: 60, show: false,
        webPreferences: {
        nodeIntegration: true
    }});
    proxyWin.loadURL(url.format({
        pathname: path.join(__dirname, 'proxyWin.html'),
        protocol: 'file:',
        slashes: true
    }));
    checkLicense()
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
    console.info(settings);
    const sslOptions = {
        key: pem.privateKey,
        cert : pem.certificate
    };
    logger.info('ssl-options main: ', sslOptions);
    settings.sslOptions = sslOptions;
    proxyWin.webContents.send('start-proxy', settings);
});

ipcMain.on('main-trip-data', (event, data) => {
    win.webContents.send('trip-data', data);
});

ipcMain.on('stop-proxy', (event, data) => {
    if (proxyWin != null) {
        proxyWin.webContents.send('win-stop-proxy', data);
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
    const breakpointWin = new BrowserWindow({width: 400, height: 400, icon: icon,
        webPreferences: {
        nodeIntegration: true
    }});
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
});

ipcMain.on('server-error', (event, data) => {
    win.webContents.send('server-error', data);

});

function showMessage(message) {
    dialog.showMessageBox(addLicenseWin, {type: 'info', message: message, icon: image});
}

ipcMain.on('licence-inserted', (event, data) => {
    logger.info('got licence-inserted');
    if (!data.licence) {
        showMessage('Invalid License, please try again');
        return;
    }
    data.licence = data.licence && data.licence.trim();
    let parsed;
    try {
        parsed = license.verify(data.licence);
    } catch (e) {
        showMessage('Invalid License, please try again');
        return;
    }
    logger.info('lic body:' + parsed);
    if (!parsed) {
        showMessage('Invalid License, please try again');
        return;
    }
    license.makeLicensed(parsed);
    let filename = path.join(app.getPath('userData'), 'reversee.lic');
    fs.writeFileSync(filename, data.licence, 'UTF8');
    showMessage('Thank you for purchasing Reversee - Pro!');
    addLicenseWin.hide()
});

function checkLicense() {
    let filename = path.join(app.getPath('userData'), 'reversee.lic');
    fs.promises.readFile(filename, {encoding: 'UTF8'}).then((lic) => {
        if (lic) {
            let parsed = license.verify(lic);
            if (!parsed) {
                return;
            }
            license.makeLicensed(parsed)
        }
    }).catch(() => {})
}