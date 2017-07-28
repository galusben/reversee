const {ipcRenderer} = require('electron');

let breakPoint;

function continu() {
    let headers = {};

    $('#headers-table').children('tbody').children('tr').each(function (i, tr) {
        let headerName = $($(tr).children('td')[1]).text();
        let headerValue = $($(tr).children('td')[2]).text();
        if (headerName) {
            headers[headerName] = headerValue;
        }
    });

    ipcRenderer.send('continue', {
        id: breakPoint.id,
        url: $('#url').val(),
        method: $('#method').val(),
        headers: headers,
        body: $('#body').val()
    });
}

function addRow() {

    $('#headers-table').children('tbody').append(
        $('<tr><td></td><td contenteditable="true"></td><td contenteditable="true"></td></tr>')
    );
}

ipcRenderer.on('breaking', (event, arg) => {
    $('#url').val(arg.url);
    $('#method').val(arg.method);
    let tbody = $('#headers-table').children('tbody');
    let headers = arg.headers;
    for (let key in headers) {
        tbody.append(
            $(`<tr><td></td><td contenteditable="true">${key}</td><td contenteditable="true">${headers[key]}</td></tr>`)
        );
    }
    $('#body').val(arg.body);
    breakPoint = arg;
});