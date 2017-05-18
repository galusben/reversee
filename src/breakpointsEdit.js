const {ipcRenderer} = require('electron');

const breakpoints = [];

function hideBreakPointsWindow() {
    ipcRenderer.send('breakpoints-settings', breakpoints);
}

function add(){
    var methods = $('#method').val();
    var path = $('#path').val();
    breakpoints.push({methods, path});
    console.log(breakpoints[0]);
}

