// @vitest-environment jsdom
// The Radix dialogs: open/close behaviour (Escape, close button, focus
// containment) and each dialog's actions reaching the bridge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import { BreakpointsDialog } from '../../../src/renderer/src/components/BreakpointsDialog';
import { ConnectAiDialog } from '../../../src/renderer/src/components/ConnectAiDialog';
import { ProtoSpecsDialog } from '../../../src/renderer/src/components/ProtoSpecsDialog';
import { SummaryDialog } from '../../../src/renderer/src/components/SummaryDialog';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';
import { useProtoSpecStore } from '../../../src/renderer/src/stores/protoSpecStore';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';

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

const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('dialog behaviour (shared Radix contract)', () => {
  it.each([
    [
      'Breakpoints',
      <BreakpointsDialog key="b" />,
      () => useBreakpointStore.getState().setEditorOpen(true),
      () => useBreakpointStore.getState().editorOpen,
    ],
    [
      'Proto Specs',
      <ProtoSpecsDialog key="p" />,
      () => useProtoSpecStore.getState().setEditorOpen(true),
      () => useProtoSpecStore.getState().editorOpen,
    ],
    [
      'Connect an AI agent',
      <ConnectAiDialog key="c" />,
      () => useUiStore.getState().setConnectAiOpen(true),
      () => useUiStore.getState().connectAiOpen,
    ],
    [
      'Session summary',
      <SummaryDialog key="s" />,
      () => useUiStore.getState().setSummaryOpen(true),
      () => useUiStore.getState().summaryOpen,
    ],
  ])(
    '%s: opens from its store, closes on Escape and on the close button',
    async (title, element, open, isOpen) => {
      render(element);
      expect(screen.queryByRole('dialog')).toBeNull();

      act(open);
      const dialog = await screen.findByRole('dialog', { name: new RegExp(title) });
      // Focus moves into the dialog.
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

      escape();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(isOpen()).toBe(false);

      act(open);
      fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(isOpen()).toBe(false);
    }
  );
});

describe('BreakpointsDialog', () => {
  beforeEach(() => useBreakpointStore.setState({ editorOpen: true }));

  it('adds a rule with the chosen methods (Enter or Add), then clears the input', async () => {
    render(<BreakpointsDialog />);
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('POST'));
    const input = screen.getByLabelText('URL path regex') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/api/.*' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(fake.api.setBreakpoints).toHaveBeenCalledWith([
        { id: 'GET,POST /api/.*', path: '/api/.*', methods: ['GET', 'POST'] },
      ])
    );
    expect(input.value).toBe('');
    expect(await screen.findByText('GET, POST')).toBeTruthy();
  });

  it('cannot add with no methods selected', () => {
    render(<BreakpointsDialog />);
    fireEvent.click(screen.getByLabelText('GET'));
    fireEvent.change(screen.getByLabelText('URL path regex'), { target: { value: '/x' } });
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes a rule and shows compile errors', async () => {
    useBreakpointStore.setState({
      rules: [{ id: 'GET /a', path: '/a', methods: ['GET'] }],
      compileErrors: [{ id: 'GET /a', path: '/a', error: 'bad regex' }],
    });
    render(<BreakpointsDialog />);
    expect(screen.getByRole('alert').textContent).toContain('bad regex');
    fireEvent.click(screen.getByRole('button', { name: 'Delete breakpoint /a' }));
    await waitFor(() => expect(fake.api.setBreakpoints).toHaveBeenCalledWith([]));
    expect(await screen.findByText('No breakpoints defined.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ProtoSpecsDialog', () => {
  beforeEach(() => useProtoSpecStore.setState({ editorOpen: true }));

  it('imports through the native picker and lists the result', async () => {
    fake.api.importProtoSpec.mockResolvedValueOnce({
      specs: [{ id: 's1', name: 'echo.proto', source: 'proto' }],
      errors: [],
    } as never);
    render(<ProtoSpecsDialog />);
    fireEvent.click(screen.getByRole('button', { name: /Import/ }));
    expect(await screen.findByText('echo.proto')).toBeTruthy();
    expect(screen.getByText('proto (.proto)')).toBeTruthy();
    expect(useProtoSpecStore.getState().importing).toBe(false);
  });

  it('shows compile errors and removes specs', async () => {
    useProtoSpecStore.setState({
      specs: [{ id: 's1', name: 'x.desc', source: 'descriptor' } as never],
      compileErrors: [{ id: 's1', name: 'x.desc', error: 'corrupt' } as never],
    });
    render(<ProtoSpecsDialog />);
    expect(screen.getByRole('alert').textContent).toContain('Failed to compile “x.desc”: corrupt');
    fireEvent.click(screen.getByRole('button', { name: 'Delete proto spec x.desc' }));
    await waitFor(() => expect(fake.api.removeProtoSpec).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('No proto specs imported.')).toBeTruthy();
  });

  it('resets the importing flag when the import fails', async () => {
    fake.api.importProtoSpec.mockRejectedValueOnce(new Error('dialog failed'));
    await expect(useProtoSpecStore.getState().importSpec()).rejects.toThrow('dialog failed');
    expect(useProtoSpecStore.getState().importing).toBe(false);
  });
});

describe('ConnectAiDialog', () => {
  it('copies the setup snippets and flips to Copied briefly', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useUiStore.setState({ connectAiOpen: true });
    render(<ConnectAiDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Claude Code' }));
    expect(fake.api.copyToClipboard).toHaveBeenCalledWith(
      'claude mcp add reversee -- npx -y reversee-mcp'
    );
    expect(screen.getByRole('button', { name: 'Copy Claude Code' }).textContent).toContain(
      'Copied'
    );
    act(() => vi.advanceTimersByTime(1600));
    expect(screen.getByRole('button', { name: 'Copy Claude Code' }).textContent).not.toContain(
      'Copied'
    );

    fireEvent.click(screen.getByRole('button', { name: /Copy Cursor/ }));
    expect(fake.api.copyToClipboard).toHaveBeenLastCalledWith(
      expect.stringContaining('"reversee-mcp"')
    );
  });

  it('opens the docs link in a new window (main denies and routes it)', () => {
    useUiStore.setState({ connectAiOpen: true });
    render(<ConnectAiDialog />);
    const link = screen.getByRole('link', { name: /Learn more/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toMatch(/^https:\/\/github\.com\/galusben\/reversee/);
  });
});

describe('SummaryDialog', () => {
  it('summarizes traffic and jumps to an error entry', async () => {
    useProxyStore.setState({
      traffic: [
        trafficEntry({ trafficId: 1 }),
        trafficEntry({
          trafficId: 2,
          request: { url: '/fail', method: 'POST', headers: {} },
          response: { statusCode: 500, headers: {} },
        }),
      ],
    });
    useUiStore.setState({ summaryOpen: true });
    render(<SummaryDialog />);
    expect(screen.getByText('2 requests captured')).toBeTruthy();
    expect(screen.getByText('Errors (1)')).toBeTruthy();

    // Listed under both Slowest and Errors; take the error row (shows the status).
    fireEvent.click(screen.getByRole('button', { name: /POST \/fail\s*500$/ }));
    expect(useProxyStore.getState().selectedId).toBe(2);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
