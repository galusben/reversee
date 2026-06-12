// @vitest-environment jsdom
// Regression test: traffic fields are rendered as text, never as markup.
// The pre-2.0 renderer interpolated the URL and headers into HTML strings,
// so a request to <img src=x onerror=...> executed in the app.
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrafficTable } from '../../../src/renderer/src/components/TrafficTable';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';

const HOSTILE_URL = `/x?<img src=x onerror="document.title='pwned'"><script>document.title='pwned'</script>`;

beforeAll(() => {
  useProxyStore.setState({
    traffic: [
      {
        trafficId: 1,
        request: { url: HOSTILE_URL, method: '<b>GET</b>', headers: {} },
        response: {
          statusCode: 200,
          headers: { 'content-type': '<i>text/html</i>' },
          body: new Uint8Array(),
        },
        timings: { start: new Date().toISOString() },
      },
    ],
  });
});

describe('TrafficTable XSS hardening', () => {
  it('renders hostile traffic fields as inert text', () => {
    const { container } = render(<TrafficTable />);

    // The hostile payload must appear as visible text...
    expect(screen.getByText(HOSTILE_URL)).toBeTruthy();
    // ...and must not have become live DOM nodes.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });
});
