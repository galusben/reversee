var proxySet = false;
var traffic = [];
const {ipcRenderer} = require('electron');
function setProxy() {
    var settings = {
        dest: document.getElementById("dest").value,
        destProtocol: document.getElementById("destProtocol").value,
        destPort: document.getElementById("destPort").value,
        listenPort: document.getElementById("listenPort").value,
        listenProtocol: document.getElementById("listenProtocol").value
    };
    $('.ng-invalid').removeClass('ng-invalid');
    var validations = [];
    $('.form-control').map(function (index, element) {
        validations.push(notifyInvalid(element.id))
    });
    console.log(validations);
    var valid = true;
    for (var i = 0; i < validations.length; i++) {
        console.log('i: ' + i);
        valid = valid && validations[i].valid;
    }
    if (!valid) {
        return false;
    }
    $('.form-control').not('button').prop('disabled', 'true');
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
    var val = $(`#${id}`).val();
    if (!val || val.length <= 0) {
        $(`#${id}`).addClass('ng-invalid');
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
    traffic.push(arg)
});

function unSetProxy() {
    ipcRenderer.send('stop-proxy', '');
    $('.form-control').not('button').prop('disabled', false);

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

});