// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool's deactivate hook (component.json): its firewall rule removed
 * (firewall.js), its games' swap file on the hard disk off and deleted
 * (swap.js).
 *
 *   node deactivate.js
 */
'use strict';

let n = 0;
try { n = require('./firewall.js').remove(); } catch (e) { console.error('firewall: ' + e.message); }
let s = 0;
try { s = require('./swap.js').remove(); } catch (e) { console.error('swap: ' + e.message); }
console.log('deactivate: ' + n + ' firewall rule(s), ' + s + ' swap file(s) removed');
