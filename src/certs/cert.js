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
        if (filename) {
            fs.writeFile(filename, rootCertPem.certificate, 'UTF8')
        }
    })
}

function certificateTrustDialog(main) {
    let cert = {data: rootCertPem.certificate};
    const message = "To proxy https clients that can not trust Self Signed Certificates, Click 'Show Certificate' and select 'Always Trust.'";
    dialog.showCertificateTrustDialog(main, {certificate: cert, message}, ()=>{});
}

exports.generateAndSignCert = generateAndSignCert;
exports.downloadRoot = downloadRoot;
exports.certificateTrustDialog = certificateTrustDialog;
