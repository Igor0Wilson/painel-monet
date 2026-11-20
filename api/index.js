const vercelModule = require('../dist/vercel');
const handler = vercelModule.default || vercelModule;

module.exports = handler;
