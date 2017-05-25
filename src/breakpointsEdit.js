const {ipcRenderer} = require('electron');

const breakpoints = [];

function hideBreakPointsWindow() {
    ipcRenderer.send('breakpoints-settings', breakpoints);
}

function add(){
    var methods = $('#method').val();
    var path = $('#path').val();
    const point = {methods, path};
    breakpoints.push(point);
    var tbody = $('#breakpoints-table').children('tbody');
    drawLine(tbody, point)
}

function drawLine(tbody, point) {
    tbody.append(
        $(`<tr><td></td><td>${point.path}</td><td>${point.methods.join(', ')}</td></tr>`)
    );
}
function drawTable() {
    var tbody = $('#breakpoints-table').children('tbody');
    for (var i = 0; i < breakpoints.length; i++) {
        let point = breakpoints[i];
        extracted(tbody, point);
    }
}
