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
        // !server || server.close();
        return app.stop();

    });

    it('proxy is started on http', function (done) {
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
            key: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.key')),
            cert: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.cert'))
        };
        var destPort = 10443;
        var listenPort = 11443;
        var server = https.createServer(sslOptions, (request, response) => {
            response.end('got request');
        });
        server.listen(destPort);
        console.log('server started on https');
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
        });
    })

    it('proxy is started on https and request interceptor sends custom header', function (done) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        const sslOptions = {
            key: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.key')),
            cert: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.cert'))
        };
        var destPort = 12443;
        var listenPort = 13443;
        var server = https.createServer(sslOptions, (request, response) => {
            response.writeHead(200, {'custom': request.headers['custom']});
            response.end('got request');
        });
        server.listen(destPort);
        console.log('server started on https');
        var settings = {
            dest: 'localhost',
            destProtocol: 'https',
            destPort: destPort,
            listenPort: listenPort,
            listenProtocol: 'https',
            requestInterceptor: 'requestParams.headers[\'custom\']=\'custom val\''
        };

        app.client.waitUntilWindowLoaded().then(() => {
            app.electron.ipcRenderer.send("message-settings", settings);
            setTimeout(() => {
                https.get({
                    hostname: 'localhost',
                    port: listenPort,
                    path: '/'
                }, (res) => {
                    if (!res.headers['custom'].should.equal('custom val')) {
                        done(new Error())
                    }
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


    it('proxy is started on https and response interceptor sends custom header', function (done) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        const sslOptions = {
            key: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.key')),
            cert: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.cert'))
        };
        var destPort = 14443;
        var listenPort = 15443;
        var server = https.createServer(sslOptions, (request, response) => {
            response.end('got request');
        });
        server.listen(destPort);
        console.log('server started on https');
        var settings = {
            dest: 'localhost',
            destProtocol: 'https',
            destPort: destPort,
            listenPort: listenPort,
            listenProtocol: 'https',
            responseInterceptor: 'responseParams.headers[\'custom\']=\'custom val\''
        };

        app.client.waitUntilWindowLoaded().then(() => {
            app.electron.ipcRenderer.send("message-settings", settings);
            setTimeout(() => {
                https.get({
                    hostname: 'localhost',
                    port: listenPort,
                    path: '/'
                }, (res) => {
                    if (!res.headers['custom'].should.equal('custom val')) {
                        done(new Error())
                    }
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
    });

    it('proxy is started on https and response interceptor sends custom body', function (done) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        const sslOptions = {
            key: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.key')),
            cert: fs.readFileSync(path.join(__dirname, '..', 'src', 'resources', 'localhost.cert'))
        };
        var destPort = 15443;
        var listenPort = 16443;
        var server = https.createServer(sslOptions, (request, response) => {
            response.end('got request');
        });
        server.listen(destPort);
        console.log('server started on https');
        var settings = {
            dest: 'localhost',
            destProtocol: 'https',
            destPort: destPort,
            listenPort: listenPort,
            listenProtocol: 'https',
            responseInterceptor: 'responseParams.body=\'custom val\''
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
                        if (body.should.equal('custom val')) {
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
