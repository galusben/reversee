// @vitest-environment jsdom
// Tabs in the window: the tab strip, switching (each tab's traffic, settings
// and table view), events from background tabs, and the held-request notice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, tabSummary, trafficEntry } from './fake-api';
import App from '../../../src/renderer/src/App';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';

vi.mock('../../../src/renderer/src/components/MonacoViewImpl', async () => ({
  default: (await import('./fake-api')).FakeMonaco,
}));

let fake: ReturnType<typeof installFakeApi>;

const one = tabSummary({ id: 't1', name: 'api.test', listenPort: 8000 });
const two = tabSummary({
  id: 't2',
  name: 'auth.test',
  listenPort: 8001,
  destination: 'https://auth.test:443',
});

beforeEach(() => {
  installDomShims();
  resetStores();
  localStorage.clear();
  fake = installFakeApi();
  fake.setTabs({ activeTabId: 't1', tabs: [one, two] });
});
afterEach(cleanup);

async function renderApp() {
  const utils = render(<App />);
  await screen.findByRole('tab', { name: /auth\.test/ });
  return utils;
}

function switchTo(tabId: string, tabs = [one, two]) {
  act(() => fake.emit('onTabsChanged', { activeTabId: tabId, tabs }));
}

describe('tab strip', () => {
  it('shows every tab with its port, and marks the active one', async () => {
    await renderApp();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs[0].textContent).toContain('api.test');
    expect(tabs[1].textContent).toContain(':8001');
    expect(tabs[1].getAttribute('title')).toContain('auth.test · t2');
  });

  it('selects, opens and closes tabs through main', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /auth\.test/ }));
    expect(fake.api.setActiveTab).toHaveBeenCalledWith('t2');
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(fake.api.createTab).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Close auth.test' }));
    expect(fake.api.closeTab).toHaveBeenCalledWith('t2');
    // Closing does not also select the tab.
    expect(fake.api.setActiveTab).toHaveBeenCalledTimes(1);
  });

  it('moves between tabs with the arrow keys', async () => {
    await renderApp();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(fake.api.setActiveTab).toHaveBeenCalledWith('t2');
  });

  it('renames a tab inline, and keeps the field open on a refused name', async () => {
    await renderApp();
    fake.api.renameTab.mockResolvedValueOnce({
      ok: false,
      error: 'Another tab is already called "api.test"',
    });
    fireEvent.doubleClick(screen.getByRole('tab', { name: /auth\.test/ }));
    const input = screen.getByRole('textbox', { name: 'Tab name' });
    fireEvent.change(input, { target: { value: 'api.test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(input.getAttribute('title')).toMatch(/already called/);

    fireEvent.change(input, { target: { value: 'Mobile' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Tab name' })).toBeNull());
    expect(fake.api.renameTab).toHaveBeenLastCalledWith('t2', 'Mobile');
  });

  it('offers a rename button on the active tab only', async () => {
    await renderApp();
    // A background tab has none: a click there must switch tabs, never start a rename.
    expect(screen.queryByRole('button', { name: 'Rename auth.test' })).toBeNull();
    switchTo('t2');
    fireEvent.click(screen.getByRole('button', { name: 'Rename auth.test' }));
    const input = screen.getByRole('textbox', { name: 'Tab name' });
    fireEvent.change(input, { target: { value: 'Mobile' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fake.api.renameTab).toHaveBeenCalledWith('t2', 'Mobile'));
    // The rename button does not also re-select the tab.
    expect(fake.api.setActiveTab).not.toHaveBeenCalled();
  });

  it('starts renaming the active tab from the menu', async () => {
    await renderApp();
    act(() => fake.emit('onRenameTab'));
    expect(screen.getByRole('textbox', { name: 'Tab name' })).toBeTruthy();
  });

  it('shows a running proxy, and how many tabs are running', async () => {
    await renderApp();
    switchTo('t1', [
      { ...one, running: true, port: 8000 },
      { ...two, running: true, port: 8001 },
    ]);
    expect(screen.getByText('Proxy running on port 8000')).toBeTruthy();
    expect(screen.getByLabelText('Running tabs').textContent).toBe('2 tabs running');
  });
});

describe('switching tabs', () => {
  it('reloads the traffic and settings of the tab switched to', async () => {
    fake.api.getTraffic.mockResolvedValueOnce([trafficEntry({ trafficId: 501, tabId: 't1' })]);
    await renderApp();
    expect(await screen.findByRole('row', { name: /^501/ })).toBeTruthy();

    fake.api.getTraffic.mockResolvedValueOnce([trafficEntry({ trafficId: 702, tabId: 't2' })]);
    fake.setStoredSettings({ dest: 'auth.test', listenPort: 8001 });
    switchTo('t2');
    expect(await screen.findByRole('row', { name: /^702/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /^501/ })).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText('Destination host')).toHaveProperty('value', 'auth.test')
    );
    expect(screen.getByLabelText('Listen port')).toHaveProperty('value', '8001');
    expect(fake.api.getHeldHits).toHaveBeenCalled();
  });

  it("restores each tab's filter when coming back to it", async () => {
    await renderApp();
    fireEvent.change(screen.getByLabelText('Filter traffic'), { target: { value: 'POST' } });
    switchTo('t2');
    await waitFor(() => expect(useProxyStore.getState().filterText).toBe(''));
    switchTo('t1');
    await waitFor(() => expect(useProxyStore.getState().filterText).toBe('POST'));
  });

  it('ignores traffic and proxy events from a background tab', async () => {
    await renderApp();
    act(() => fake.emit('onTraffic', trafficEntry({ trafficId: 733, tabId: 't2' })));
    act(() => fake.emit('onProxyState', { running: true, port: 8001, tabId: 't2' }));
    expect(screen.queryByRole('row', { name: /^733/ })).toBeNull();
    expect(screen.getByText('Proxy stopped')).toBeTruthy();
    act(() => fake.emit('onTraffic', trafficEntry({ trafficId: 534, tabId: 't1' })));
    expect(screen.getByRole('row', { name: /^534/ })).toBeTruthy();
  });

  it('marks new traffic in a background tab until it is looked at', async () => {
    await renderApp();
    switchTo('t1', [one, { ...two, trafficCount: 3 }]);
    expect(screen.getByLabelText('3 requests, new traffic')).toBeTruthy();
    switchTo('t2', [one, { ...two, trafficCount: 3 }]);
    expect(screen.getByLabelText('3 requests')).toBeTruthy();
  });
});

describe('held requests in a background tab', () => {
  it('flags the tab and offers to show it', async () => {
    await renderApp();
    switchTo('t1', [one, { ...two, heldCount: 1 }]);
    expect(screen.getByRole('tab', { name: /auth\.test.*1 held at a breakpoint/ })).toBeTruthy();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/"auth\.test" is holding a request/);
    fireEvent.click(notice);
    expect(fake.api.setActiveTab).toHaveBeenCalledWith('t2');
  });

  it("does not show another tab's held request in this tab's queue", async () => {
    await renderApp();
    act(() =>
      fake.emit('onBreakpointHit', {
        id: 1,
        tabId: 't2',
        phase: 'request',
        url: '/x',
        method: 'GET',
        headers: {},
        body: new Uint8Array(),
      })
    );
    expect(useBreakpointStore.getState().hits).toEqual([]);
    act(() =>
      fake.emit('onBreakpointHit', {
        id: 2,
        tabId: 't1',
        phase: 'request',
        url: '/y',
        method: 'GET',
        headers: {},
        body: new Uint8Array(),
      })
    );
    expect(useBreakpointStore.getState().hits.map((h) => h.id)).toEqual([2]);
  });
});
