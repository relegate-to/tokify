const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

// The crypto check reads the Go-generated vectors, which live with the desktop
// sync code outside this project.
config.watchFolders = [path.resolve(__dirname, '../internal/integrations/neonsync/testdata')];

module.exports = withUniwindConfig(config, {
    cssEntryFile: './src/global.css',
    dtsFile: './uniwind-types.d.ts',
});
