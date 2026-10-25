import { describe, expect, it } from 'vitest';
import { sandboxFrameRoute } from '../../src/server/sandbox-frame';
import {
  SANDBOX_FRAME_CSP,
  SANDBOX_FRAME_PATH,
  buildSandboxFrameDocument,
} from '../../src/shared/generative-ui/frame-document';
import { buildFinalMount } from '../../src/client/generative-ui/frame-content';
import { isAllowedLinkUrl } from '../../src/client/sandbox/sandbox-functions';

describe('generative UI sandbox frame', () => {
  it('serves the frame document with its own strict CSP', async () => {
    const res = await sandboxFrameRoute().request(SANDBOX_FRAME_PATH);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toBe(SANDBOX_FRAME_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('*');
    const html = await res.text();
    expect(html).toContain('window.Websandbox');
    expect(html).toContain('window.__oguiMount');
    expect(html).toContain('type="importmap"');
  });

  it('escapes closing script tags in the bridge bundle', () => {
    const doc = buildSandboxFrameDocument('var a = "</script><b>";');
    expect(doc).not.toContain('"</script><b>"');
  });

  it('passes generated content as JSON string literals', () => {
    const call = buildFinalMount('<p>"hi"</p></script>', 'p{}');
    expect(call).toBe(
      `window.__oguiMount("p{}", ${JSON.stringify('<p>"hi"</p></script>')})`,
    );
  });

  it('only opens https links', () => {
    expect(isAllowedLinkUrl('https://example.com')).toBe(true);
    expect(isAllowedLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkUrl('http://example.com')).toBe(false);
  });
});
