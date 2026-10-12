// Test only: use a public resolver inside this process while router DNS propagates.
// No system DNS settings or hosts files are changed.
import dns from 'node:dns';
const original = dns.lookup.bind(dns);
const resolver = new dns.Resolver(); resolver.setServers(['1.1.1.1', '8.8.8.8']);
dns.lookup = function(hostname, options, callback) {
  if (hostname !== 'app.chatgptee.ai') return original(hostname, options, callback);
  if (typeof options === 'function') { callback = options; options = {}; }
  resolver.resolve4(hostname, (error, addresses) => {
    if (error) { callback(error); return; }
    if (options?.all) callback(null, addresses.map(address => ({ address, family: 4 })));
    else callback(null, addresses[0], 4);
  });
};
process.argv[2] = 'https://app.chatgptee.ai'; process.argv.push('--public-dns');
await import('./verify-desktop-relay.ts');
