const forge = require('node-forge')

function generateAndSignCert(root) {
    let keys = forge.pki.rsa.generateKeyPair(2048);
    console.log('Creating certification request (CSR) ...');
    var csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{
        name: 'commonName',
        value: 'localhost'
    }, {
        name: 'countryName',
        value: 'US'
    }, {
        shortName: 'ST',
        value: 'Virginia'
    }, {
        name: 'localityName',
        value: 'Blacksburg'
    }, {
        name: 'organizationName',
        value: 'Reversee'
    }, {
        shortName: 'OU',
        value: 'Reversee Web Debugger'
    }]);


// sign certification request
    csr.sign(keys.privateKey, forge.md.sha256.create());
    console.log('Certification request (CSR) created.');

// PEM-format keys and csr
    var pem = {
        privateKey: forge.pki.privateKeyToPem(keys.privateKey),
        publicKey: forge.pki.publicKeyToPem(keys.publicKey),
        csr: forge.pki.certificationRequestToPem(csr)
    };

    console.log('\nKey-Pair:');
    console.log(pem.privateKey);
    console.log(pem.publicKey);

    console.log('\nCertification Request (CSR):');
    console.log(pem.csr);

// verify certification request
    try {
        if (csr.verify()) {
            console.log('Certification request (CSR) verified.');
        } else {
            throw new Error('Signature not verified.');
        }
    } catch (err) {
        console.log('Certification request (CSR) verification failure: ' +
            JSON.stringify(err, null, 2));
    }


// convert CA cert and key from PEM
    var caCertPem = root.certificate;
    var caKeyPem = root.privateKey;
    var caCert = forge.pki.certificateFromPem(caCertPem);
    var caKey = forge.pki.privateKeyFromPem(caKeyPem);

    console.log('Creating certificate...');
    var cert = forge.pki.createCertificate();
// -set_serial 01
    cert.serialNumber = '01';
// -days 365
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
// subject from CSR
    cert.setSubject(csr.subject.attributes);
// issuer from CA
    cert.setIssuer(caCert.subject.attributes);
// set appropriate extensions here (some examples below)


    cert.setExtensions([{
        name: 'basicConstraints',
        cA: true
    }, {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        dataEncipherment: true
    }, {
        name: 'subjectAltName',
        altNames: [{
            type: 6, // URI
            value: 'http://example.org/webid#me'
        },
            {
                type: 2,
                value: "localhost"
            }
        ]
    }]);


    cert.publicKey = csr.publicKey;

// sign certificate with CA key
    cert.sign(caKey, forge.md.sha256.create());
    console.log('Certificate created.');
    let certPem = forge.pki.certificateToPem(cert)
    console.log("Signed cert \n" + certPem)

    return {
        certificate : certPem,
        privateKey : pem.privateKey
    }
}

exports.generateAndSignCert = generateAndSignCert;
