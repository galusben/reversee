const {ipcRenderer, remote, clipboard} = require('electron');
const {Menu, MenuItem} = remote;


function addContextMenu(element, curl) {
    const menu = new Menu();
    menu.append(new MenuItem({label: 'Copy as curl', click(a) { clipboard.writeText(curl) }}));
    element.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        menu.popup(remote.getCurrentWindow());
    }, false);
}

var proxySet = false;
var traffic = [];


const input = document.getElementById('request-interceptor');
const codeMirror = CodeMirror(document.getElementById("request-interceptor"), {
    value: "/*Request interceptor. Use javascript. \nYou can use requestParams object to access the request data. \nExample: \nrequestParams.headers['custom']='custom val'*/\nvar a = 5; \n   var b=2",
    mode:  "javascript",
    lineNumbers: true,
});
$(codeMirror.getWrapperElement()).hide();


function setProxy() {
    var settings = {
        dest: document.getElementById("dest").value,
        destProtocol: document.getElementById("destProtocol").value,
        destPort: document.getElementById("destPort").value,
        listenPort: document.getElementById("listenPort").value,
        listenProtocol: document.getElementById("listenProtocol").value,
        requestInterceptor: $('#intercept-request').is(':checked') ? codeMirror.getValue() : ''
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
    codeMirror.setOption("readOnly", true)
    ipcRenderer.send('message-settings', settings);
    function setDirection(direction, element) {
        $(`#${direction}-headers`).empty();
        $(`#${direction}-body`).empty();
        var body = $('<pre>').text(traffic[$(element).index()][direction].body);
        var headersText = '';
        var headersMap = traffic[$(element).index()][direction].headers;
        for (key in headersMap) {
            headersText += key + " : " + headersMap[key] + "\n";
        }
        var headers = $('<pre>').text(headersText);
        $(`#${direction}-headers`).append(headers);
        $(`#${direction}-body`).append(body);
    }

    $('#traffic-table-body').on('click', 'tr', function (event) {
        setDirection('response', this);
        setDirection('request', this);
        $('.font-bold').removeClass('font-bold');
        $(this).addClass('font-bold');

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

ipcRenderer.on('trip-data', (event, arg) => {
    var tableBody = $('#traffic-table-body');
    var statusCode = arg.response.statusCode;
    var tr = $(`<tr class="${getClassForTripData(statusCode)}">` +
        '<td>' + $("#traffic-table-body tr").length + '</td>' +
        '<td>' + arg.request.method + '</td>' +
        '<td>' + arg.request.url + '</td>' +
        '<td>' + arg.response.statusCode + '</td>' +
        '<td>' + (arg.response.headers["content-type"] ? arg.response.headers["content-type"] : arg.response.headers["Content-Type"]) + '</td>' +
        '</tr>');
    tableBody.append(tr);
    addContextMenu(tr[0], arg.request.curl);
    traffic.push(arg);
});

function unSetProxy() {
    ipcRenderer.send('stop-proxy', '');
    $('.form-control, input[type=checkbox]').not('button').prop('disabled', false);
    codeMirror.setOption("readOnly", false)

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

    var intercept = $('#intercept-request').is(':checked');
    if(intercept) {
        $(codeMirror.getWrapperElement()).show();
    } else {
        $(codeMirror.getWrapperElement()).hide();
    }
}

function resetTable() {
    var tableBody = $('#traffic-table-body');
    tableBody.empty()
}