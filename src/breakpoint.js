const {ipcRenderer} = require('electron');

var breakPoint;

function continu() {
    var headers = {};

    $('#headers-table').children('tbody').children('tr').each(function (i, tr) {
        var headerName = $($(tr).children('td')[1]).text();
        var headerValue = $($(tr).children('td')[2]).text();
        headers[headerName] = headerValue;
    });

    ipcRenderer.send('continue', {
        id: breakPoint.id,
        url: $('#url').val(),
        method: $('#method').val(),
        headers: headers
    });
}

ipcRenderer.on('breaking', (event, arg) => {
    $('#url').val(arg.url);
    $('#method').val(arg.method);
    var tbody = $('#headers-table').children('tbody');
    var headers = arg.headers;
    for (key in headers) {
        tbody.append($(`<tr><td></td><td contenteditable="true">${key}</td><td contenteditable="true">${headers[key]}</td></tr>`));
    }
    breakPoint = arg;
});