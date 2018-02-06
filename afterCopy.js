const uglifyJS = require("uglify-es");
const fs = require("fs");
const path = require("path");
console.log("Loading custom after copy");

module.exports = function (context) {
    console.log(context);
    const buildPath = context.appOutDir;
    console.log("Running custom after copy");
    const sourcePath = path.join(buildPath, 'src');
    const items = fs.readdirSync(sourcePath);

    console.log(items);
    for (let i = 0; i < items.length; i++) {
        console.log(items[i]);
        const filePath = path.join(sourcePath, items[i]);
        if (fs.lstatSync(filePath).isFile() && filePath.endsWith('.js')) {
            const contentBeforeMinify = fs.readFileSync(filePath, 'utf8');
            const mini = uglifyJS.minify(contentBeforeMinify, { warnings: true, keep_fnames:true, mangle: {toplevel: true} });
            if (mini.error) {
                return callback(mini.error);
            }
            fs.writeFileSync(filePath, mini.code)
        }
    }
};