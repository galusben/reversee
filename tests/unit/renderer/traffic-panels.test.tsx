// @vitest-environment jsdom
// Traffic table interactions (selection, filter, errors-only, row context
// menu), the held-request editor, and the interceptor editors.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import { TrafficTable } from '../../../src/renderer/src/components/TrafficTable';
import { BreakpointQueue } from '../../../src/renderer/src/components/BreakpointQueue';
import { InterceptorPanel } from '../../../src/renderer/src/components/InterceptorPanel';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';

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

const rows = () => screen.getAllByRole('row').slice(1); // drop the header row

function seedTraffic() {
  useProxyStore.setState({
    traffic: [
      trafficEntry({ trafficId: 1 }),
      trafficEntry({
        trafficId: 2,
        request: { url: '/orders', method: 'POST', headers: {}, curl: 'curl -X POST /orders' },
        response: { statusCode: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
      }),
      trafficEntry({
        trafficId: 3,
        request: { url: '/down', method: 'GET', headers: {} },
        response: { statusCode: 502, headers: {} },
        connectorError: 'ECONNREFUSED',
        replay: true,
      }),
    ],
  });
}

describe('TrafficTable', () => {
  it('renders one row per entry with status, content-type, and replay marker', () => {
    seedTraffic();
    render(<TrafficTable />);
    expect(rows()).toHaveLength(3);
    expect(rows()[1].textContent).toContain('404');
    expect(rows()[1].textContent).toContain('text/html');
    expect(rows()[1].textContent).not.toContain('charset');
    expect(rows()[2].textContent).toContain('ERR');
    expect(rows()[2].textContent).toContain('↺');
  });

  it('selects a row on click', () => {
    seedTraffic();
    render(<TrafficTable />);
    fireEvent.click(rows()[1]);
    expect(useProxyStore.getState().selectedId).toBe(2);
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
  });

  it('filters by text and by errors-only, with a match count', () => {
    seedTraffic();
    render(<TrafficTable />);
    fireEvent.change(screen.getByLabelText('Filter traffic'), { target: { value: 'orders' } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('1 of 3')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Clear filter'));
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('/orders'),
      expect.stringContaining('/down'),
    ]);

    fireEvent.change(screen.getByLabelText('Filter traffic'), { target: { value: 'nothing' } });
    expect(screen.getByText('No requests match the filter.')).toBeTruthy();
  });

  it('shows the empty state before any traffic', () => {
    render(<TrafficTable />);
    expect(screen.getByText(/No traffic yet/)).toBeTruthy();
  });

  it('copies the right-clicked row as curl from the context menu', async () => {
    seedTraffic();
    render(<TrafficTable />);
    fireEvent.contextMenu(rows()[1]);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy as curl' }));
    expect(fake.api.copyToClipboard).toHaveBeenCalledWith('curl -X POST /orders');
  });

  it('clears all traffic from the context menu', async () => {
    seedTraffic();
    render(<TrafficTable />);
    fireEvent.contextMenu(rows()[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear All' }));
    await waitFor(() => expect(fake.api.clearTraffic).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/No traffic yet/)).toBeTruthy());
  });

  it('opens the session summary and toggles auto-scroll', () => {
    render(<TrafficTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Session summary' }));
    expect(useUiStore.getState().summaryOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enable auto-scroll' }));
    expect(useProxyStore.getState().scrollLocked).toBe(false);
    expect(screen.getByRole('button', { name: 'Disable auto-scroll' })).toBeTruthy();
  });
});

describe('BreakpointQueue', () => {
  const hit = (id: number, extra = {}) => ({
    id,
    url: `/held/${id}`,
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-multi': ['a', 'b'] },
    body: new TextEncoder().encode(`body ${id}`),
    ...extra,
  });

  it('renders nothing with an empty queue', () => {
    const { container } = render(<BreakpointQueue />);
    expect(container.innerHTML).toBe('');
  });

  it('edits the head request and resumes it with the edits', async () => {
    useBreakpointStore.setState({ hits: [hit(1), hit(2)] });
    render(<BreakpointQueue />);
    expect(screen.getByText(/1 of 2 held/)).toBeTruthy();
    expect((screen.getByLabelText('Header 2 value') as HTMLInputElement).value).toBe('a, b');

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: '/edited' } });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'PUT' } });
    fireEvent.change(screen.getByLabelText('Header 1 value'), {
      target: { value: 'application/json' },
    });
    fireEvent.click(screen.getByText('+ add header'));
    fireEvent.change(screen.getByLabelText('Header 3 name'), { target: { value: 'x-new' } });
    fireEvent.change(screen.getByLabelText('Header 3 value'), { target: { value: 'yes' } });
    fireEvent.change(screen.getByLabelText('Request body'), { target: { value: '{"a":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(fake.api.resumeBreakpoint).toHaveBeenCalledWith(1, {
        url: '/edited',
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-multi': 'a, b', 'x-new': 'yes' },
        body: '{"a":1}',
      })
    );
    // The next held request takes over with fresh form state.
    await waitFor(() =>
      expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('/held/2')
    );
    expect(screen.queryByText(/of 2 held/)).toBeNull();
  });

  it('drops headers whose name was blanked', async () => {
    useBreakpointStore.setState({ hits: [hit(1)] });
    render(<BreakpointQueue />);
    fireEvent.change(screen.getByLabelText('Header 1 name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(fake.api.resumeBreakpoint).toHaveBeenCalled());
    expect(fake.api.resumeBreakpoint.mock.calls[0][1].headers).toEqual({ 'x-multi': 'a, b' });
  });
});

describe('InterceptorPanel', () => {
  beforeEach(async () => {
    await useProxyStore.getState().init();
  });

  it('enables interception per kind', async () => {
    render(<InterceptorPanel />);
    fireEvent.click(screen.getByLabelText('Intercept Response'));
    await waitFor(() =>
      expect(fake.api.setSettings).toHaveBeenCalledWith({ interceptResponse: true })
    );
  });

  it('opens an editable editor and debounces code saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<InterceptorPanel />);
    const [requestToggle] = screen.getAllByRole('button', { name: /show editor/ });
    fireEvent.click(requestToggle);
    expect(requestToggle.getAttribute('aria-expanded')).toBe('true');

    const editor = await screen.findByTestId('monaco');
    expect(editor.getAttribute('data-language')).toBe('javascript');
    fireEvent.change(editor, { target: { value: 'a' } });
    fireEvent.change(editor, { target: { value: 'ab' } });
    expect(fake.api.setSettings).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(450));
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledOnce());
    expect(fake.api.setSettings).toHaveBeenCalledWith({ requestInterceptor: 'ab' });
  });

  it('locks the toggles and makes the editor read-only while running', async () => {
    fake.setStoredSettings({ interceptRequest: true });
    await useProxyStore.getState().init();
    useProxyStore.setState({ running: true });
    render(<InterceptorPanel />);
    expect((screen.getByLabelText('Intercept Request') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('read-only while the proxy runs')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /show editor/ })[0]);
    expect((await screen.findByTestId('monaco')).tagName).toBe('PRE');
  });
});
