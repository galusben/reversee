const join = require('path').join;
const root = require(join(__dirname, 'root.js'));
const csr = require(join(__dirname, 'csr.js'));
const {download} = require('electron-dl');
const {app} = require('electron');
const fs = require('fs');
const Config = require('electron-config');
const config = new Config();

const dataDir = app.getPath('userData');

let rootCertPem = config.get('root.cert.pem');

function generateAndSignCert() {
    if (!rootCertPem) {
        rootCertPem = root.createRootCert();
        config.set('root.cert.pem', rootCertPem)
    }
    return csr.generateAndSignCert(rootCertPem);
}

function downloadRoot(main) {
    const fileLocation = join(dataDir, 'root.cert.pem');
    fs.writeFile(fileLocation, rootCertPem.certificate, 'UTF8', () => {
        download(main, 'file://' + join(dataDir, 'root.cert.pem'), {saveAs: true})
    });

}

exports.generateAndSignCert = generateAndSignCert;
exports.downloadRoot = downloadRoot;
