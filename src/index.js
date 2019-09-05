const {ipcRenderer, remote, clipboard} = require('electron');
const {Menu, MenuItem} = remote;
const logger = require("electron-log");

function addContextMenu(element, curl) {
    const menu = new Menu();
    menu.append(new MenuItem({
        label: 'Copy as curl', click() {
            clipboard.writeText(curl)
        }
    }));
    menu.append(new MenuItem({
        label: 'Clear All', click() {
            resetTable()
        }
    }));
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu.popup(remote.getCurrentWindow());
    }, false);
}

function addCopyToClipInternalText(element) {
    const menu = new Menu();
    menu.append(new MenuItem({
        label: 'Copy To Clipboard', click() {
            clipboard.writeText(element.text());
        }
    }));
    element[0].addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu.popup(remote.getCurrentWindow());
    }, false);
}


function addCopyToClipInternalTextEditor(element, cmKey) {
    const menu = new Menu();
    menu.append(new MenuItem({
        label: 'Copy To Clipboard', click() {
            clipboard.writeText(readOnlyEditors[cmKey].getValue());
        }
    }));
    element[0].addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu.popup(remote.getCurrentWindow());
    }, false);
}

let proxySet = false;
let traffic = {};

let requestInterceptorEditor;
let responseInterceptorEditor;
const readOnlyEditors = {};

function calcMode(headersMap) {
    let contentType = headersMap['content-type'] || headersMap['Content-Type'];
    if (contentType && contentType.length > 0) {
        contentType = contentType.split(';')[0]
    }
    return contentType;
}

function createReadOnlyEditor(element, text, mode, editor) {
    if (!editor) {
        editor = monaco.editor.create(element[0], {
            value: text,
            language: mode,
            automaticLayout: true,
            autoIndent: true,
            contextmenu: false,
            formatOnType: true
        });
    } else {
        monaco.editor.setModelLanguage(editor.getModel(), mode);
        editor.setValue(text);
    }
    editor.updateOptions({readOnly: false});
    editor.getAction('editor.action.formatDocument').run().then(() => {
        editor.updateOptions({readOnly: true})
    });
    return editor;
}

function setDirection(direction, element) {
    const headersElement = $(`#${direction}-headers`);
    const bodyElement = $(`#${direction}-body`);
    const formattedBodyElement = $(`#${direction}-body-formatted`);
    headersElement.empty();
    let trafficKey = $(element).attr('trafficId');
    let headersMap = traffic[trafficKey][direction].headers;
    const bodyText = traffic[trafficKey][direction].body && traffic[trafficKey][direction].body.toString();
    const mode = calcMode(headersMap);
    let headersText = '';
    for (let key in headersMap) {
        headersText += key + " : " + headersMap[key] + "\n";
    }
    let headers = $('<pre>').text(headersText);
    headersElement.append(headers);
    logger.info('creating plain editor');
    readOnlyEditors[direction + '-plain'] = createReadOnlyEditor(bodyElement, bodyText, null, readOnlyEditors[direction + '-plain']);
    logger.info('creating formatted editor');
    readOnlyEditors[direction + '-formatted'] = createReadOnlyEditor(formattedBodyElement, bodyText, mode, readOnlyEditors[direction + '-formatted']);
}

function extractTimingsText(timings) {
    let timingsText = '';
    timingsText += 'Start timestamp' + " : " + timings['start'] + "\n";
    timingsText += 'DNS Lookup' + " : " + timings['dnsLookup'] / 1000000.0 + " ms \n";
    timingsText += 'Time till first byte received' + " : " + (timings['firstByte'] ? timings['firstByte'] / 1000000.0 : 0)+ " ms \n";
    timingsText += 'TCP Connection' + " : " + (timings['tcpConnection'] ? timings['tcpConnection'] / 1000000.0 : 0) + " ms \n";
    timingsText += 'TLS handshake' + " : " + (timings['tlsHandshake'] ? timings['tlsHandshake'] / 1000000.0 : 0) + " ms \n";
    timingsText += 'Total' + " : " + (timings['total'] ? timings['total'] / 1000000.0 : 0) + " ms \n";
    return timingsText;
}

function rowClicked(element) {
    setDirection('response', element);
    setDirection('request', element);
    const summeryElement = $(`#summery`);
    let trafficKey = $(element).attr('trafficId');
    let timings = traffic[trafficKey].timings;
    logger.debug("timings", timings);
    let timingsText = extractTimingsText(timings);
    summeryElement.empty();
    summeryElement.append($('<pre>').text(timingsText));
    $('.font-bold').removeClass('font-bold');
    $(element).addClass('font-bold');
    $("[selected-r='true']").attr('selected-r', 'false');
    $(element).attr('selected-r', 'true');
}

function setProxy() {
    let settings = {
        dest: document.getElementById("dest").value,
        destProtocol: document.getElementById("destProtocol").value,
        destPort: document.getElementById("destPort").value || (document.getElementById("destProtocol").value === 'http' ? '80' : '443'),
        listenPort: document.getElementById("listenPort").value,
        listenProtocol: document.getElementById("listenProtocol").value,
        requestInterceptor: requestInterceptorEditor.getValue(),
        responseInterceptor: responseInterceptorEditor.getValue(),
        interceptRequest: $('#intercept-request').is(':checked'),
        interceptResponse: $('#intercept-response').is(':checked')
    };
    logger.info('userSettings: ' + JSON.stringify(settings));
    localStorage.setItem('userSettings', JSON.stringify(settings));
    $('.ng-invalid').removeClass('ng-invalid');
    let validations = [];
    $('.form-control').not("[optional='true']").map(function (index, element) {
        validations.push(notifyInvalid(element.id))
    });
    validations.push({valid: validatePort(settings.listenPort)});
    let valid = true;
    for (let i = 0; i < validations.length; i++) {
        valid = valid && validations[i].valid;
    }
    if (!valid) {
        return false;
    }
    $('.form-control, input[type=checkbox]').not('button').prop('disabled', 'true');
    requestInterceptorEditor.updateOptions({readOnly: true});
    responseInterceptorEditor.updateOptions({readOnly: true});
    ipcRenderer.send('message-settings', settings);


    $('#traffic-table-body').on('click', 'tr', function (event) {
        rowClicked(this);
    });
    return true;
}

function validatePort(port) {
    if (!isNaN(port) && port > 0 && port < 65536) {
        return true
    } else {
        setInvalid("listenPort");
        return false
    }
}

function notifyInvalid(id) {
    let jqueryId = $(`#${id}`);
    let val = jqueryId.val();
    if (!val || val.length <= 0) {
        jqueryId.addClass('ng-invalid');
        return {valid: false};
    }
    return {valid: true};
}

function setInvalid(id) {
    let jqueryId = $(`#${id}`);
    jqueryId.addClass('ng-invalid');
}

function getClassForTripData(statusCode) {
    const statusClass = {
        "2": "success",
        "3": "warning",
        "4": "danger",
        "5": "danger"
    };
    let claz = statusClass[statusCode.toString().substring(0, 1)];
    if (claz) {
        return claz
    }
    return ""
}

let scrolLocked = true;

function toggleScollLock() {
    const lockIcon = $('#scroll-lock');
    if (scrolLocked) {
        lockIcon.removeClass('fa fa-lock');
        lockIcon.addClass('fa');
        lockIcon.addClass('fa-unlock-alt')
    } else {
        lockIcon.removeClass('fa fa-unlock-alt');
        lockIcon.addClass('fa fa-lock');
        lockIcon.addClass('fa-lock')
    }
    scrolLocked = !scrolLocked;
}

ipcRenderer.on('trip-data', (event, arg) => {
    traffic[arg.trafficId] = arg;
    let tableBody = $('#traffic-table-body');
    let statusCode = arg.response.statusCode;
    let tr = $(`<tr class="${getClassForTripData(statusCode)}">` +
        '<td></td>' +
        '<td>' + arg.request.method + '</td>' +
        '<td>' + arg.request.url + '</td>' +
        '<td>' + arg.response.statusCode + '</td>' +
        '<td>' + (arg.response.headers["content-type"] ? arg.response.headers["content-type"] : '') + '</td>' +
        '</tr>');
    tr.attr('trafficId', arg.trafficId);
    let oldTr = $(`[trafficId='${arg.trafficId}']`);
    if (oldTr.length > 0) {
        if (oldTr.attr('selected-r') === 'true') {
            tr.attr('selected-r', 'true');
            rowClicked(tr[0])
        }
        oldTr.replaceWith(tr);
    } else {
        tableBody.append(tr);
    }
    addContextMenu(tr[0], arg.request.curl);
    if (!scrolLocked) {
        const tableElement = $('#table-container');
        tableElement.scrollTop(tableElement[0].scrollHeight);
    }

});

function unSetProxy() {
    ipcRenderer.send('stop-proxy', '');
    requestInterceptorEditor.updateOptions({readOnly: false});
    responseInterceptorEditor.updateOptions({readOnly: false});
    $('.form-control, input[type=checkbox]').not('button').prop('disabled', false);
}

$('.btn-toggle').click(function () {
    if (proxySet) {
        try {
            unSetProxy();
            proxySet = false;
        } catch (e) {
            return false;
        }
    } else {
        let setRes = true;
        try {
            setRes = setProxy()
        } catch (e) {
            return false
        }
        if (!setRes) {
            return false;
        }
        proxySet = true;
    }
    $(this).find('.btn').toggleClass('active');

    if ($(this).find('.btn-primary').length > 0) {
        $(this).find('.btn').toggleClass('btn-primary');
    }
    if ($(this).find('.btn-danger').length > 0) {
        $(this).find('.btn').toggleClass('btn-danger');
    }
    if ($(this).find('.btn-success').length > 0) {
        $(this).find('.btn').toggleClass('btn-success');
    }
    if ($(this).find('.btn-info').length > 0) {
        $(this).find('.btn').toggleClass('btn-info');
    }
    $(this).find('.btn').toggleClass('btn-default');

});
$('form').submit(function () {
    return false;
});

ipcRenderer.on('server-error', (event, arg) => {
    logger.info('got server error event');
    unSetProxy();
    proxySet = false;
    let btnGroup = $('#btn-group');
    btnGroup.find('.btn').toggleClass('active');

    if (btnGroup.find('.btn-primary').length > 0) {
        btnGroup.find('.btn').toggleClass('btn-primary');
    }
    if (btnGroup.find('.btn-danger').length > 0) {
        btnGroup.find('.btn').toggleClass('btn-danger');
    }
    if (btnGroup.find('.btn-success').length > 0) {
        btnGroup.find('.btn').toggleClass('btn-success');
    }
    if (btnGroup.find('.btn-info').length > 0) {
        btnGroup.find('.btn').toggleClass('btn-info');
    }
    btnGroup.find('.btn').toggleClass('btn-default');
    if (arg.code === 'EACCES' || arg.code === 'EADDRINUSE') {
        setInvalid("listenPort");
    }
});

function showHideRequestInterceptor() {
    $('#request-interceptor').toggle();
    let a = $('#hide-show-request-interceptor');
    if (a.text() == 'show') {
        a.text('hide');
        return
    }
    a.text('show');
}

function showHideResponseInterceptor() {
    $('#response-interceptor').toggle();
    let a = $('#hide-show-response-interceptor');
    if (a.text() == 'show') {
        a.text('hide');
        return
    }
    a.text('show');

}

function resetTable() {
    let tableBody = $('#traffic-table-body');
    tableBody.empty();
    traffic = {}
}

window.Split(['#table-container', '#details-component'], {
    direction: 'vertical',
    sizes: [50, 50],
    gutterSize: 8,
    cursor: 'row-resize',
    minSize: [50, 100]
});
const konami = [38, 38, 40, 40, 37, 39, 37, 39];
let konamiIdx = 0;
$(window).on('keydown', function (e) {
    let code = (e.keyCode ? e.keyCode : e.which);
    if (code === konami[konamiIdx]) {
        if (konamiIdx === konami.length - 1) {
            logger.info('KONAMI CODE!!');
            $('#overlay').toggle(true);
            setTimeout(function () {
                $('#overlay').toggle(false);
            }, 5000);
            konamiIdx = 0
        } else {
            konamiIdx++
        }
    }

});

function readFromLocalStorage() {
    const userSettingsRaw = localStorage.getItem('userSettings');
    if (!userSettingsRaw) {
        return;
    }
    let settings = JSON.parse(userSettingsRaw);
    if (settings) {
        $('#dest').val(settings.dest);
        $('#destProtocol').val(settings.destProtocol);
        $('#destPort').val(settings.destPort);
        $('#listenPort').val(settings.listenPort);
        $('#intercept-request')[0].checked = settings.interceptRequest;
        $('#intercept-response')[0].checked = settings.interceptResponse;
        return settings;
    }
}

function createInterceptorEditor(id, settings, text) {
    return monaco.editor.create(document.getElementById(id), {
        value: text,
        language: 'text/javascript',
        autoIndent: true,
        automaticLayout: true
    });
}

function setupInterceptors(settings) {
    let defaultRequestVal = "/*Request interceptor. Use javascript. \nYou can use requestParams object to access the request data. \nfollowing attributes are available for manipulation: host, path, method, port, headers and body\nExample: \nrequestParams.headers['custom']='custom val'*/";
    let defaultResponseVal = "/*Response interceptor. Use javascript. \nYou can use responseParams object to access the response data. \ncurrently supported attributes are statusCode, headers and body. Also the requestParams object is available for read \nExample: \nresponseParams.headers['custom']='custom val'*/";
    requestInterceptorEditor = createInterceptorEditor('request-interceptor', settings, settings && settings.requestInterceptor ? settings.requestInterceptor : defaultRequestVal);
    responseInterceptorEditor = createInterceptorEditor('response-interceptor', settings, settings && settings.responseInterceptor ? settings.responseInterceptor : defaultResponseVal);
}

$(document).ready(() => {
    $("[data-toggle=tooltip]").tooltip({
        placement: $(this).data("placement") || 'bottom'
    });
    registerCopyToClip();
});
editorLoadedEmitter.once('loaded', () => {
    let settings = readFromLocalStorage();
    setupInterceptors(settings);

    readOnlyEditors['request' + '-plain'] = createReadOnlyEditor($(`#request-body`), '', 'html', null);
    readOnlyEditors['request' + '-formatted'] = createReadOnlyEditor($(`#request-body-formatted`), '', 'json', null);
    readOnlyEditors['response' + '-plain'] = createReadOnlyEditor($(`#response-body`), '', 'css', null);
    readOnlyEditors['response' + '-formatted'] = createReadOnlyEditor($(`#response-body-formatted`), '', 'javascript', null);

});

function registerCopyToClip() {
    let headersElement = $(`#request-headers`);
    let bodyElement = $(`#request-body`);
    let formattedBodyElement = $(`#request-body-formatted`);
    addCopyToClipInternalText(headersElement);
    addCopyToClipInternalTextEditor(formattedBodyElement, 'request-formatted');
    addCopyToClipInternalTextEditor(bodyElement, 'request-plain');

    headersElement = $(`#response-headers`);
    bodyElement = $(`#response-body`);
    formattedBodyElement = $(`#response-body-formatted`);
    addCopyToClipInternalText(headersElement);
    addCopyToClipInternalTextEditor(formattedBodyElement, 'response-formatted');
    addCopyToClipInternalTextEditor(bodyElement, 'response-plain');
}


ipcRenderer.on('reset-cache', (event, arg) => {
    localStorage.clear()
});