const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The crypto self-test reads the Go-generated vectors, which live with the
// desktop sync code outside this project.
config.watchFolders = [path.resolve(__dirname, '../internal/integrations/neonsync/testdata')];

module.exports = config;
