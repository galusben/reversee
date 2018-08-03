const Config = require('electron-config');
const uuid = require('uuid4');
const config = new Config();
import Analytics from 'electron-google-analytics';
const fakeClientId = 'bf234a38-ffba-4b25-995a-5495f8bb425e';
const devMode = process.argv[2] === 'dev';
const {app, session} = require('electron');

console.log('devMode: ' + devMode);
const userAgent = session.defaultSession.getUserAgent();
const analytics = new Analytics(getPropertyId(),{userAgent : userAgent});
analytics.set('ua', userAgent)
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

