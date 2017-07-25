const {ipcRenderer} = require('electron');

var breakpoints = {};

function hideBreakPointsWindow() {
    ipcRenderer.send('breakpoints-settings', breakpoints);
}

ipcRenderer.on('breakpoints-settings-update', (data) => {
    breakpoints = data;
    drawTable()
});

function add() {
    var methods = $('#method').val();
    var path = $('#path').val();
    const point = new BreakPointConfig(methods, path);
    var tbody = $('#breakpoints-table').children('tbody');
    if (!breakpoints[point.id]) {
        breakpoints[point.id] = point;
        drawLine(tbody, point)
    }
}

function drawLine(tbody, point) {
    const row = $(`<tr>
         <td></td>
         <td>${point.path}</td>
         <td>${point.methods.join(', ')}</td>
         <td><i class="fa fa-trash table-action" aria-hidden="true" onclick="deleteRow(this)" title="Remove Breakpoint"></i></td>
         </tr>`);
    row.attr('breakid', point.id)
    tbody.append(
        row
    );
}
function deleteRow(clickedElement) {
    let icon = $(clickedElement);
    var row = icon.closest('tr');
    var breakpointId = row.attr("breakid");
    row.remove();
    delete breakpoints[breakpointId]
}
function drawTable() {
    var tbody = $('#breakpoints-table').children('tbody');
    tbody.empty();
    for (let key in breakpoints) {
        let point = breakpoints[key];
        drawLine(tbody, point);
    }
}

class BreakPointConfig {
    static calcId(methods, path) {
        return methods.join("") + path
    }

    constructor(methods, path) {
        this.methods = methods || [];
        this.path = path || '';
        this.id = BreakPointConfig.calcId(methods, path)
    }
}