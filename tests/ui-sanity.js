const Application = require('spectron').Application;
const path = require('path');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const http = require('http');


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

describe('Sanity, window is loaded', function () {
    beforeEach(function () {
        return app.start();
    });

    afterEach(function () {
        return app.stop();
    });

    it('opens a window', function () {
        return app.client.waitUntilWindowLoaded()
            .getWindowCount().should.eventually.equal(1);
    });

    it('tests the title', function () {
        return app.client.waitUntilWindowLoaded()
            .getTitle().should.eventually.equal('Reversee');
    });

});
