// amsrc.js: the audio manager from root, for making our sound a real
// entertainment source (the iDrive volume on it, no CarPlay needed).
//
//   node amsrc.js IFACEDIR list            sources, sinks, connections
//   node amsrc.js IFACEDIR owners          which AmSourceControl owners are offered
//   node amsrc.js IFACEDIR serve [opts]    own a source, register it, connect it
//
// IFACEDIR holds CommandControl.json, RoutingControlObserver.json and
// AmSourceControl.json (tools/someip_iface.py from the unit's catalog; BMW
// definitions: never committed). knowledge/sound.md has the why.
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var path = require('path');
var someip = require('/usr/lib/someip.node');

var a = process.argv.slice(2);
var dir = a[0], cmd = a[1];
var opt = {};
a.slice(2).forEach(function (s) { var m = /^--([^=]+)=?(.*)$/.exec(s); if (m) opt[m[1]] = m[2] === '' ? true : m[2]; });
var T = 15000;
function iface(n) { return require(path.resolve(dir, n + '.json')); }
function log(s) { console.log(new Date().toISOString().slice(11, 23) + ' ' + s); }
function J(x) { return JSON.stringify(x); }

// a proxy once its service is up; waitUntilAvailable alone never gives up
// on a service that isn't offered, or one our uid may not see
function proxy(name, inst, wait) {
  return someip.buildProxy(iface(name), inst).then(function (p) {
    return new Promise(function (ok, fail) {
      var t = setTimeout(function () { fail(new Error(name + ' ' + inst + ' not available')); }, wait || T);
      p.init()
        .then(function () { return p.subscribeToAvailability(function (up) { if (up) { clearTimeout(t); ok(p); } }); })
        .then(function () { return p.waitUntilAvailable(wait || T); })
        .then(function () { clearTimeout(t); ok(p); }, function () {});
    });
  });
}

// root's side: the connection, and availability by hand (a sink the
// emulator has no hardware for)
function connect() {
  return proxy('CommandControl', '1').then(function (cc) {
    return cc.callMethod('connect', { sourceID: +opt.src, sinkID: +(opt.sink || 1024) }, T);
  }).then(function (r) { log('connect ' + J(r)); });
}
function disconnect() {
  return proxy('CommandControl', '1').then(function (cc) {
    return cc.callMethod('disconnect', { mainConnectionID: +opt.id }, T);
  }).then(function (r) { log('disconnect ' + J(r)); });
}
// the iDrive volume: --step=N (what a knob detent does) or --set=N, on a
// main sink (MainSink 1 by default); --get reads it
function volume() {
  var sink = +(opt.sink || 1);
  return proxy('CommandControl', '1').then(function (cc) {
    var call = opt.step !== undefined ? cc.callMethod('volumeStep', { sinkID: sink, step: +opt.step }, T)
      : opt.set !== undefined ? cc.callMethod('setVolume', { sinkID: sink, volume: +opt.set }, T)
      : Promise.resolve();
    return call.then(function (r) { if (r) log('volume ' + J(r)); return cc.callMethod('getVolume', { sinkID: sink }, T); });
  }).then(function (r) { log('sink ' + sink + ' volume ' + J(r)); });
}
function hook() {
  var av = { availability: opt.off ? 'A_UNAVAILABLE' : 'A_AVAILABLE', availabilityReason: 0 };
  return proxy('RoutingControlObserver', '1').then(function (o) {
    return opt.sink !== undefined
      ? o.callMethod('hookSinkAvailablityStatusChange', { sinkID: +opt.sink, availability: av }, T)
      : o.callMethod('hookSourceAvailablityStatusChange', { sourceID: +opt.src, availability: av }, T);
  }).then(function (r) { log('hook ' + J(r)); });
}

function list() {
  return proxy('CommandControl', '1').then(function (cc) {
    return ['getListMainSources', 'getListMainSinks', 'getListMainConnections'].reduce(function (pr, m) {
      return pr.then(function () { return cc.callMethod(m, {}, T); }).then(function (r) {
        log(m); console.log(JSON.stringify(r, null, 1));
      });
    }, Promise.resolve());
  });
}

// every AmSourceControl instance of the catalog, offered or not
function owners() {
  var cfg = iface('AmSourceControl');
  var names = opt.only ? opt.only.split(',') : Object.keys(INSTANCES);
  return names.reduce(function (pr, n) {
    return pr.then(function () {
      return someip.buildProxy(cfg, n)
        .then(function (p) { return p.init().then(function () { return p.subscribeToAvailability(function () {}); }).then(function () { return p; }); })
        .then(function (p) {
          return new Promise(function (ok) {
            var t = setTimeout(function () { log('absent  ' + n); ok(); }, +opt.wait || 1500);
            p.waitUntilAvailable(+opt.wait || 1500).then(function () {
              clearTimeout(t);
              return p.getValue('SourceAvailabilities', 3000).then(function (v) { log('offered ' + n + ' ' + J(v)); }, function (e) { log('offered ' + n + ' (get failed: ' + e + ')'); });
            }, function () {}).then(ok);
          });
        });
    });
  }, Promise.resolve());
}

// the catalog's instance names (someip-interfaces.json instanceIDs)
var INSTANCES = {};
try { INSTANCES = require(path.resolve(dir, 'AmSourceControl.instances.json')); } catch (e) { /* owners --only= */ }

var cmds = { list: list, owners: owners, connect: connect, disconnect: disconnect, hook: hook, volume: volume };
if (!cmds[cmd] && cmd !== 'serve') { console.error('usage: amsrc.js IFACEDIR list|owners|connect|disconnect|hook|volume|serve'); process.exit(64); }
// --uid=4100 --gid=4150: see what that uid sees (owners are visible to the
// routing adapter's and the media app's uids only)
if (opt.uid && cmd !== 'serve') { process.setgroups([+opt.gid]); process.setgid(+opt.gid); process.setuid(+opt.uid); }
setImmediate(function () {
  (cmd === 'serve' ? require('./serve.js')(opt, { proxy: proxy, iface: iface, log: log, someip: someip }) : cmds[cmd]())
    .then(function (keep) { if (!keep) process.exit(0); })
    .catch(function (e) { console.error('amsrc: ' + (e && e.stack || e)); process.exit(1); });
});
