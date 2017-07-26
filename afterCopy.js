const uglifyJS = require("uglify-es");
const fs = require("fs");
const path = require("path");
console.log("Loading custom after copy");

module.exports = function (buildPath, electronVersion, platform, arch, callback) {
    console.log("Running custom after copy");
    console.log(buildPath);
    console.log(electronVersion);
    console.log(platform);
    console.log(arch);
    const sourcePath = path.join(buildPath, 'src');
    const items = fs.readdirSync(sourcePath);

    console.log(items);
    for (let i = 0; i < items.length; i++) {
        console.log(items[i]);
        const filePath = path.join(sourcePath, items[i]);
        if (fs.lstatSync(filePath).isFile() && filePath.endsWith('.js')) {
            const contentBeforeMinify = fs.readFileSync(filePath, 'utf8');
            const mini = uglifyJS.minify(contentBeforeMinify, { warnings: true, mangle: {toplevel: true} });
            if (mini.error) {
                return callback(mini.error);
            }
            fs.writeFileSync(filePath, mini.code)
        }
    }


    return callback();
};