const vm = require('vm');

function intercept(params, interceptor, paramsVarName) {
    var sandbox = {};
    sandbox[paramsVarName] = params;
    console.log('%s-interceptor :%s', paramsVarName, interceptor);
    var script = new vm.Script(interceptor);
    var context = new vm.createContext(sandbox);
    script.runInContext(context);
    console.log('after interception' + JSON.stringify(sandbox[paramsVarName]));
}

function interceptRequest(requestParams, requestInterceptor) {
    intercept(requestParams, requestInterceptor, 'requestParams')
}

function interceptResponse(responseParams, responseInterceptor) {
    intercept(responseParams, responseInterceptor, 'responseParams')
}

exports.interceptRequest = interceptRequest;
exports.interceptResponse = interceptResponse;

