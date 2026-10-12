// Development-only: reuse the established fixture HTTP guard. The environment
// firewall must also deny business service hosts; this is not a security sandbox.
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const { isLoopbackHostname } = require('../date-companion-e2e-network-guard.cjs');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = options && typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host && !isLoopbackHostname(host)) throw Error('Cloud development external socket blocked');
  return connect.apply(this, args);
};
syncBuiltinESMExports();
