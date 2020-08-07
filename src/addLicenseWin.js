const {ipcRenderer} = require('electron');
const logger = require("electron-log");

function licenceAdded() {
    let licence = $('#licence').val();
    logger.info('licence inserted clicked', licence);
    ipcRenderer.send('licence-inserted', {licence: licence});
}