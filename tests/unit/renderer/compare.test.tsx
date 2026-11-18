// @vitest-environment jsdom
// Compare two requests: the row context-menu flow (mark A, compare with B) and
// the Compare screen (summary, header tables, body diff).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry, settle } from './fake-api';
import { TrafficTable } from '../../../src/renderer/src/components/TrafficTable';
import { CompareDialog } from '../../../src/renderer/src/components/CompareDialog';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';

vi.mock('../../../src/renderer/src/components/MonacoViewImpl', async () => ({
  default: (await import('./fake-api')).FakeMonaco,
}));
vi.mock('../../../src/renderer/src/components/MonacoDiffImpl', async () => ({
  default: (await import('./fake-api')).FakeMonacoDiff,
}));

beforeEach(() => {
  installDomShims();
  resetStores();
  installFakeApi();
});
afterEach(() => cleanup());

const rows = () => screen.getAllByRole('row').slice(1);

function seed() {
  useProxyStore.setState({
    traffic: [
      trafficEntry({
        trafficId: 1,
        request: {
          url: '/me',
          method: 'GET',
          headers: { authorization: 'Bearer new', accept: '*/*' },
        },
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode('{"name":"a","ok":true}'),
        },
      }),
      trafficEntry({
        trafficId: 2,
        request: {
          url: '/me',
          method: 'GET',
          headers: { authorization: 'Bearer old', accept: '*/*' },
        },
        response: {
          statusCode: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
          body: new TextEncoder().encode('{"ok":false}'),
        },
      }),
    ],
  });
}

async function menuItem(row: HTMLElement, name: string | RegExp) {
  fireEvent.contextMenu(row);
  const menu = await screen.findByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name }));
}

describe('Compare from the traffic table', () => {
  it('marks a row as A, then compares it with another row', async () => {
    seed();
    render(
      <>
        <TrafficTable />
        <CompareDialog />
      </>
    );
    await menuItem(rows()[0], 'Mark for Compare');
    expect(useUiStore.getState().compareBaseId).toBe(1);
    expect(useUiStore.getState().notice?.text).toMatch(/Marked #1 as A/);
    expect(within(rows()[0]).getByTitle('Marked for compare (A)')).toBeTruthy();

    // Comparing the marked row with itself only explains what to do.
    await menuItem(rows()[0], 'Compare with #1');
    expect(useUiStore.getState().compareIds).toBeNull();
    expect(useUiStore.getState().notice?.text).toMatch(/different request/);

    await menuItem(rows()[1], 'Compare with #1');
    expect(useUiStore.getState().compareIds).toEqual([1, 2]);
    expect(useUiStore.getState().compareBaseId).toBeNull();
    expect(useUiStore.getState().notice).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Compare requests' });
    expect(within(dialog).getByText('status: 200 → 401')).toBeTruthy();
  });

  it('clears the mark', async () => {
    seed();
    render(<TrafficTable />);
    await menuItem(rows()[1], 'Mark for Compare');
    await menuItem(rows()[0], 'Clear Compare Mark');
    expect(useUiStore.getState().compareBaseId).toBeNull();
  });
});

describe('CompareDialog', () => {
  it('shows the differences, header tables and the body diff, and swaps sides', async () => {
    seed();
    useUiStore.setState({ compareIds: [1, 2] });
    render(<CompareDialog />);
    await settle(); // both sides are fetched from main
    const dialog = screen.getByRole('dialog', { name: 'Compare requests' });
    const summary = within(dialog).getByRole('list');
    expect(summary.textContent).toContain(
      'request header authorization: "Bearer new" → "Bearer old"'
    );
    expect(summary.textContent).toContain('response header www-authenticate only in B');

    const reqHeaders = within(dialog).getByRole('table', { name: 'Request headers' });
    // Identical headers are hidden until asked for.
    expect(within(reqHeaders).queryByText('accept')).toBeNull();
    expect(within(reqHeaders).getByText('authorization').closest('tr')?.dataset.diff).toBe(
      'changed'
    );
    fireEvent.click(within(dialog).getByLabelText('Show identical fields'));
    expect(
      within(within(dialog).getByRole('table', { name: 'Request headers' })).getByText('accept')
    ).toBeTruthy();
    const resHeaders = within(dialog).getByRole('table', { name: 'Response headers' });
    expect(within(resHeaders).getByText('www-authenticate').closest('tr')?.dataset.diff).toBe(
      'added'
    );

    // The body diff, JSON normalized (keys sorted, pretty-printed).
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: /Response Body/ }), { button: 0 });
    expect(within(dialog).getByText('Different (JSON, keys sorted)')).toBeTruthy();
    expect((await screen.findByTestId('monaco-diff')).dataset.language).toBe('json');
    expect(screen.getByTestId('diff-original').textContent).toBe(
      '{\n  "name": "a",\n  "ok": true\n}'
    );
    expect(screen.getByTestId('diff-modified').textContent).toBe('{\n  "ok": false\n}');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Swap A and B' }));
    expect(useUiStore.getState().compareIds).toEqual([2, 1]);
    expect(screen.getByText('status: 401 → 200')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    expect(useUiStore.getState().compareIds).toBeNull();
  });

  it('says so when the exchanges are identical, and renders nothing for a missing id', async () => {
    seed();
    useUiStore.setState({ compareIds: [1, 1] });
    const { unmount } = render(<CompareDialog />);
    await settle();
    expect(screen.getByText(/No differences/)).toBeTruthy();
    unmount();
    useUiStore.setState({ compareIds: [1, 99] });
    const { container } = render(<CompareDialog />);
    await settle();
    expect(container.innerHTML).toBe('');
  });
});
