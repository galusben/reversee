const {ipcRenderer} = require('electron');

let breakpoints = {};

function hideBreakPointsWindow() {
    ipcRenderer.send('breakpoints-settings', breakpoints);
}

ipcRenderer.on('breakpoints-settings-update', (data) => {
    breakpoints = data;
    drawTable()
});

function add() {
    let methods = $('#method').val();
    let path = $('#path').val();
    const point = new BreakPointConfig(methods, path);
    let tbody = $('#breakpoints-table').children('tbody');
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
    row.attr('breakid', point.id);
    tbody.append(
        row
    );
}
function deleteRow(clickedElement) {
    let icon = $(clickedElement);
    let row = icon.closest('tr');
    let breakpointId = row.attr("breakid");
    row.remove();
    delete breakpoints[breakpointId]
}
function drawTable() {
    let tbody = $('#breakpoints-table').children('tbody');
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