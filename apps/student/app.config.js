// Adds Firebase (instant push notifications) to the build when google-services.json is present.
// CI writes that file from the GOOGLE_SERVICES_JSON repository secret; without it the app builds
// exactly the same and checks for news itself.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) =>
  fs.existsSync(path.join(__dirname, 'google-services.json')) ? { ...config, android: { ...config.android, googleServicesFile: './google-services.json' } } : config;
