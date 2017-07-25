const {ipcRenderer, remote, clipboard} = require('electron');
const {Menu, MenuItem} = remote;


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

var proxySet = false;
var traffic = {};

const requestInterceptorEditor = CodeMirror(document.getElementById("request-interceptor"), {
    value: "/*Request interceptor. Use javascript. \nYou can use requestParams object to access the request data. \nExample: \nrequestParams.headers['custom']='custom val'*/",
    mode: "javascript",
    lineNumbers: true,
});
$(requestInterceptorEditor.getWrapperElement()).hide();

const responseInterceptorEditor = CodeMirror(document.getElementById("response-interceptor"), {
    value: "/*Response interceptor. Use javascript. \nYou can use responseParams object to access the response data. \nExample: \nresponseParams.headers['custom']='custom val'*/",
    mode: "javascript",
    lineNumbers: true,
});
$(responseInterceptorEditor.getWrapperElement()).hide();

function setDirection(direction, element) {
    $(`#${direction}-headers`).empty();
    $(`#${direction}-body`).empty();
    let trafficKey = $(element).attr('trafficId');
    var body = $('<pre>').text(traffic[trafficKey][direction].body);
    var headersText = '';
    var headersMap = traffic[trafficKey][direction].headers;
    for (let key in headersMap) {
        headersText += key + " : " + headersMap[key] + "\n";
    }
    var headers = $('<pre>').text(headersText);
    $(`#${direction}-headers`).append(headers);
    $(`#${direction}-body`).append(body);
}

function rowClicked(element) {
    setDirection('response', element);
    setDirection('request', element);
    $('.font-bold').removeClass('font-bold');
    $(element).addClass('font-bold');
    $("[selected-r='true']").attr('selected-r', 'false')
    $(element).attr('selected-r', 'true');
}

function setProxy() {
    var settings = {
        dest: document.getElementById("dest").value,
        destProtocol: document.getElementById("destProtocol").value,
        destPort: document.getElementById("destPort").value || (document.getElementById("destProtocol").value == 'http' ? '80' : '443'),
        listenPort: document.getElementById("listenPort").value,
        listenProtocol: document.getElementById("listenProtocol").value,
        requestInterceptor: $('#intercept-request').is(':checked') ? requestInterceptorEditor.getValue() : '',
        responseInterceptor: $('#intercept-response').is(':checked') ? responseInterceptorEditor.getValue() : ''
    };
    $('.ng-invalid').removeClass('ng-invalid');
    var validations = [];
    $('.form-control').not("[optional='true']").map(function (index, element) {
        validations.push(notifyInvalid(element.id))
    });
    var valid = true;
    for (var i = 0; i < validations.length; i++) {
        valid = valid && validations[i].valid;
    }
    if (!valid) {
        return false;
    }
    $('.form-control, input[type=checkbox]').not('button').prop('disabled', 'true');
    requestInterceptorEditor.setOption("readOnly", true);
    ipcRenderer.send('message-settings', settings);


    $('#traffic-table-body').on('click', 'tr', function (event) {
        rowClicked(this);
    });
    return true;
}

function notifyInvalid(id) {
    let jqueryId = $(`#${id}`);
    var val = jqueryId.val();
    if (!val || val.length <= 0) {
        jqueryId.addClass('ng-invalid');
        return {valid: false};
    }
    return {valid: true};
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

var scrolLocked = true;
function toggleScollLock() {
    const lockIcon = $('#scroll-lock');
    if (scrolLocked) {
        lockIcon.removeClass('fa fa-lock')
        lockIcon.addClass('fa')
        lockIcon.addClass('fa-unlock-alt')
    } else {
        lockIcon.removeClass('fa fa-unlock-alt')
        lockIcon.addClass('fa fa-lock')
        lockIcon.addClass('fa-lock')
    }
    scrolLocked = !scrolLocked;
}

ipcRenderer.on('trip-data', (event, arg) => {
    traffic[arg.trafficId] = arg;
    var tableBody = $('#traffic-table-body');
    var statusCode = arg.response.statusCode;
    var tr = $(`<tr class="${getClassForTripData(statusCode)}">` +
        '<td></td>' +
        '<td>' + arg.request.method + '</td>' +
        '<td>' + arg.request.url + '</td>' +
        '<td>' + arg.response.statusCode + '</td>' +
        '<td>' + (arg.response.headers["content-type"] ? arg.response.headers["content-type"] : '') + '</td>' +
        '</tr>');
    tr.attr('trafficId', arg.trafficId);
    var oldTr = $(`[trafficId='${arg.trafficId}']`);
    if (oldTr.length > 0) {
        if (oldTr.attr('selected-r') == 'true') {
            tr.attr('selected-r', 'true');
            rowClicked(tr[0])
        }
        oldTr.replaceWith(tr);
    } else {
        tableBody.append(tr);
    }
    addContextMenu(tr[0], arg.request.curl);
    if(!scrolLocked) {
        const tableElement = $('#table-container');
        tableElement.scrollTop(tableElement[0].scrollHeight);
    }

});

function unSetProxy() {
    ipcRenderer.send('stop-proxy', '');
    $('.form-control, input[type=checkbox]').not('button').prop('disabled', false);
    requestInterceptorEditor.setOption("readOnly", false)

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
        var setRes = true;
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
    console.log('server error');
    unSetProxy();
    proxySet = false;
    var btnGroup = $('#btn-group');
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
});

function showHideRequestInterceptor() {
    $(requestInterceptorEditor.getWrapperElement()).toggle();
    let a = $('#hide-show-request-interceptor');
    if (a.text() == 'show') {
        a.text('hide');
        return
    }
    a.text('show');
}

function showHideResponseInterceptor() {
    $(responseInterceptorEditor.getWrapperElement()).toggle();
    let a = $('#hide-show-response-interceptor');
    if (a.text() == 'show') {
        a.text('hide');
        return
    }
    a.text('show');

}

function resetTable() {
    var tableBody = $('#traffic-table-body');
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
    var code = (e.keyCode ? e.keyCode : e.which);
    if (code == konami[konamiIdx]) {
        if (konamiIdx == konami.length - 1) {
            console.log('KONAMI CODE!!');
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