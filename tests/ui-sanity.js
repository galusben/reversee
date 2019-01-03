const Application = require('spectron').Application;
const path = require('path');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

global.before(function () {
    chai.should();
    chai.use(chaiAsPromised);
});

let electronPath = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');

if (process.platform === 'win32') {
    electronPath += '.cmd';
}

let appPath = path.join(__dirname, '..', 'src', 'main.js');

const app = new Application({
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
            .getWindowCount().should.eventually.equal(3);
    });

    it('tests the title', function () {
        return app.client.waitUntilWindowLoaded().windowByIndex(2)
            .getTitle().should.eventually.equal('Reversee');
    });

});
