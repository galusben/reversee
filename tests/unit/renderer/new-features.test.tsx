// @vitest-environment jsdom
// UI added with the 2.3 feature set: table columns / sorting / virtualization
// / keyboard navigation, replay and HAR actions, the WebSocket, waterfall and
// interceptor panes, response breakpoints, and the Preferences, Rules and
// Replay dialogs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import App from '../../../src/renderer/src/App';
import { TrafficTable, ROW_HEIGHT } from '../../../src/renderer/src/components/TrafficTable';
import { DetailPanes } from '../../../src/renderer/src/components/DetailPanes';
import { BreakpointQueue } from '../../../src/renderer/src/components/BreakpointQueue';
import { BreakpointsDialog } from '../../../src/renderer/src/components/BreakpointsDialog';
import { PreferencesDialog } from '../../../src/renderer/src/components/PreferencesDialog';
import { RulesDialog } from '../../../src/renderer/src/components/RulesDialog';
import {
  ReplayDialog,
  headerOverrides,
  headersToText,
  textToHeaders,
} from '../../../src/renderer/src/components/ReplayDialog';
import { useProxyStore, upsert } from '../../../src/renderer/src/stores/proxyStore';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';
import { defaultSettings } from '../../../src/shared/settings-schema';

vi.mock('../../../src/renderer/src/components/MonacoViewImpl', async () => ({
  default: (await import('./fake-api')).FakeMonaco,
}));

let fake: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  installDomShims();
  resetStores();
  fake = installFakeApi();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dataRows = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('data-traffic-id'));
const ids = () => dataRows().map((r) => Number(r.getAttribute('data-traffic-id')));
const openTab = (name: string | RegExp) =>
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
const ms = (n: number) => n * 1_000_000;

function entry(id: number, extra: Record<string, unknown> = {}) {
  return trafficEntry({ trafficId: id, ...extra });
}

describe('traffic table columns and sorting', () => {
  function seed() {
    useProxyStore.setState({
      traffic: [
        entry(1, {
          request: { url: '/b', method: 'GET', headers: {} },
          response: { statusCode: 200, headers: { 'content-type': 'text/plain' }, size: 1400 },
          timings: { start: '2026-01-01T10:00:00.000Z', total: ms(120) },
        }),
        entry(2, {
          request: { url: '/a', method: 'POST', headers: {} },
          response: { statusCode: 500, headers: {}, size: 20 },
          timings: { start: '2026-01-01T10:00:01.000Z', total: ms(2500) },
        }),
        entry(3, {
          request: { url: '/c', method: 'DELETE', headers: {} },
          response: { statusCode: 301, headers: {}, size: 3_000_000 },
          timings: { start: '2026-01-01T10:00:02.000Z', total: ms(4) },
        }),
      ],
    });
  }

  it('shows size and duration for each request', () => {
    seed();
    render(<TrafficTable />);
    const [first, second, third] = dataRows();
    expect(first.textContent).toContain('1.4 kB');
    expect(first.textContent).toContain('120 ms');
    expect(second.textContent).toContain('2.50 s');
    expect(third.textContent).toContain('3.00 MB');
    expect(third.textContent).toContain('4.0 ms');
  });

  it('sorts by a column and flips direction on a second click', () => {
    seed();
    render(<TrafficTable />);
    expect(ids()).toEqual([1, 2, 3]);

    fireEvent.click(screen.getByRole('button', { name: 'Time' }));
    expect(ids()).toEqual([2, 1, 3]); // slowest first
    expect(screen.getByRole('columnheader', { name: /Time/ }).getAttribute('aria-sort')).toBe(
      'descending'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Time' }));
    expect(ids()).toEqual([3, 1, 2]);

    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(ids()).toEqual([3, 1, 2]); // biggest first
    fireEvent.click(screen.getByRole('button', { name: 'Path' }));
    expect(ids()).toEqual([2, 1, 3]); // /a /b /c
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(ids()).toEqual([1, 3, 2]);
    fireEvent.click(screen.getByRole('button', { name: '#' }));
    expect(ids()).toEqual([1, 2, 3]);
    fireEvent.click(screen.getByRole('button', { name: '#' }));
    expect(ids()).toEqual([3, 2, 1]);
  });

  it('marks pending, WebSocket, mocked and imported entries', () => {
    useProxyStore.setState({
      traffic: [
        entry(1, { pending: true, response: { headers: {} } }),
        entry(2, {
          ws: { messages: [], messageCount: 0 },
          response: { statusCode: 101, headers: {} },
        }),
        entry(3, { mocked: true }),
        entry(4, { imported: true }),
      ],
    });
    render(<TrafficTable />);
    const [pending, ws, mocked, imported] = dataRows();
    expect(pending.textContent).toContain('…');
    expect(pending.className).toContain('italic');
    expect(within(ws).getByText('WS')).toBeTruthy();
    expect(within(mocked).getByText('MOCK')).toBeTruthy();
    expect(within(imported).getByText('HAR')).toBeTruthy();
  });
});

describe('traffic table virtualization', () => {
  it('renders only the rows near the viewport, with spacers for the rest', () => {
    const traffic = Array.from({ length: 5000 }, (_, i) => entry(i + 1));
    useProxyStore.setState({ traffic });
    const { container } = render(<TrafficTable />);
    const rendered = dataRows().length;
    expect(rendered).toBeGreaterThan(20);
    expect(rendered).toBeLessThan(80);
    expect(ids()[0]).toBe(1);
    // The spacer keeps the scroll height equal to all 5000 rows.
    const spacer = container.querySelector('tbody tr[aria-hidden]') as HTMLElement;
    expect(parseInt(spacer.style.height, 10)).toBe((5000 - rendered) * ROW_HEIGHT);
  });

  it('renders the window around the scroll position', () => {
    useProxyStore.setState({ traffic: Array.from({ length: 5000 }, (_, i) => entry(i + 1)) });
    render(<TrafficTable />);
    const region = screen.getByRole('region', { name: 'Captured traffic' });
    Object.defineProperty(region, 'scrollTop', { value: 3000 * ROW_HEIGHT, writable: true });
    fireEvent.scroll(region);
    const shown = ids();
    expect(shown).toContain(3001);
    expect(shown).not.toContain(1);
    expect(shown.length).toBeLessThan(80);
  });
});

describe('keyboard navigation', () => {
  beforeEach(() => {
    useProxyStore.setState({ traffic: [entry(1), entry(2), entry(3)] });
  });

  it('moves the selection with the arrow, Home and End keys', () => {
    render(<TrafficTable />);
    const region = screen.getByRole('region', { name: 'Captured traffic' });
    const press = (key: string) => fireEvent.keyDown(region, { key });
    const selected = () => useProxyStore.getState().selectedId;

    press('ArrowDown');
    expect(selected()).toBe(1);
    press('ArrowDown');
    press('ArrowDown');
    expect(selected()).toBe(3);
    press('ArrowDown'); // stays on the last row
    expect(selected()).toBe(3);
    press('ArrowUp');
    expect(selected()).toBe(2);
    press('Home');
    expect(selected()).toBe(1);
    press('End');
    expect(selected()).toBe(3);
    expect(dataRows()[2].getAttribute('aria-selected')).toBe('true');
  });

  it('follows the displayed order, not the capture order', () => {
    useProxyStore.setState({ sort: { key: 'id', dir: 'desc' } });
    render(<TrafficTable />);
    fireEvent.keyDown(screen.getByRole('region', { name: 'Captured traffic' }), { key: 'Home' });
    expect(useProxyStore.getState().selectedId).toBe(3);
  });

  it('Escape in the filter clears it; a focus request focuses it', () => {
    render(<TrafficTable />);
    const filter = screen.getByLabelText('Filter traffic') as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(dataRows()).toHaveLength(0);
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter.value).toBe('');
    expect(dataRows()).toHaveLength(3);

    act(() => useUiStore.getState().requestFilterFocus());
    expect(document.activeElement).toBe(filter);
  });
});

describe('replay and HAR actions', () => {
  function openMenu() {
    useProxyStore.setState({ traffic: [entry(1), entry(2)] });
    render(<TrafficTable />);
    fireEvent.contextMenu(dataRows()[1]);
  }

  it('Replay re-sends the right-clicked request and selects the new entry', async () => {
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Replay' }));
    await waitFor(() => expect(fake.api.replayRequest).toHaveBeenCalledWith(2, undefined));
    await waitFor(() => expect(useProxyStore.getState().selectedId).toBe(999));
  });

  it('a failed replay is reported in the status notice', async () => {
    fake.api.replayRequest.mockResolvedValueOnce({ ok: false, error: 'upstream down' });
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Replay' }));
    await waitFor(() =>
      expect(useUiStore.getState().notice).toEqual({
        kind: 'error',
        text: 'Replay failed: upstream down',
      })
    );
  });

  it('Mock This Response opens the rules screen with the response prefilled', async () => {
    useProxyStore.setState({
      traffic: [
        entry(1),
        entry(2, {
          request: { url: '/users?page=2', method: 'get', headers: {} },
          response: {
            statusCode: 201,
            headers: { 'content-type': ['application/json', 'x'], etag: 'abc' },
            body: new TextEncoder().encode('{"id":1}'),
          },
        }),
      ],
    });
    render(<TrafficTable />);
    fireEvent.contextMenu(dataRows()[1]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mock This Response…' }));
    expect(useUiStore.getState().rulesOpen).toBe(true);
    expect(useUiStore.getState().rulesSeed).toEqual({
      kind: 'mock',
      rule: {
        name: 'get /users',
        enabled: true,
        method: 'GET',
        pathPattern: '^/users(?:\\?.*)?$',
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"id":1}',
      },
    });
  });

  it('Route Requests Like This seeds a route for that path', async () => {
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Route Requests Like This…' }));
    expect(useUiStore.getState().rulesSeed).toMatchObject({
      kind: 'route',
      rule: { destProtocol: 'http', dest: 'localhost', destPort: 3000 },
    });
  });

  it('Edit and Replay opens the editor for that request', async () => {
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit and Replay…' }));
    expect(useUiStore.getState().replayEditorId).toBe(2);
  });

  it('exports one request from the menu, and everything listed from the toolbar', async () => {
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export as HAR…' }));
    await waitFor(() => expect(fake.api.exportHar).toHaveBeenCalledWith([2]));
    await waitFor(() =>
      expect(useUiStore.getState().notice?.text).toBe('Exported 2 requests to /tmp/out.har')
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export HAR' }));
    await waitFor(() => expect(fake.api.exportHar).toHaveBeenLastCalledWith(undefined));

    // With a filter active, only the listed rows are exported.
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export HAR' }));
    await waitFor(() => expect(fake.api.exportHar).toHaveBeenLastCalledWith([]));
  });

  it('imports a HAR and stays quiet when the picker is cancelled', async () => {
    useProxyStore.setState({ traffic: [] });
    render(<TrafficTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Import HAR' }));
    await waitFor(() => expect(useUiStore.getState().notice?.text).toBe('Imported 3 requests'));

    act(() => useUiStore.getState().clearNotice());
    fake.api.importHar.mockResolvedValueOnce({ ok: false, canceled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Import HAR' }));
    await waitFor(() => expect(fake.api.importHar).toHaveBeenCalledTimes(2));
    expect(useUiStore.getState().notice).toBeNull();
  });
});

describe('store behaviour', () => {
  it('upsert replaces by id, appends otherwise, and evicts past the cap', () => {
    const a = entry(1);
    const b = entry(2);
    let list = upsert([], a, 2);
    list = upsert(list, b, 2);
    const a2 = { ...a, pending: false };
    expect(upsert(list, a2, 2)).toEqual([a2, b]);
    expect(upsert(list, entry(3), 2).map((e) => e.trafficId)).toEqual([2, 3]);
  });

  it('a smaller history size trims the list at once', async () => {
    useProxyStore.setState({ traffic: Array.from({ length: 300 }, (_, i) => entry(i + 1)) });
    fake.api.getTraffic.mockResolvedValueOnce(useProxyStore.getState().traffic);
    await useProxyStore.getState().init();
    act(() => fake.emit('onSettingsChanged', { ...defaultSettings, trafficCap: 100 }));
    const traffic = useProxyStore.getState().traffic;
    expect(traffic).toHaveLength(100);
    expect(traffic[0].trafficId).toBe(201);
  });

  it('breakpoint hits are removed when resumed elsewhere or when the proxy stops', async () => {
    await useBreakpointStore.getState().init();
    const hit = (id: number) => ({
      id,
      phase: 'request',
      url: '/x',
      method: 'GET',
      headers: {},
      body: new Uint8Array(),
    });
    act(() => {
      fake.emit('onBreakpointHit', hit(1));
      fake.emit('onBreakpointHit', hit(2));
      fake.emit('onBreakpointHit', hit(3));
    });
    act(() => fake.emit('onBreakpointResumed', 2)); // an agent resumed it
    expect(useBreakpointStore.getState().hits.map((h) => h.id)).toEqual([1, 3]);
    act(() => fake.emit('onProxyState', { running: false }));
    expect(useBreakpointStore.getState().hits).toEqual([]);

    const rules = [{ id: 'r', path: '/set-by-agent', methods: ['GET'], phase: 'response' }];
    act(() => fake.emit('onBreakpointsChanged', rules));
    expect(useBreakpointStore.getState().rules).toEqual(rules);
  });
});

describe('detail panes', () => {
  function show(e: ReturnType<typeof trafficEntry>) {
    useProxyStore.setState({ traffic: [e], selectedId: e.trafficId });
    return render(<DetailPanes />);
  }

  it('lists WebSocket messages with direction, and opens on that tab', () => {
    show(
      entry(1, {
        response: { statusCode: 101, headers: {} },
        ws: {
          messageCount: 420,
          closed: true,
          messages: [
            { from: 'server', opcode: 'text', text: 'welcome', size: 7, atMs: 3 },
            { from: 'client', opcode: 'text', text: '{"sub":"prices"}', size: 16, atMs: 250 },
            { from: 'server', opcode: 'binary', size: 2048, atMs: 300 },
            { from: 'client', opcode: 'close', closeCode: 1000, text: 'done', size: 6, atMs: 900 },
            { from: 'server', opcode: 'text', size: 99, atMs: 950, truncated: true },
          ],
        },
      })
    );
    expect(screen.getByRole('tab', { name: /Messages/ }).getAttribute('data-state')).toBe('active');
    const items = within(screen.getByRole('list', { name: 'WebSocket messages' })).getAllByRole(
      'listitem'
    );
    expect(items).toHaveLength(5);
    expect(items[0].textContent).toContain('welcome');
    expect(within(items[0]).getByLabelText('received')).toBeTruthy();
    expect(within(items[1]).getByLabelText('sent')).toBeTruthy();
    expect(items[2].textContent).toContain('binary, 2.0 kB');
    expect(items[3].textContent).toContain('close 1000 done');
    expect(items[4].textContent).toContain('(not decoded)');
    expect(items[4].textContent).toContain('(truncated)');
    expect(screen.getByText('420 messages')).toBeTruthy();
    expect(screen.getByText('showing the most recent 5')).toBeTruthy();
    expect(screen.getByText('closed')).toBeTruthy();
  });

  it('draws a timing waterfall alongside the raw numbers', () => {
    show(
      entry(1, {
        timings: {
          start: '2026-01-01T00:00:00.000Z',
          dnsLookup: ms(10),
          tcpConnection: ms(30),
          firstByte: ms(80),
          total: ms(100),
        },
      })
    );
    openTab('Timings');
    const rows = within(screen.getByRole('table', { name: 'Timing waterfall' })).getAllByRole(
      'row'
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      'DNS lookup10 ms',
      'TCP connect20 ms',
      'Waiting (first byte)50 ms',
      'Download20 ms',
    ]);
    const bar = rows[2].querySelector('div > div') as HTMLElement;
    expect(bar.style.left).toBe('30%');
    expect(bar.style.width).toBe('50%');
    expect(screen.getByText(/Total : 100 ms/)).toBeTruthy();
  });

  it('shows interceptor errors and console output on their own tab', () => {
    show(
      entry(1, {
        interceptorErrors: [{ phase: 'response', message: 'x is not defined' }],
        interceptorLogs: ['status 200', '[warn] careful'],
      })
    );
    openTab(/Interceptor/);
    expect(screen.getByRole('alert').textContent).toBe(
      'response interceptor error: x is not defined'
    );
    expect(screen.getByText('status 200')).toBeTruthy();
    expect(screen.getByText('[warn] careful')).toBeTruthy();
  });

  it('has no interceptor tab when nothing was logged', () => {
    show(entry(1));
    expect(screen.queryByRole('tab', { name: /Interceptor/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Messages/ })).toBeNull();
  });

  it('summarizes what happened to the exchange', () => {
    show(
      entry(1, {
        mocked: true,
        clientAborted: true,
        request: {
          url: '/api/x',
          method: 'PUT',
          headers: {},
          target: { protocol: 'https', host: 'up.test', port: 8443 },
        },
      })
    );
    const summary = screen.getByLabelText('Request summary');
    expect(summary.textContent).toContain('PUT /api/x');
    expect(summary.textContent).toContain('→ https://up.test:8443');
    expect(summary.textContent).toContain('answered by a mock rule');
    expect(summary.textContent).toContain('client disconnected');
  });
});

describe('response breakpoints', () => {
  it('the dialog adds a response-phase rule', async () => {
    useBreakpointStore.setState({ editorOpen: true });
    render(<BreakpointsDialog />);
    fireEvent.change(screen.getByLabelText('Hold'), { target: { value: 'response' } });
    fireEvent.change(screen.getByLabelText('URL path regex'), { target: { value: '/pay' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(fake.api.setBreakpoints).toHaveBeenCalledWith([
        { id: 'response GET /pay', path: '/pay', methods: ['GET'], phase: 'response' },
      ])
    );
    expect(await screen.findByRole('cell', { name: 'response' })).toBeTruthy();
  });

  it('a held response is edited by status, headers and body', async () => {
    useBreakpointStore.setState({
      hits: [
        {
          id: 8,
          phase: 'response',
          url: '/pay',
          method: 'POST',
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"ok":true}'),
        },
      ],
    });
    render(<BreakpointQueue />);
    const panel = screen.getByRole('region', { name: 'Held response' });
    expect(panel.textContent).toContain('response to POST /pay');
    expect(within(panel).queryByLabelText('URL')).toBeNull(); // not editable for a response

    const status = within(panel).getByLabelText('Status code') as HTMLInputElement;
    const resume = within(panel).getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    fireEvent.change(status, { target: { value: '99' } });
    expect(resume.disabled).toBe(true);
    fireEvent.change(status, { target: { value: '503' } });
    fireEvent.change(within(panel).getByLabelText('Response body'), {
      target: { value: '{"ok":false}' },
    });
    fireEvent.click(resume);
    await waitFor(() =>
      expect(fake.api.resumeBreakpoint).toHaveBeenCalledWith(8, {
        url: '/pay',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"ok":false}',
        statusCode: 503,
      })
    );
  });
});

describe('PreferencesDialog', () => {
  function open(settings = {}) {
    useProxyStore.setState({
      settings: { ...defaultSettings, ...settings },
      certStatus: {
        notAfter: '2036-01-01T00:00:00.000Z',
        daysLeft: 3000,
        expired: false,
        expiringSoon: false,
      },
    });
    useUiStore.setState({ preferencesOpen: true });
    render(<PreferencesDialog />);
  }

  it('changes theme, history size and timeout, ignoring out-of-range numbers', async () => {
    open();
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } });
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledWith({ theme: 'dark' }));

    const history = screen.getByLabelText('History size') as HTMLInputElement;
    fireEvent.change(history, { target: { value: '5' } }); // below the minimum
    expect(history.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(history, { target: { value: '5000' } });
    await waitFor(() =>
      expect(fake.api.setSettings).toHaveBeenLastCalledWith({ trafficCap: 5000 })
    );

    fireEvent.change(screen.getByLabelText('Upstream timeout'), { target: { value: '0' } });
    await waitFor(() =>
      expect(fake.api.setSettings).toHaveBeenLastCalledWith({ upstreamTimeoutSec: 0 })
    );
    expect(fake.api.setSettings).not.toHaveBeenCalledWith({ trafficCap: 5 });
  });

  it('toggles upstream certificate verification (the inverse of allowSelfSigned)', async () => {
    open({ allowSelfSignedUpstream: true });
    const box = screen.getByLabelText(/Verify the upstream/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(fake.api.setSettings).toHaveBeenCalledWith({ allowSelfSignedUpstream: false })
    );
  });

  it('picks the client certificate files through the native picker', async () => {
    open();
    fireEvent.click(screen.getAllByRole('button', { name: 'Browse…' })[0]);
    await waitFor(() =>
      expect(fake.api.setSettings).toHaveBeenCalledWith({
        upstreamClientCertPath: '/picked/file.pem',
      })
    );
    fireEvent.change(screen.getByLabelText('Key file'), { target: { value: '/k.pem' } });
    await waitFor(() =>
      expect(fake.api.setSettings).toHaveBeenLastCalledWith({ upstreamClientKeyPath: '/k.pem' })
    );
  });

  it('shows the root certificate validity and regenerates on request', async () => {
    open();
    expect(screen.getByLabelText('Root certificate status').textContent).toBe(
      'Valid until 2036-01-01 (3000 days left).'
    );
    fireEvent.click(screen.getByRole('button', { name: /Regenerate root certificate/ }));
    await waitFor(() => expect(fake.api.regenerateRootCert).toHaveBeenCalledOnce());
  });
});

describe('RulesDialog', () => {
  function open(
    settings = {},
    seed?: Parameters<ReturnType<typeof useUiStore.getState>['setRulesOpen']>[1]
  ) {
    useProxyStore.setState({ settings: { ...defaultSettings, ...settings } });
    act(() => useUiStore.getState().setRulesOpen(true, seed));
    render(<RulesDialog />);
  }
  const value = (label: string) =>
    (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;
  const change = (label: string, v: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
  const saved = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledOnce());
    return fake.api.setSettings.mock.calls[0][0] as { routes: unknown[]; mocks: unknown[] };
  };

  it('explains both kinds and starts on mocks with examples', () => {
    open({ dest: 'api.example.com', destProtocol: 'https', destPort: 443 });
    expect(screen.getByRole('tab', { name: /Mocks \(0\)/ }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(screen.getByText(/Answer with a response you write/)).toBeTruthy();
    expect(screen.getByText(/Send some requests to a different server/)).toBeTruthy();
    expect(screen.getByText('https://api.example.com:443')).toBeTruthy();
    expect(screen.getByText('No mocks yet.')).toBeTruthy();
    expect(screen.getByText(/Rules take effect when the proxy is started/)).toBeTruthy();
  });

  it('keeps a recorded binary body as base64 through a save, and can replace it with text', async () => {
    const png = {
      id: 'png',
      name: 'Recorded: GET /logo.png',
      enabled: true,
      method: 'GET',
      pathPattern: '^/logo\\.png(?:\\?.*)?$',
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: 'iVBORw0KGgo=',
      bodyEncoding: 'base64' as const,
    };
    open({ mocks: [png] });
    expect(screen.getByText(/Binary body, stored as base64/)).toBeTruthy();
    expect((await saved()).mocks).toEqual([png]);

    cleanup();
    fake.api.setSettings.mockClear();
    open({ mocks: [png] });
    fireEvent.click(screen.getByRole('button', { name: 'Replace with text' }));
    change('Mock 1 body', 'hello');
    const [mock] = (await saved()).mocks as Array<Record<string, unknown>>;
    expect(mock['body']).toBe('hello');
    expect(mock['bodyEncoding']).toBeUndefined();
  });

  it('says rules apply at once while the proxy runs', () => {
    useProxyStore.setState({ running: true });
    open();
    expect(screen.getByText(/applies the rules to the running proxy at once/)).toBeTruthy();
  });

  it('opens on routes when only routes exist', () => {
    open({
      routes: [
        {
          id: 'r',
          enabled: true,
          pathPattern: '^/v2/',
          destProtocol: 'http',
          dest: 'x',
          destPort: 1,
        },
      ],
    });
    expect(screen.getByRole('tab', { name: /Routes \(1\)/ }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(value('Route 1 path match')).toBe('prefix');
    expect(value('Route 1 path')).toBe('/v2/');
  });

  it('builds a mock from a starter and saves the plain match as a regex', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Server error (500)' }));
    expect(value('Mock 1 name')).toBe('Server error');
    expect(value('Mock 1 status')).toBe('500');
    change('Mock 1 path', '/api/pay');
    change('Mock 1 method', 'POST');
    const patch = await saved();
    expect(patch.routes).toEqual([]);
    expect(patch.mocks).toEqual([
      {
        id: expect.any(String),
        name: 'Server error',
        enabled: true,
        method: 'POST',
        pathPattern: '^/api/pay(?:\\?.*)?$',
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: '{\n  "error": "Internal Server Error"\n}',
      },
    ]);
    await waitFor(() => expect(useUiStore.getState().rulesOpen).toBe(false));
  });

  it('a new mock cannot be saved until it has a valid path, status and delay', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /Add mock/ }));
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the path this mock answers/);

    change('Mock 1 path match', 'regex');
    change('Mock 1 path', '(');
    expect(screen.getByRole('alert').textContent).toMatch(/not a valid regular expression/);
    change('Mock 1 path', '^/v[12]/');
    expect(screen.queryByRole('alert')).toBeNull();

    change('Mock 1 status', '99');
    expect(screen.getByRole('alert').textContent).toMatch(/status must be a number/);
    change('Mock 1 status', '204');
    change('Mock 1 delay', 'soon');
    expect(screen.getByRole('alert').textContent).toMatch(/delay must be a whole number/);
    change('Mock 1 delay', '250');
    expect(save.disabled).toBe(false);
  });

  it('edits body type, headers and JSON, with a warning for broken JSON', async () => {
    const mock = {
      id: 'a',
      enabled: true,
      pathPattern: '^/a',
      statusCode: 200,
      headers: { 'content-type': 'text/plain', 'x-keep': '1' },
      body: 'hi',
    };
    open({ mocks: [mock] });
    expect(value('Mock 1 path match')).toBe('prefix');
    expect(screen.getByRole('button', { name: 'Text' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    expect(screen.getByText(/The body is not valid JSON/)).toBeTruthy();
    change('Mock 1 body', '{"down":true}');
    expect(screen.queryByText(/The body is not valid JSON/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
    expect(value('Mock 1 body')).toBe('{\n  "down": true\n}');

    fireEvent.click(screen.getByRole('button', { name: 'Edit headers (2)' }));
    expect(value('Mock 1 headers')).toBe('content-type: application/json\nx-keep: 1');
    change('Mock 1 headers', 'content-type: application/json\nx-mock: 1\nnot a header');
    fireEvent.click(screen.getByRole('button', { name: 'Hide headers' }));
    expect(screen.queryByLabelText('Mock 1 headers')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    change('Mock 1 delay', '250');
    fireEvent.click(screen.getByLabelText('Mock 1 enabled'));

    expect((await saved()).mocks).toEqual([
      {
        id: 'a',
        enabled: false,
        pathPattern: '^/a',
        statusCode: 200,
        headers: { 'content-type': 'text/html', 'x-mock': '1' },
        body: '{\n  "down": true\n}',
        delayMs: 250,
      },
    ]);
  });

  it('reorders, duplicates, collapses and deletes rules', async () => {
    const mock = (id: string, path: string) => ({
      id,
      name: id.toUpperCase(),
      enabled: true,
      pathPattern: `^${path}`,
      statusCode: 200,
      headers: {},
      body: '',
    });
    open({ mocks: [mock('a', '/a'), mock('b', '/b'), mock('c', '/c')] });
    // Three rules start collapsed to their summaries.
    expect(screen.queryByLabelText('Mock 1 path')).toBeNull();
    expect(screen.getByText('Any method · path starts with /a → 200')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Move mock 1 up' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Move mock 3 down' }) as HTMLButtonElement).disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Move mock 1 down' })); // b a c
    fireEvent.click(screen.getByRole('button', { name: 'Move mock 3 up' })); // b c a
    fireEvent.click(screen.getByRole('button', { name: 'Delete mock 1' })); // c a
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate mock 1' })); // c a c-copy
    expect(value('Mock 3 name')).toBe('C copy'); // the copy opens for editing
    fireEvent.click(screen.getByRole('button', { name: 'Collapse mock 3' }));
    expect(screen.queryByLabelText('Mock 3 name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand mock 2' }));
    change('Mock 2 path', '');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse mock 2' }));
    // A collapsed rule still shows what is wrong with it.
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the path/);
    fireEvent.click(screen.getByRole('button', { name: 'Delete mock 2' }));

    const { mocks } = (await saved()) as { mocks: { id: string; name: string }[] };
    expect(mocks.map((m) => m.name)).toEqual(['C', 'C copy']);
    expect(mocks[0]?.id).toBe('c');
    expect(mocks[1]?.id).not.toBe('c');
  });

  it('adds a route from the example and validates it', async () => {
    open();
    fireEvent.click(screen.getByRole('tab', { name: /Routes/ }));
    expect(screen.getByText('No routes yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Example: \/api\/v2/ }));
    expect(value('Route 1 path')).toBe('/api/v2');
    expect(value('Route 1 destination host')).toBe('localhost');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    change('Route 1 path', '');
    expect(screen.getByRole('alert').textContent).toMatch(/Enter a path or a host/);
    change('Route 1 host match', 'regex');
    change('Route 1 host', '(');
    expect(screen.getByRole('alert').textContent).toMatch(/host is not a valid regular/);
    change('Route 1 host match', 'exact');
    change('Route 1 host', 'api.example.com');
    change('Route 1 path match', 'regex');
    change('Route 1 path', '[');
    expect(screen.getByRole('alert').textContent).toMatch(/path is not a valid regular/);
    change('Route 1 path match', 'exact');
    change('Route 1 path', '/health');
    change('Route 1 destination host', ' ');
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the server/);
    change('Route 1 destination host', 'v2.internal');
    change('Route 1 destination port', '0');
    expect(screen.getByRole('alert').textContent).toMatch(/port must be between/);
    expect(save.disabled).toBe(true);
    // Switching protocol follows the default port only when none was typed.
    change('Route 1 destination port', '80');
    change('Route 1 protocol', 'https');
    expect(value('Route 1 destination port')).toBe('443');
    change('Route 1 destination port', '8443');
    change('Route 1 protocol', 'http');
    expect(value('Route 1 destination port')).toBe('8443');
    change('Route 1 name', '  Health  ');

    expect((await saved()).routes).toEqual([
      {
        id: expect.any(String),
        name: 'Health',
        enabled: true,
        hostPattern: '^api\\.example\\.com$',
        pathPattern: '^/health(?:\\?.*)?$',
        destProtocol: 'http',
        dest: 'v2.internal',
        destPort: 8443,
      },
    ]);
  });

  it('adds, reorders, duplicates and removes routes', async () => {
    const route = (id: string) => ({
      id,
      enabled: true,
      pathPattern: `^/${id}`,
      destProtocol: 'http' as const,
      dest: id,
      destPort: 80,
    });
    open({ routes: [route('a'), route('b'), route('c')] });
    expect(screen.getByText('path starts with /a → http://a:80')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move route 1 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate route 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete route 3' }));
    fireEvent.click(screen.getByLabelText('Route 1 enabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand route 2' }));
    change('Route 2 path', '');
    change('Route 2 host', '');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse route 2' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Enter a path or a host/);
    expect(screen.getByText('New route')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete route 2' }));
    fireEvent.click(screen.getByRole('button', { name: /Add route/ }));
    change('Route 3 host', 'x.test');
    change('Route 3 destination host', 'y.test');
    expect(screen.getByText(/host is x\.test → http:\/\/y\.test:80/)).toBeTruthy();

    const { routes } = (await saved()) as { routes: { dest: string; enabled: boolean }[] };
    expect(routes.map((r) => [r.dest, r.enabled])).toEqual([
      ['b', false],
      ['c', true],
      ['y.test', true],
    ]);
  });

  it('shows how many captured requests each rule matches', () => {
    useProxyStore.setState({
      traffic: [
        entry(1, {
          request: { url: '/api/flags?u=1', method: 'GET', headers: { host: 'a.test:80' } },
        }),
        entry(2, { request: { url: '/api/flags', method: 'POST', headers: { host: ['b.test'] } } }),
        entry(3, { request: { url: '/other', method: 'GET', headers: {} } }),
      ],
    });
    open({
      mocks: [
        {
          id: 'm',
          enabled: true,
          method: 'GET',
          pathPattern: '^/api/flags(?:\\?.*)?$',
          statusCode: 200,
          headers: {},
          body: '',
        },
      ],
      routes: [
        {
          id: 'r',
          enabled: true,
          hostPattern: '^a\\.test$',
          pathPattern: '^/api',
          destProtocol: 'http',
          dest: 'x',
          destPort: 1,
        },
      ],
    });
    expect(screen.getByText('Matches 1 of 3 captured requests')).toBeTruthy();
    change('Mock 1 method', '');
    expect(screen.getByText('Matches 2 of 3 captured requests')).toBeTruthy();
    change('Mock 1 path', '/nothing');
    expect(screen.getByText('Matches no captured request')).toBeTruthy();
    change('Mock 1 path', '');
    expect(screen.getByText('Matches no captured request')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Routes/ }));
    expect(screen.getByText('Matches 1 of 3 captured requests')).toBeTruthy();
    change('Route 1 host', '');
    expect(screen.getByText('Matches 2 of 3 captured requests')).toBeTruthy();
    change('Route 1 path', '');
    expect(screen.getByText('Matches no captured request')).toBeTruthy();
    change('Route 1 path match', 'regex');
    change('Route 1 path', '(');
    expect(screen.getByText('Matches no captured request')).toBeTruthy();
  });

  it('opens with a prefilled mock or route when seeded', async () => {
    open(
      {
        mocks: [
          {
            id: 'old',
            enabled: true,
            pathPattern: '^/old',
            statusCode: 200,
            headers: {},
            body: '',
          },
        ],
      },
      {
        kind: 'mock',
        rule: {
          name: 'GET /users',
          enabled: true,
          method: 'GET',
          pathPattern: '^/users(?:\\?.*)?$',
          statusCode: 201,
          headers: { 'content-type': 'application/json' },
          body: '[]',
        },
      }
    );
    expect(value('Mock 1 name')).toBe('GET /users');
    expect(value('Mock 1 path match')).toBe('exact');
    expect(value('Mock 1 path')).toBe('/users');
    const { mocks } = (await saved()) as { mocks: { id: string }[] };
    expect(mocks).toHaveLength(2);
    expect(mocks[1]?.id).toBe('old');
  });

  it('a route seed opens the routes tab; closing clears the seed', () => {
    open(
      {},
      {
        kind: 'route',
        rule: {
          enabled: true,
          pathPattern: '^/users',
          destProtocol: 'http',
          dest: 'localhost',
          destPort: 3000,
        },
      }
    );
    expect(screen.getByRole('tab', { name: /Routes \(1\)/ }).getAttribute('aria-selected')).toBe(
      'true'
    );
    expect(value('Route 1 path')).toBe('/users');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().rulesOpen).toBe(false);
    expect(useUiStore.getState().rulesSeed).toBeNull();
    expect(fake.api.setSettings).not.toHaveBeenCalled();
  });
});

describe('ReplayDialog', () => {
  const original = () =>
    entry(5, {
      request: {
        url: '/api/items',
        method: 'POST',
        headers: { accept: 'application/json', 'x-remove': 'me' },
        body: new TextEncoder().encode('{"a":1}'),
        target: { protocol: 'http', host: 'up.test', port: 8080 },
      },
    });

  it('header helpers round-trip and compute removals', () => {
    expect(headersToText({ a: '1', b: ['x', 'y'] })).toBe('a: 1\nb: x, y');
    expect(textToHeaders('a: 1\n\nbroken line\n b :  two: parts ')).toEqual({
      a: '1',
      b: 'two: parts',
    });
    expect(
      headerOverrides({ Accept: 'a', 'x-remove': 'me' }, { accept: 'b', 'x-new': 'n' })
    ).toEqual({
      accept: 'b',
      'x-new': 'n',
      'x-remove': null,
    });
  });

  it('sends the edits as overrides, then closes and selects the result', async () => {
    useProxyStore.setState({ traffic: [original()] });
    useUiStore.setState({ replayEditorId: 5 });
    render(<ReplayDialog />);
    expect(screen.getByText(/straight to http:\/\/up.test:8080/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Replay method'), { target: { value: 'put' } });
    fireEvent.change(screen.getByLabelText('Replay URL'), { target: { value: '/api/items/9' } });
    fireEvent.change(screen.getByLabelText(/^Headers/), {
      target: { value: 'accept: text/plain\nx-added: yes' },
    });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '{"a":2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(fake.api.replayRequest).toHaveBeenCalledWith(5, {
        method: 'PUT',
        url: '/api/items/9',
        headers: { accept: 'text/plain', 'x-added': 'yes', 'x-remove': null },
        body: '{"a":2}',
      })
    );
    await waitFor(() => expect(useUiStore.getState().replayEditorId).toBeNull());
    expect(useProxyStore.getState().selectedId).toBe(999);
  });

  it('leaves an untouched body out of the overrides', async () => {
    useProxyStore.setState({ traffic: [original()] });
    useUiStore.setState({ replayEditorId: 5 });
    render(<ReplayDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fake.api.replayRequest).toHaveBeenCalledOnce());
    expect(fake.api.replayRequest.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('keeps the dialog open and shows the reason when the replay fails', async () => {
    fake.api.replayRequest.mockResolvedValueOnce({ ok: false, error: 'ECONNREFUSED' });
    useProxyStore.setState({ traffic: [original()] });
    useUiStore.setState({ replayEditorId: 5 });
    render(<ReplayDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toBe('ECONNREFUSED');
    expect(useUiStore.getState().replayEditorId).toBe(5);
  });

  it('cannot send a request that has no upstream', () => {
    const e = original();
    delete (e.request as { target?: unknown }).target;
    useProxyStore.setState({ traffic: [e] });
    useUiStore.setState({ replayEditorId: 5 });
    render(<ReplayDialog />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('App shell', () => {
  it('warns about the root certificate only when listening on https', async () => {
    fake.setCertStatus({
      expired: true,
      expiringSoon: true,
      daysLeft: -4,
      notAfter: '2026-01-01T00:00:00.000Z',
    });
    render(<App />);
    await waitFor(() => expect(fake.api.getCertStatus).toHaveBeenCalled());
    await screen.findByText('Proxy stopped');
    expect(screen.queryByRole('alert', { name: 'Root certificate warning' })).toBeNull();

    act(() => fake.emit('onSettingsChanged', { ...defaultSettings, listenProtocol: 'https' }));
    const banner = await screen.findByRole('alert', { name: 'Root certificate warning' });
    expect(banner.textContent).toContain('expired on 2026-01-01');
    fireEvent.click(within(banner).getByRole('button', { name: 'Regenerate…' }));
    await waitFor(() => expect(fake.api.regenerateRootCert).toHaveBeenCalledOnce());

    // A regenerated root clears the warning.
    act(() =>
      fake.emit('onCertStatus', {
        notAfter: '2036-01-01T00:00:00.000Z',
        daysLeft: 3000,
        expired: false,
        expiringSoon: false,
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: 'Root certificate warning' })).toBeNull()
    );
  });

  it('menu events open dialogs, focus the filter and toggle the proxy', async () => {
    render(<App />);
    await screen.findByLabelText('Destination host');
    act(() => fake.emit('onOpenPreferences'));
    expect(useUiStore.getState().preferencesOpen).toBe(true);
    act(() => fake.emit('onOpenRules'));
    expect(useUiStore.getState().rulesOpen).toBe(true);
    act(() => fake.emit('onOpenScripts'));
    expect(useUiStore.getState().scriptsOpen).toBe(true);
    act(() => fake.emit('onFocusFilter'));
    expect(useUiStore.getState().filterFocusRequest).toBe(1);

    act(() => fake.emit('onToggleProxy'));
    await waitFor(() => expect(fake.api.startProxy).toHaveBeenCalledOnce());
    act(() => fake.emit('onProxyState', { running: true, port: 8000 }));
    act(() => fake.emit('onToggleProxy'));
    await waitFor(() => expect(fake.api.stopProxy).toHaveBeenCalledOnce());
  });

  it('counts requests and those still in flight in the status bar', async () => {
    fake.api.getTraffic.mockResolvedValueOnce([entry(1), entry(2, { pending: true })]);
    render(<App />);
    expect((await screen.findByLabelText('Request count')).textContent).toBe(
      '2 requests, 1 in flight'
    );
  });

  it('opens Rules and Preferences from the settings bar', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Routes and mocks/ }));
    expect(useUiStore.getState().rulesOpen).toBe(true);
    act(() => useUiStore.getState().setRulesOpen(false)); // a modal hides the bar behind it
    fireEvent.click(await screen.findByRole('button', { name: 'Preferences' }));
    expect(useUiStore.getState().preferencesOpen).toBe(true);
  });
});
