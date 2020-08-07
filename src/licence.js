const jws = require('jws');
const path = require('path');
const fs = require('fs');

const publicKey = fs.readFileSync(path.join(__dirname, 'resources', 'licence', 'publicKey.pem'));
const {ipcMain} = require('electron');
const logger = require("electron-log");


function verify(signature) {
    console.log('got sig:', signature);
    // let decoded = jws.decode(signature);
    let licenceOk = jws.verify(signature, 'RS256', publicKey);
    if (licenceOk) {
        console.log('Licence OK')
    } else {
        console.error('Licence not ok')
    }
}

exports.verify = verify;
