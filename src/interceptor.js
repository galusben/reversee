const vm = require('vm');

function intercept(requestParams, responseParams, interceptor) {
    try {
        var sandbox = {};
        sandbox['requestParams'] = requestParams;
        sandbox['responseParams'] = responseParams;
        console.log('interceptor :%s', interceptor);
        var script = new vm.Script(interceptor);
        var context = new vm.createContext(sandbox);
        script.runInContext(context);
    } catch (e) {
        console.log('error' + e);
    }
}

function interceptRequest(requestParams, requestInterceptor) {
    intercept(requestParams, null, requestInterceptor)
}

function interceptResponse(responseParams, responseInterceptor, requestParams) {
    console.log('interceptResponse');
    intercept(Object.assign({}, requestParams), responseParams, responseInterceptor);
}

exports.interceptRequest = interceptRequest;
exports.interceptResponse = interceptResponse;

