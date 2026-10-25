// Ported from CopilotKit OpenIntelligentUI (MIT, Copyright (c) Atai Barkai).
// The generated-UI iframe loads this document from its own URL instead of
// `srcdoc`, because a srcdoc frame inherits the host page's strict CSP. The
// iframe is created with `sandbox="allow-scripts"` only (opaque origin, no
// same-origin access, no forms, popups or top navigation), and this document
// carries its own CSP that only allows the CDN origins generated code uses.
import {
  FORM_STYLES_WITH_STAGGER_CSS,
  IMPORTMAP_SCRIPT_TAG,
  SVG_CLASSES_CSS,
  THEME_CSS,
} from './design-system.js';
import { TRIP_ANIMATOR_SCRIPT } from './trip-animator.js';

export const SANDBOX_FRAME_PATH = '/sandbox/ogui-frame';

const CDN_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
];

export const SANDBOX_FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDN_ORIGINS.join(' ')}`,
  `style-src 'unsafe-inline' ${CDN_ORIGINS.join(' ')}`,
  'img-src data: blob: https://basemap.nationalmap.gov https://upload.wikimedia.org https://thumb.wikimedia.org',
  `font-src data: ${CDN_ORIGINS.join(' ')}`,
  `connect-src ${CDN_ORIGINS.join(' ')}`,
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

export const DESIGN_SYSTEM_CSS = `${THEME_CSS}\n${SVG_CLASSES_CSS}\n${FORM_STYLES_WITH_STAGGER_CSS}`;

// Mounts a complete generated document into the already-initialised sandbox
// without replacing the Websandbox bridge. Scripts are re-created so they run
// in document order (inline scripts synchronously, external ones in order).
export const MOUNT_JS = `
window.__oguiMount = function (css, html) {
  var doc = new DOMParser().parseFromString(html, 'text/html');
  if (css) {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
  var nodes = Array.prototype.slice.call(doc.head.childNodes)
    .concat(Array.prototype.slice.call(doc.body.childNodes));
  var queue = [];
  nodes.forEach(function (node) {
    var parent = doc.head.contains(node) ? document.head : document.body;
    if (node.nodeType === 1 && node.tagName === 'SCRIPT') { queue.push([node, parent]); return; }
    parent.appendChild(document.importNode(node, true));
    if (node.nodeType === 1 && node.querySelectorAll) {
      var inner = parent.lastChild.querySelectorAll('script');
      Array.prototype.forEach.call(inner, function (s) { queue.push([s, s.parentNode, true]); });
    }
  });
  return queue.reduce(function (prev, item) {
    return prev.then(function () {
      return new Promise(function (resolve) {
        var old = item[0];
        var s = document.createElement('script');
        Array.prototype.forEach.call(old.attributes, function (a) { s.setAttribute(a.name, a.value); });
        s.textContent = old.textContent;
        var external = !!old.getAttribute('src');
        if (external) { s.onload = resolve; s.onerror = resolve; }
        if (item[2]) old.replaceWith(s); else item[1].appendChild(s);
        if (!external) resolve();
      });
    });
  }, Promise.resolve());
};
`;

export function buildSandboxFrameDocument(websandboxFrameBundle: string): string {
  const safeBundle = websandboxFrameBundle.replace(/<\/script/gi, '<\\/script');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<script>${safeBundle}</script>` +
    IMPORTMAP_SCRIPT_TAG +
    TRIP_ANIMATOR_SCRIPT +
    `<style>${DESIGN_SYSTEM_CSS}</style>` +
    `<script>${MOUNT_JS}</script>` +
    '</head><body></body></html>'
  );
}
