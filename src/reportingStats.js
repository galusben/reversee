const Config = require('electron-config');
const uuid = require('uuid4');
const config = new Config();
import Analytics from 'electron-google-analytics';
const fakeClientId = 'ce283030-55f6-493f-b97a-c128488258ac';
const devMode = process.argv[2] === 'dev';
const {app} = require('electron');

console.log('devMode: ' + devMode);

const analytics = new Analytics(getPropertyId());
const clientId = getClientId();

function getPropertyId() {
    return devMode ? 'UA-113898039-2' : "UA-113898039-1";
}

function getClientId(){
    let clientId = config.get('ga.clientId');
    if (!clientId) {
        clientId = uuid();
        config.set('ga.clientId', clientId);
    }

    if (devMode) {
        clientId = fakeClientId;
    }
    return clientId;
}

function reportAppLoaded() {
    analytics.screen(app.getName(), app.getVersion(), 'ninja.reversee', 'unknown', 'Main Screen', clientId)
        .then((response) => {
            console.log(response);
            return response;
        }).catch((err) => {
        console.log(err);
        return err;
    });
}

function reportProxyStarted() {
    analytics.event('proxy', 'started', {clientID: clientId})
}

function reportProxyStopped() {
    analytics.event('proxy', 'stopped', {clientID: clientId})
}

module.exports.reportAppLoaded = reportAppLoaded;
module.exports.reportProxyStarted = reportProxyStarted;
module.exports.reportProxyStopped = reportProxyStopped;

