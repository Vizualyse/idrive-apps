// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 小白151 (JackieZ123430)
/* Appended after the original controller script. No handlers or protocol
 * payloads are replaced; updates to visible text are translated as they arrive. */
(function () {
    'use strict';
    const translate = createTranslator(VIZUALYSE_ZH_CN);
    const ignored = /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/;
    function visit(node) {
        if (node.nodeType === 3) {
            if (node.parentNode && ignored.test(node.parentNode.nodeName)) return;
            const text = translate(node.nodeValue);
            if (text !== node.nodeValue) {
                const parent = node.parentNode;
                if (parent && parent.nodeName === 'OPTION' && !parent.hasAttribute('value')) {
                    parent.setAttribute('value', parent.value);
                }
                node.nodeValue = text;
            }
        } else if (node.nodeType === 1) {
            if (ignored.test(node.nodeName)) return;
            ['placeholder', 'title', 'aria-label'].forEach((key) => {
                const text = node.getAttribute(key);
                if (text) { const result = translate(text); if (result !== text) node.setAttribute(key, result); }
            });
            Array.prototype.slice.call(node.childNodes).forEach(visit);
        }
    }
    document.documentElement.lang = 'zh-CN';
    visit(document.documentElement);
    new MutationObserver((changes) => changes.forEach((change) => {
        if (change.type === 'childList') Array.prototype.slice.call(change.addedNodes).forEach(visit);
        else visit(change.target);
    })).observe(document.body, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
})();
