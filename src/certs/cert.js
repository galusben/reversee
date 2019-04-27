const join = require('path').join;
const root = require(join(__dirname, 'root.js'));
const csr = require(join(__dirname, 'csr.js'));
const {dialog} = require('electron');
const fs = require('fs');
const Config = require('electron-config');
const config = new Config();
let rootCertPem = config.get('root.cert.pem');

function generateAndSignCert() {
    if (!rootCertPem) {
        rootCertPem = root.createRootCert();
        config.set('root.cert.pem', rootCertPem)
    }
    return csr.generateAndSignCert(rootCertPem);
}

let options = {
    title: 'Save Reversee Root Cert',
    defaultPath: 'reversee.root',
    filters: [
        {name: 'pem', extensions: ['pem']},
        {name: 'All Files', extensions: ['*']}
    ]
};

function downloadRoot(main) {
    dialog.showSaveDialog(main, options, (filename) =>{
        fs.writeFile(filename, rootCertPem.certificate, 'UTF8')
    })
}

exports.generateAndSignCert = generateAndSignCert;
exports.downloadRoot = downloadRoot;
