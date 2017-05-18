const {ipcRenderer} = require('electron');

function continu(){
    ipcRenderer.send('continue', {url: $('#url').val()});
}

ipcRenderer.on('breaking', (event, arg) => {
    $( document ).ready(function() {
        console.log('got break: ' + arg);
        $('#url').val(arg.url)
    });
});