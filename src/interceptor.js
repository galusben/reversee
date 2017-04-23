const vm = require('vm');

function interceptRequest(requestParams, requestInterceptor) {
    var sandbox = {
        requestParams: requestParams
    };

    console.log('request-interceptor :' + requestInterceptor);
    var script = new vm.Script(requestInterceptor);
    var context = new vm.createContext(sandbox);
    script.runInContext(context);
    console.log('after interception' + JSON.stringify(sandbox.requestParams));
}
exports.interceptRequest = interceptRequest;

