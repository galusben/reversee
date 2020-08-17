const {Menu} = require('electron');
const pkg = require('./../package.json');
const about = require('about-window').default;
const join = require('path').join;
const certs = require(join(__dirname, 'certs', 'cert'));
const license = require(join(__dirname,'licence.js'));

Menu.prototype.getMenuItemById = function (id) {
    const items = this.items;
    let found = items.find(item => item.id === id) || null;
    for (let i = 0; !found && i < items.length; i++) {
        if (items[i].submenu) {
            found = items[i].submenu.getMenuItemById(id)
        }
    }
    return found
};

function create(breakpointsEditWin, main, licenceWindow) {

    const template = [
        {
            label: 'Edit',
            submenu: [
                {
                    role: 'undo'
                },
                {
                    role: 'redo'
                },
                {
                    type: 'separator'
                },
                {
                    role: 'cut'
                },
                {
                    role: 'copy'
                },
                {
                    role: 'paste'
                },
                {
                    role: 'pasteandmatchstyle'
                },
                {
                    role: 'delete'
                },
                {
                    role: 'selectall'
                }
            ]
        },
        {
            label: 'Breakpoints',
            submenu: [
                {
                    label: 'Edit',
                    accelerator: 'CmdOrCtrl+B',
                    click(item, focusedWindow) {
                        console.log('Breakpoints clicked');
                        breakpointsEditWin.show();
                    }
                },
                {
                    label: 'Toggle Developer Tools',
                    accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
                    click(item, focusedWindow) {
                        if (focusedWindow) focusedWindow.webContents.toggleDevTools()
                    }
                }]
        },
        {
            label: 'Proxy Settings',
            submenu: [
                {
                    label: 'Rewrite Redirects (3xx)',
                    type: 'checkbox',
                    checked: true,
                    id: 'redirects'
                },
                {
                    label: 'Rewrite host',
                    type: 'checkbox',
                    checked: true,
                    id: 'host'
                },
                {
                    label: 'Reset Cache',
                    id: 'reset',
                    click() {
                        main.webContents.send('reset-cache', {})
                    }
                },
                {
                    label: 'Export Root Cert',
                    id: 'reset',
                    click() {
                        certs.downloadRoot(main);
                    }
                }
            ]
        },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click(item, focusedWindow) {
                        if (focusedWindow) focusedWindow.reload()
                    }
                },
                {
                    label: 'Toggle Developer Tools',
                    accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
                    click(item, focusedWindow) {
                        if (focusedWindow) focusedWindow.webContents.toggleDevTools()
                    }
                },
                {
                    type: 'separator'
                },
                {
                    role: 'resetzoom'
                },
                {
                    role: 'zoomin'
                },
                {
                    role: 'zoomout'
                },
                {
                    type: 'separator'
                },
                {
                    role: 'togglefullscreen'
                }
            ]
        },
        {
            role: 'window',
            submenu: [
                {
                    role: 'minimize'
                },
                {
                    role: 'close'
                }
            ]
        },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Learn More',
                    click() {
                        require('electron').shell.openExternal('https://reversee.ninja')
                    }
                },
                {
                    label: 'About Reversee',
                    click: function () {
                        let productName = 'Reversee';
                        if (license.isPro()) {
                            productName = 'Reversee - Pro'
                        }
                        const aboutWin = about(
                            {
                                product_name : productName,
                                icon_path: join(__dirname, 'assets', 'Reversee.png'),
                                use_version_info: false,
                                win_options: {show: false}
                            }
                        );
                        aboutWin.on('ready-to-show', function () {
                            aboutWin.show();
                            aboutWin.focus();
                        });
                    }
                },
                {
                    label: 'Enter License',
                    click() {
                        console.log('Licence window clicked');
                        licenceWindow.show();
                    }
                }
            ]
        }
    ];

    if (process.platform === 'darwin') {
        const name = pkg.name;
        template.unshift({
            label: name,
            submenu: [
                {
                    role: 'about'
                },
                {
                    type: 'separator'
                },
                {
                    role: 'services',
                    submenu: []
                },
                {
                    type: 'separator'
                },
                {
                    role: 'hide'
                },
                {
                    role: 'hideothers'
                },
                {
                    role: 'unhide'
                },
                {
                    type: 'separator'
                },
                {
                    role: 'quit'
                }
            ]
        });
        // Edit menu.
        template[1].submenu.push(
            {
                type: 'separator'
            },
            {
                label: 'Speech',
                submenu: [
                    {
                        role: 'startspeaking'
                    },
                    {
                        role: 'stopspeaking'
                    }
                ]
            }
        );
        // Proxy
        const opsys = process.platform;
        if (opsys == "darwin") {
            template[3].submenu.push(
                {
                    label: 'Manage Root Cert',
                    id: 'reset',
                    click() {
                        certs.certificateTrustDialog(main);
                    }
                });
        }
    }
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

exports.create = create;
exports.getMenuInstance = function () {
    return Menu.getApplicationMenu()
};