// Keep Metro (the native app bundler) out of the separate web app in ./web.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Matches <project>/web/... (Metro passes native, absolute paths).
config.resolver.blockList = [new RegExp(`^${escape(path.join(__dirname, 'web'))}[\\\\/]`)];

module.exports = config;
