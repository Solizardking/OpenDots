import { DESIGN_SYSTEM_CSS } from '../../shared/generative-ui/frame-document.js';

export const RESIZE_MESSAGE_TYPE = "__ogui_resize";

export const PREVIEW_FRAME_CONTENT = "<head></head><body></body>";

const DESIGN_SYSTEM_STYLE_TAG = `<style>${DESIGN_SYSTEM_CSS}</style>`;
const OVERFLOW_HIDDEN_STYLE_TAG =
  "<style>html, body { overflow: hidden !important; }</style>";

/**
 * Final sandbox mount call. The document itself (bridge, design system, CSP)
 * is served from SANDBOX_FRAME_PATH; this only injects the generated content.
 */
export function buildFinalMount(html: string, css?: string): string {
  return `window.__oguiMount(${JSON.stringify(css ?? '')}, ${JSON.stringify(html)})`;
}

/**
 * Preview sandbox head: design-system styles, the generated css param, and any
 * complete <style> tags already extracted from the partial html.
 */
export function buildPreviewHeadContent(
  css?: string,
  previewStyles?: string
): string {
  const parts = [OVERFLOW_HIDDEN_STYLE_TAG, DESIGN_SYSTEM_STYLE_TAG];
  if (css) parts.push(`<style>${css}</style>`);
  if (previewStyles) parts.push(previewStyles);
  return parts.join("");
}

/**
 * Preview body update: morph via Idiomorph (preserves existing nodes, no
 * flicker), falling back to a plain innerHTML assignment if Idiomorph is
 * unavailable or throws. New element nodes are tagged with morph-enter
 * (legacy bridge parity) so the design system's fadeSlideIn animation plays
 * as streamed content appears. (The #content.initial-render stagger rules in
 * FORM_STYLES_WITH_STAGGER_CSS apply only to documents that wrap content in
 * #content — i.e. the MCP rail — and are inert here.)
 */
export function buildPreviewBodyMorph(body: string): string {
  return `(function() {
  var html = ${JSON.stringify(body)};
  if (typeof Idiomorph !== "undefined" && Idiomorph && Idiomorph.morph) {
    try {
      Idiomorph.morph(document.body, html, {
        morphStyle: 'innerHTML',
        callbacks: {
          beforeNodeAdded: function(node) {
            if (node.nodeType === 1) {
              node.classList.add('morph-enter');
              node.addEventListener('animationend', function() {
                node.classList.remove('morph-enter');
              }, { once: true });
            }
          }
        }
      });
    } catch (err) {
      document.body.innerHTML = html;
    }
  } else {
    document.body.innerHTML = html;
  }
})();`;
}

/**
 * Continuous autosize, forked from the legacy widget renderer bridge: a
 * ResizeObserver on document.body plus a window resize listener report the
 * content height to the parent on every change. Body height is forced to auto
 * so the reading can shrink below the current iframe viewport.
 */
export const MEASUREMENT_JS = `
(function() {
  if (window.__oguiResizeInstalled) return;
  window.__oguiResizeInstalled = true;
  var style = document.createElement('style');
  style.textContent = 'html, body { overflow: hidden !important; height: auto !important; min-height: 0 !important; }';
  document.head.appendChild(style);
  function reportHeight() {
    var h = document.body.scrollHeight;
    var cs = getComputedStyle(document.body);
    h += parseFloat(cs.marginTop) || 0;
    h += parseFloat(cs.marginBottom) || 0;
    parent.postMessage({ type: '${RESIZE_MESSAGE_TYPE}', height: Math.ceil(h) }, '*');
  }
  var ro = new ResizeObserver(reportHeight);
  ro.observe(document.body);
  window.addEventListener('resize', reportHeight);
  window.addEventListener('load', reportHeight);
  var interval = setInterval(reportHeight, 200);
  setTimeout(function() { clearInterval(interval); }, 3000);
  reportHeight();
})();
`;
