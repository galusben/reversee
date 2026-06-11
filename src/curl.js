// Builds a copy-pasteable curl command for the upstream request. Replaces the
// request-to-curl dependency, which patched node http internals via
// process.binding and aborts on modern Node.

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function build(protocol, requestParams) {
    const defaultPort = protocol === 'https' ? 443 : 80;
    const port = requestParams.port;
    const portPart = port && String(port) !== String(defaultPort) ? ':' + port : '';
    const url = `${protocol}://${requestParams.host}${portPart}${requestParams.path}`;

    const parts = ['curl', '-X', requestParams.method, shellQuote(url)];
    const headers = requestParams.headers || {};
    for (const key in headers) {
        const values = Array.isArray(headers[key]) ? headers[key] : [headers[key]];
        for (const value of values) {
            parts.push('-H', shellQuote(`${key}: ${value}`));
        }
    }
    if (requestParams.body && requestParams.body.length) {
        parts.push('--data-binary', shellQuote(requestParams.body.toString()));
    }
    return parts.join(' ');
}

exports.build = build;
