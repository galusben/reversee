// @vitest-environment jsdom
// The request/response inspector: Radix tabs, the lazy editor wrapper, body
// decoding + language selection, copy actions (button and context menu), the
// JWT tab, and the gRPC pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import { DetailPanes, timingsText } from '../../../src/renderer/src/components/DetailPanes';
import { bodyToText } from '../../../src/renderer/src/components/MonacoView';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';

vi.mock('../../../src/renderer/src/components/MonacoViewImpl', async () => ({
  default: (await import('./fake-api')).FakeMonaco,
}));

let fake: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  installDomShims();
  resetStores();
  fake = installFakeApi();
});
afterEach(cleanup);

function show(entry: ReturnType<typeof trafficEntry>) {
  useProxyStore.setState({ traffic: [entry], selectedId: entry.trafficId });
  return render(<DetailPanes />);
}

// Radix tabs activate on mousedown, not click.
const openTab = (name: string | RegExp) =>
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });

describe('bodyToText', () => {
  it('decodes bytes, passes strings through, and handles no body', () => {
    expect(bodyToText(new TextEncoder().encode('héllo'))).toBe('héllo');
    expect(bodyToText('already text')).toBe('already text');
    expect(bodyToText(undefined)).toBe('');
  });
});

describe('timingsText', () => {
  it('converts nanoseconds to ms and zero-fills missing phases', () => {
    const text = timingsText({ start: 'T0', total: 12_500_000, dnsLookup: 1_000_000 });
    expect(text).toContain('Start timestamp : T0');
    expect(text).toContain('DNS Lookup : 1 ms');
    expect(text).toContain('TLS handshake : 0 ms');
    expect(text).toContain('Total : 12.5 ms');
  });
});

describe('DetailPanes', () => {
  it('prompts for a selection when nothing is selected', () => {
    render(<DetailPanes />);
    expect(screen.getByText('Select a request to inspect it.')).toBeTruthy();
  });

  it('shows the response body in the lazy editor, plain first', async () => {
    show(trafficEntry());
    expect(screen.getByRole('tab', { name: 'Response Body' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    const editor = await screen.findByTestId('monaco');
    expect(editor.textContent).toBe('{"ok":true}');
    expect(editor.getAttribute('data-language')).toBe('plaintext');
  });

  it('switches to the content-type language when Formatted is chosen', async () => {
    show(trafficEntry());
    fireEvent.click(screen.getByRole('button', { name: 'Formatted' }));
    await waitFor(() =>
      expect(screen.getByTestId('monaco').getAttribute('data-language')).toBe('json')
    );
  });

  it('copies the body text via the Copy button', async () => {
    show(trafficEntry());
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(fake.api.copyToClipboard).toHaveBeenCalledWith('{"ok":true}');
  });

  it('renders headers and timings tabs, each copyable from the context menu', async () => {
    show(trafficEntry());
    openTab('Response Headers');
    const headers = await screen.findByText(/content-type : application\/json/);

    fireEvent.contextMenu(headers);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy To Clipboard' }));
    expect(fake.api.copyToClipboard).toHaveBeenCalledWith('content-type : application/json\n');

    openTab('Request Headers');
    expect(await screen.findByText(/accept : application\/json/)).toBeTruthy();
    openTab('Timings');
    expect(await screen.findByText(/Total : 12 ms/)).toBeTruthy();
  });

  it('flags truncated bodies and decompression failures', async () => {
    const entry = trafficEntry();
    Object.assign(entry.response, { truncated: true, decodeError: 'bad gzip' });
    show(entry);
    expect(screen.getByText('body truncated at 2 MB for display')).toBeTruthy();
    expect(screen.getByText(/decompression failed/)).toBeTruthy();
  });

  it('only offers the Decoded tab when a JWT is present', async () => {
    show(trafficEntry());
    expect(screen.queryByRole('tab', { name: /Decoded/ })).toBeNull();
    cleanup();

    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u_9' })}.sig`;
    show(
      trafficEntry({
        request: { url: '/me', method: 'GET', headers: { authorization: `Bearer ${jwt}` } },
      })
    );
    openTab(/Decoded/);
    expect(await screen.findByText(/"sub": "u_9"/)).toBeTruthy();
    expect(screen.getByText(/signatures are not verified/)).toBeTruthy();
  });

  it('opens gRPC entries on the gRPC pane with status and messages', async () => {
    show(
      trafficEntry({
        grpc: {
          method: '/demo.Echo/Say',
          status: 5,
          statusMessage: 'missing',
          matchedSpecId: 'spec',
          requestMessages: [{ json: { text: 'hi' } }],
          responseMessages: [{ decodeError: 'bad wire' }],
        },
      })
    );
    expect(screen.getByRole('tab', { name: /gRPC/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('/demo.Echo/Say')).toBeTruthy();
    expect(screen.getByText(/status 5 NOT_FOUND — missing/)).toBeTruthy();
    expect(screen.getByText(/"text": "hi"/)).toBeTruthy();
    expect(screen.getByText(/decode failed: bad wire/)).toBeTruthy();
  });
});
