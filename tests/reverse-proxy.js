const Application = require('spectron').Application;
const path = require('path');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const http = require('http');
const https = require('https');
const fs = require('fs');



global.before(function () {
    chai.should();
    chai.use(chaiAsPromised);
});

var electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');

if (process.platform === 'win32') {
    electronPath += '.cmd';
}

var appPath = path.join(__dirname, '..', 'src', 'main.js');

var app = new Application({
    path: electronPath,
    args: [appPath]
});

describe('proxy is working', function () {
    beforeEach(function () {
        return app.start();
    });

    afterEach(function () {
        return app.stop();
    });

    it('proxy is startted on http', function (done) {
        var destPort = 8090;
        var listenPort = 8091;
        var server = http.createServer((request, response) => {
            response.end('got request');
        });
        server.listen(destPort);

        var settings = {
            dest: 'localhost',
            destProtocol: 'http',
            destPort: destPort,
            listenPort: listenPort,
            listenProtocol: 'http'
        };

        app.client.waitUntilWindowLoaded().then(() => {
            app.electron.ipcRenderer.send("message-settings", settings);
            setTimeout(() => {
                http.get({
                    hostname: 'localhost',
                    port: listenPort,
                    path: '/',
                }, (res) => {
                    var body = '';
                    res.on('data', (data) => {
                        body += data
                    });
                    res.on('end', () => {
                        if (body.should.equal('got request')) {
                            done()
                        } else {
                            done(new Error())
                        }
                    });
                }).on('error', (e) => {
                    console.log('error');
                    done(e);
                });
            }, 200)

        })


    });


    it('proxy is startted on https', function (done) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        const sslOptions = {
            key: fs.readFileSync(path.join(__dirname, '..', 'resources', 'localhost.key')),
            cert: fs.readFileSync(path.join(__dirname, '..', 'resources', 'localhost.cert'))
        };
        var destPort = 10443;
        var listenPort = 11443;
        var server = https.createServer(sslOptions, (request, response) => {
            response.end('got request');
        });
        server.listen(destPort);
        console.log('server started on https')
        var settings = {
            dest: 'localhost',
            destProtocol: 'https',
            destPort: destPort,
            listenPort: listenPort,
            listenProtocol: 'https'
        };

        app.client.waitUntilWindowLoaded().then(() => {
            app.electron.ipcRenderer.send("message-settings", settings);
            setTimeout(() => {
                https.get({
                    hostname: 'localhost',
                    port: listenPort,
                    path: '/'
                }, (res) => {
                    var body = '';
                    res.on('data', (data) => {
                        body += data
                    });
                    res.on('end', () => {
                        if (body.should.equal('got request')) {
                            done()
                        } else {
                            done(new Error())
                        }
                    });
                }).on('error', (e) => {
                    console.log('error from get');
                    done(e);
                });
            }, 200)

        })


    })
});
