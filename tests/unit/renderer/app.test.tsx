// @vitest-environment jsdom
// Renderer integration: the whole <App/> against a fake preload bridge. Covers
// startup wiring (settings/traffic/breakpoints/proto specs loaded, every main
// -> renderer event subscribed) and how the UI reacts to those events.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import App from '../../../src/renderer/src/App';

vi.mock('../../../src/renderer/src/components/MonacoViewImpl', async () => ({
  default: (await import('./fake-api')).FakeMonaco,
}));

let fake: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  installDomShims();
  resetStores();
  localStorage.clear();
  fake = installFakeApi();
});
afterEach(cleanup);

async function renderApp() {
  const utils = render(<App />);
  await screen.findByRole('button', { name: /Start/ });
  return utils;
}

describe('App startup', () => {
  it('loads settings, traffic, breakpoints, and proto specs from main', async () => {
    fake.api.getTraffic.mockResolvedValueOnce([trafficEntry({ trafficId: 41 })]);
    await renderApp();
    expect(fake.api.getSettings).toHaveBeenCalled();
    expect(fake.api.getBreakpoints).toHaveBeenCalled();
    expect(fake.api.getProtoSpecs).toHaveBeenCalled();
    expect(screen.getByLabelText('Destination host')).toHaveProperty('value', 'api.test');
    expect(screen.getByRole('row', { name: /41/ })).toBeTruthy();
    expect(screen.getByText('Proxy stopped')).toBeTruthy();
  });

  it('subscribes to every main -> renderer event', async () => {
    await renderApp();
    for (const name of [
      'onTraffic',
      'onTrafficCleared',
      'onBreakpointHit',
      'onBreakpointErrors',
      'onOpenBreakpoints',
      'onOpenConnectAi',
      'onOpenProtoSpecs',
      'onProxyState',
      'onProxyError',
      'onSettingsChanged',
    ] as const) {
      expect(fake.listenerCount(name), name).toBeGreaterThan(0);
    }
  });

  it('migrates pre-2.0 localStorage settings once, then clears them', async () => {
    localStorage.setItem('userSettings', JSON.stringify({ dest: 'legacy.test' }));
    await renderApp();
    expect(fake.api.migrateLegacySettings).toHaveBeenCalledWith({ dest: 'legacy.test' });
    expect(localStorage.getItem('userSettings')).toBeNull();
  });

  it('survives a malformed legacy payload', async () => {
    localStorage.setItem('userSettings', '{not json');
    await renderApp();
    expect(fake.api.migrateLegacySettings).not.toHaveBeenCalled();
    expect(localStorage.getItem('userSettings')).toBeNull();
  });
});

describe('App reacting to main events', () => {
  it('shows live traffic, updates in place, and clears', async () => {
    await renderApp();
    act(() => fake.emit('onTraffic', trafficEntry({ trafficId: 7 })));
    expect(await screen.findByRole('row', { name: /7.*\/api\/items.*200/ })).toBeTruthy();

    // A streaming update for the same id replaces the row rather than appending.
    act(() =>
      fake.emit(
        'onTraffic',
        trafficEntry({ trafficId: 7, response: { statusCode: 503, headers: {} } })
      )
    );
    await waitFor(() => expect(screen.getByRole('row', { name: /7.*503/ })).toBeTruthy());
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + 1

    act(() => fake.emit('onTrafficCleared'));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1));
  });

  it('reflects proxy state and errors, and the error can be dismissed', async () => {
    await renderApp();
    act(() => fake.emit('onProxyState', { running: true, port: 9100 }));
    expect(await screen.findByText('Proxy running on port 9100')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy();

    act(() => fake.emit('onProxyError', { code: 'EADDRINUSE', message: 'port taken' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('EADDRINUSE: port taken');
    expect(screen.getByText('Proxy stopped')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('opens dialogs from menu events', async () => {
    await renderApp();
    act(() => fake.emit('onOpenConnectAi'));
    expect(await screen.findByRole('dialog', { name: /Connect an AI agent/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    act(() => fake.emit('onOpenBreakpoints'));
    expect(await screen.findByRole('dialog', { name: 'Breakpoints' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    act(() => fake.emit('onOpenProtoSpecs'));
    expect(await screen.findByRole('dialog', { name: 'Proto Specs' })).toBeTruthy();
  });

  it('shows a held request when a breakpoint hits', async () => {
    await renderApp();
    act(() =>
      fake.emit('onBreakpointHit', {
        id: 3,
        url: '/held',
        method: 'POST',
        headers: { 'x-a': '1' },
        body: new TextEncoder().encode('payload'),
      })
    );
    const region = await screen.findByRole('region', { name: 'Held request' });
    expect(region.querySelector('input[aria-label="URL"]')).toHaveProperty('value', '/held');
  });

  it('applies settings pushed from main (menu, MCP)', async () => {
    await renderApp();
    const current = await fake.api.getSettings();
    act(() => fake.emit('onSettingsChanged', { ...current, dest: 'mcp.test' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Destination host')).toHaveProperty('value', 'mcp.test')
    );
  });
});
