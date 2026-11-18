// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 小白151 (JackieZ123430)
'use strict';
/* Translate only at display boundaries. Commands, paths and stored settings
 * remain the original protocol values. Also used in the phone page. */
function createTranslator(dictionary) {
    const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(keys.map(escape).join('|'), 'g');
    return function translate(value) {
        if (typeof value !== 'string' || !value) return value;
        if (Object.prototype.hasOwnProperty.call(dictionary, value)) return dictionary[value];
        // Do not translate addresses, filenames, tokens, or user-entered URLs.
        return value.split(/(https?:\/\/[^\s<>]+|\/[A-Za-z0-9_.-]+\/[\S]+|\b[a-z_]+\.(?:js|json|tgz|html)\b)/g).map((part, index) => {
            if (index % 2) return part;
            return part.replace(re, (match, offset, input) => {
                if (/^[A-Za-z]/.test(match) && offset && /[A-Za-z]/.test(input[offset - 1])) return match;
                if (/[A-Za-z]$/.test(match) && /[A-Za-z]/.test(input[offset + match.length] || '')) return match;
                return dictionary[match];
            });
        }).join('');
    };
}
if (typeof module !== 'undefined') module.exports = { createTranslator };
