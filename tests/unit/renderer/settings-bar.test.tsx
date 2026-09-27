// @vitest-environment jsdom
// The listen/destination bar: validation gates Start, edits persist through
// the bridge, and the form locks while the proxy runs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores } from './fake-api';
import { SettingsBar } from '../../../src/renderer/src/components/SettingsBar';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';

let fake: ReturnType<typeof installFakeApi>;

beforeEach(async () => {
  installDomShims();
  resetStores();
  fake = installFakeApi();
  await useProxyStore.getState().init();
});
afterEach(cleanup);

const startButton = () => screen.getByRole('button', { name: /Start/ }) as HTMLButtonElement;

describe('SettingsBar', () => {
  it('renders nothing until settings load', () => {
    resetStores();
    const { container } = render(<SettingsBar />);
    expect(container.innerHTML).toBe('');
  });

  it('persists edits through setSettings', async () => {
    render(<SettingsBar />);
    fireEvent.change(screen.getByLabelText('Destination host'), {
      target: { value: '  example.com ' },
    });
    fireEvent.change(screen.getByLabelText('Destination protocol'), { target: { value: 'http' } });
    fireEvent.change(screen.getByLabelText('Listen port'), { target: { value: '9090' } });
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledTimes(3));
    expect(fake.api.setSettings).toHaveBeenCalledWith({ dest: 'example.com' });
    expect(fake.api.setSettings).toHaveBeenCalledWith({ destProtocol: 'http' });
    expect(fake.api.setSettings).toHaveBeenCalledWith({ listenPort: 9090 });
  });

  it.each(['0', '65536', 'abc', '80.5', ''])(
    'marks listen port %j invalid, does not persist it, and disables Start',
    (value) => {
      render(<SettingsBar />);
      const input = screen.getByLabelText('Listen port');
      fireEvent.change(input, { target: { value } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(fake.api.setSettings).not.toHaveBeenCalled();
      expect(startButton().disabled).toBe(true);
    }
  );

  it('re-enables Start once the port is fixed', () => {
    render(<SettingsBar />);
    const input = screen.getByLabelText('Destination port');
    fireEvent.change(input, { target: { value: '0' } });
    expect(startButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: '8443' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(startButton().disabled).toBe(false);
  });

  it('disables Start without a destination host', async () => {
    fake.setStoredSettings({ dest: '' });
    await useProxyStore.getState().init();
    render(<SettingsBar />);
    expect(startButton().disabled).toBe(true);
  });

  it('starts the proxy, and shows a start failure', async () => {
    render(<SettingsBar />);
    fireEvent.click(startButton());
    await waitFor(() => expect(fake.api.startProxy).toHaveBeenCalledOnce());

    fake.api.startProxy.mockResolvedValueOnce({ ok: false, error: { message: 'boom' } } as never);
    fireEvent.click(startButton());
    await waitFor(() => expect(useProxyStore.getState().error).toEqual({ message: 'boom' }));
  });

  it('locks the form and offers Stop while running', async () => {
    render(<SettingsBar />);
    act(() => fake.emit('onProxyState', { running: true, port: 8000 }));
    for (const label of ['Listen port', 'Destination host', 'Listen protocol']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(fake.api.stopProxy).toHaveBeenCalledOnce());
  });

  it('toggles gRPC and opens the breakpoint and AI dialogs', async () => {
    render(<SettingsBar />);
    fireEvent.click(screen.getByLabelText('gRPC'));
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledWith({ enableGrpc: true }));

    fireEvent.click(screen.getByRole('button', { name: /Breakpoints/ }));
    expect(useBreakpointStore.getState().editorOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Connect AI/ }));
    expect(useUiStore.getState().connectAiOpen).toBe(true);
  });

  it('shows the breakpoint rule count', () => {
    useBreakpointStore.setState({ rules: [{ id: 'a', path: '/a', methods: ['GET'] }] });
    render(<SettingsBar />);
    expect(screen.getByRole('button', { name: 'Breakpoints (1)' })).toBeTruthy();
  });
});
