const jws = require('jws');
const path = require('path');
const fs = require('fs');
const publicKey = fs.readFileSync(path.join(__dirname, 'resources', 'licence', 'publicKey.pem'));
const {ipcMain} = require('electron');
const logger = require("electron-log");
let customerLicense = null;

function verify(signature) {
    logger.info('got sig:', signature);
    let licenceOk = jws.verify(signature, 'RS256', publicKey);
    if (licenceOk) {
        logger.info('Licence OK:', signature);
        return jws.decode(signature);
    } else {
        logger.info('Bad license');
        return null;
    }
}

function makeLicensed(licenseData) {
    customerLicense = JSON.parse(licenseData.payload);
    logger.info('licensed', licenseData)
}

function isPro () {
    return customerLicense != null;
}

exports.verify = verify;
exports.makeLicensed = makeLicensed;
exports.isPro = isPro;
