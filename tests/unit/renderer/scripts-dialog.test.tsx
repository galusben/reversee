// @vitest-environment jsdom
// The Scripts screen (request and response interceptors) and its toolbar
// button: drafts and saving, examples, the dry run, and failure reporting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import { ScriptsDialog, lastScriptError } from '../../../src/renderer/src/components/ScriptsDialog';
import { SettingsBar } from '../../../src/renderer/src/components/SettingsBar';
import {
  SCRIPT_FIELDS,
  SCRIPT_SNIPPETS,
  appendSnippet,
} from '../../../src/renderer/src/lib/script-snippets';
import { tryScript } from '../../../src/proxy/core/try-script';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
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
afterEach(cleanup);

async function open(settings: Record<string, unknown> = {}, traffic: unknown[] = []) {
  fake.setStoredSettings(settings);
  await useProxyStore.getState().init();
  useProxyStore.setState({ traffic: traffic as never });
  act(() => useUiStore.getState().setScriptsOpen(true));
  render(<ScriptsDialog />);
  return screen.findByTestId('monaco');
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('ScriptsDialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<ScriptsDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('shows an editable JavaScript editor with a reference and examples', async () => {
    const editor = await open({ requestInterceptor: '// mine' });
    expect(editor.tagName).toBe('TEXTAREA');
    expect(editor.getAttribute('data-language')).toBe('javascript');
    expect((editor as HTMLTextAreaElement).value).toBe('// mine');
    expect(tab(/Request script/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('requestParams.path')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add a header/ })).toBeTruthy();
    expect(screen.getByText(/Scripts take effect when the proxy is started/)).toBeTruthy();
  });

  it('saves nothing until Save, then writes both scripts and their switches', async () => {
    const editor = await open();
    fireEvent.change(editor, { target: { value: "requestParams.headers['a'] = '1'" } });
    fireEvent.click(screen.getByLabelText('Run on every request'));
    fireEvent.click(tab(/Response script/));
    fireEvent.change(await screen.findByTestId('monaco'), {
      target: { value: 'responseParams.statusCode = 500' },
    });
    expect(fake.api.setSettings).not.toHaveBeenCalled();

    save();
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledOnce());
    expect(fake.api.setSettings).toHaveBeenCalledWith({
      interceptRequest: true,
      requestInterceptor: "requestParams.headers['a'] = '1'",
      interceptResponse: false,
      responseInterceptor: 'responseParams.statusCode = 500',
    });
    expect(useUiStore.getState().scriptsOpen).toBe(false);
  });

  it('Cancel discards the draft', async () => {
    const editor = await open();
    fireEvent.change(editor, { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fake.api.setSettings).not.toHaveBeenCalled();
    expect(useUiStore.getState().scriptsOpen).toBe(false);
  });

  it('stays editable while the proxy runs and says changes apply at once', async () => {
    await open({ interceptRequest: true });
    act(() => useProxyStore.setState({ running: true }));
    expect((await screen.findByTestId('monaco')).tagName).toBe('TEXTAREA');
    expect((screen.getByLabelText('Run on every request') as HTMLInputElement).disabled).toBe(
      false
    );
    expect(screen.getByText(/applies the scripts to the running proxy at once/)).toBeTruthy();
  });

  it('shows On/Off per script and opens on the one that is on', async () => {
    await open({ interceptResponse: true });
    expect(tab(/Response script/).getAttribute('aria-selected')).toBe('true');
    expect(within(tab(/Response script/)).getByText('On')).toBeTruthy();
    expect(within(tab(/Request script/)).getByText('Off')).toBeTruthy();
    expect(screen.getByLabelText('Run on every response')).toBeTruthy();
    expect(screen.getByText('responseParams.statusCode')).toBeTruthy();

    fireEvent.click(tab(/Request script/));
    expect(screen.getByText(/the script is kept but does not run/)).toBeTruthy();
  });

  it('inserting an example appends it to the script', async () => {
    await open({ requestInterceptor: 'first();' });
    fireEvent.click(screen.getByRole('button', { name: /Remove a header/ }));
    save();
    await waitFor(() => expect(fake.api.setSettings).toHaveBeenCalledOnce());
    expect(fake.api.setSettings.mock.calls[0][0].requestInterceptor).toBe(
      "first();\n\ndelete requestParams.headers['cookie'];\n"
    );
  });

  it('reports the latest live failure of a script that is on', async () => {
    await open({ interceptRequest: true }, [
      trafficEntry({
        trafficId: 1,
        interceptorErrors: [{ phase: 'request', message: 'nope is not defined' }],
      }),
    ]);
    expect(screen.getByRole('status').textContent).toBe('last run failed: nope is not defined');
    fireEvent.click(tab(/Response script/));
    expect(screen.queryByRole('status')).toBeNull();
  });

  describe('try it', () => {
    it('asks for a captured request when there is none', async () => {
      await open();
      expect(screen.getByText(/Capture a request first/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try it' })).toBeNull();
    });

    it('runs the draft against the picked request and lists the changes', async () => {
      const editor = await open({}, [
        trafficEntry({ trafficId: 4, request: { method: 'GET', url: '/old', headers: {} } }),
        trafficEntry({ trafficId: 5, request: { method: 'POST', url: '/new', headers: {} } }),
        trafficEntry({ trafficId: 6, pending: true }),
      ]);
      const picker = screen.getByLabelText(
        'Captured request to try the script on'
      ) as HTMLSelectElement;
      // Newest first; an exchange still in flight is not offered.
      expect([...picker.options].map((o) => o.value)).toEqual(['5', '4']);
      expect(picker.options[0].textContent).toContain('POST /new');

      fireEvent.change(editor, { target: { value: 'draft code' } });
      fireEvent.change(picker, { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
      await waitFor(() =>
        expect(fake.api.tryScript).toHaveBeenCalledWith('request', 'draft code', 4)
      );
      const result = await screen.findByLabelText('Try it result');
      expect(within(result).getByText(/made 1 change:/)).toBeTruthy();
      expect(within(result).getByText('header x-debug added: true')).toBeTruthy();
      expect(within(result).getByText('GET /')).toBeTruthy(); // console output
      expect(fake.api.setSettings).not.toHaveBeenCalled(); // a dry run saves nothing
    });

    it('shows a script failure, a no-op run and a run that could not start', async () => {
      await open({}, [trafficEntry({ trafficId: 1 })]);
      const exchange = {
        request: { method: 'GET', path: '/', host: 'h', port: 80, headers: {}, body: '' },
      };
      const run = async (outcome: unknown) => {
        fake.api.tryScript.mockResolvedValueOnce(outcome as never);
        fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
      };

      await run({
        ok: true,
        before: exchange,
        after: exchange,
        changes: [],
        logs: [],
        error: 'x is not defined',
      });
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The script failed: x is not defined'
      );

      await run({ ok: true, before: exchange, after: exchange, changes: [], logs: [] });
      expect(await screen.findByText(/changed nothing for this request/)).toBeTruthy();

      await run({ ok: false, error: 'That request is no longer in the list.' });
      expect((await screen.findByRole('alert')).textContent).toBe(
        'Could not run the script: That request is no longer in the list.'
      );
    });

    it('tries the response script with the response body shown afterwards', async () => {
      await open({ interceptResponse: true }, [trafficEntry({ trafficId: 2 })]);
      const before = {
        request: { method: 'GET', path: '/', host: 'h', port: 80, headers: {}, body: '' },
        response: { statusCode: 200, headers: {}, body: 'a' },
      };
      // The real engine, so the screen is checked against what the worker returns.
      fake.api.tryScript.mockImplementationOnce(((kind: 'response', code: string) => {
        const { error, logs, ...after } = tryScript({ kind, code, ...before });
        return Promise.resolve({
          ok: true,
          before,
          after,
          changes: ['status: 200 → 418'],
          error,
          logs,
        });
      }) as never);
      fireEvent.change(await screen.findByTestId('monaco'), {
        target: { value: "responseParams.statusCode = 418; responseParams.body = 'teapot'" },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
      const result = await screen.findByLabelText('Try it result');
      expect(within(result).getByText('status: 200 → 418')).toBeTruthy();
      expect(within(result).getByText('teapot')).toBeTruthy();
    });
  });
});

describe('Scripts toolbar button', () => {
  async function bar(settings: Record<string, unknown> = {}, traffic: unknown[] = []) {
    fake.setStoredSettings(settings);
    await useProxyStore.getState().init();
    useProxyStore.setState({ traffic: traffic as never });
    render(<SettingsBar />);
  }

  it('opens the screen and shows no badge while both scripts are off', async () => {
    await bar();
    const button = screen.getByRole('button', { name: 'Scripts' });
    expect(button.textContent).toBe('Scripts');
    fireEvent.click(button);
    expect(useUiStore.getState().scriptsOpen).toBe(true);
  });

  it('counts the scripts that are on', async () => {
    await bar({ interceptRequest: true, interceptResponse: true });
    expect(screen.getByRole('button', { name: 'Scripts, 2 on' }).textContent).toBe('Scripts2');
  });

  it('turns into a warning when a script failed on the latest request', async () => {
    await bar({ interceptResponse: true }, [
      trafficEntry({ interceptorErrors: [{ phase: 'response', message: 'boom' }] }),
    ]);
    const button = screen.getByRole('button', { name: 'Scripts, 1 on, last run failed' });
    expect(button.textContent).toBe('Scripts!');
    expect(button.getAttribute('title')).toBe('A script failed on the last request: boom');
  });
});

describe('lastScriptError', () => {
  const failed = (phase: string, extra = {}) =>
    trafficEntry({ interceptorErrors: [{ phase, message: `${phase} broke` }], ...extra });

  it('looks only at the latest live exchange', () => {
    expect(lastScriptError([], 'request')).toBeNull();
    expect(lastScriptError([failed('request')] as never, 'request')).toBe('request broke');
    expect(lastScriptError([failed('request')] as never, 'response')).toBeNull();
    // A later clean run clears it.
    expect(lastScriptError([failed('request'), trafficEntry()] as never, 'request')).toBeNull();
  });

  it('skips entries no script ran for', () => {
    const skipped = ['mocked', 'replay', 'imported', 'pending'].map((flag) =>
      trafficEntry({ [flag]: true })
    );
    expect(lastScriptError([failed('response'), ...skipped] as never, 'response')).toBe(
      'response broke'
    );
  });
});

describe('script examples', () => {
  it('every example runs cleanly in the real engine', () => {
    const request = {
      method: 'POST',
      path: '/api/v1/users',
      host: 'h',
      port: 80,
      headers: { cookie: 'a=b' },
      body: '{"a":1}',
    };
    const response = { statusCode: 200, headers: {}, body: '{"a":1}' };
    for (const kind of ['request', 'response'] as const) {
      expect(SCRIPT_FIELDS[kind].length).toBeGreaterThan(2);
      for (const snippet of SCRIPT_SNIPPETS[kind]) {
        const result = tryScript({ kind, code: snippet.code, request, response });
        expect(result.error, `${kind}: ${snippet.label}`).toBeUndefined();
      }
    }
  });

  it('appendSnippet adds under existing code, or starts a script', () => {
    expect(appendSnippet('', 'x();')).toBe('x();\n');
    expect(appendSnippet('  \n', 'x();')).toBe('x();\n');
    expect(appendSnippet('a();\n\n', 'x();')).toBe('a();\n\nx();\n');
  });
});
