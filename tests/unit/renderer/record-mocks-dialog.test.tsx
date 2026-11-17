// @vitest-environment jsdom
// The "Record as mocks" dialog: scope choice (all / filtered / one request),
// the preview of what will be saved and skipped, and the save call.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { installFakeApi, installDomShims, resetStores, trafficEntry } from './fake-api';
import { TrafficTable } from '../../../src/renderer/src/components/TrafficTable';
import { RecordMocksDialog } from '../../../src/renderer/src/components/RecordMocksDialog';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';
import { defaultSettings } from '../../../src/shared/settings-schema';

let fake: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  installDomShims();
  resetStores();
  fake = installFakeApi();
  useProxyStore.setState({
    settings: { ...defaultSettings, mocks: [] },
    traffic: [
      trafficEntry({ trafficId: 1, request: { url: '/api/users', method: 'GET', headers: {} } }),
      trafficEntry({ trafficId: 2, request: { url: '/api/users', method: 'GET', headers: {} } }),
      trafficEntry({ trafficId: 3, request: { url: '/health', method: 'GET', headers: {} } }),
      trafficEntry({
        trafficId: 4,
        request: { url: '/slow', method: 'GET', headers: {} },
        pending: true,
      }),
    ] as never,
  });
});
afterEach(cleanup);

const preview = () => screen.getByLabelText('Recording preview');

describe('Record as mocks', () => {
  it('opens from the toolbar and records all captured traffic', async () => {
    render(
      <>
        <TrafficTable />
        <RecordMocksDialog />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Record as mocks' }));
    const dialog = screen.getByRole('dialog', { name: 'Record as mocks' });
    expect(
      (within(dialog).getByLabelText('All captured requests (4)') as HTMLInputElement).checked
    ).toBe(true);
    expect(preview().textContent).toContain('2 new mocks');
    expect(preview().textContent).toContain('#2 → GET, path is "/api/users" -> 200');
    expect(preview().textContent).toContain('Skipped 1: still in flight');
    expect(preview().textContent).toContain(
      'Skipped 1: same request recorded again later (the latest is kept)'
    );
    expect(dialog.textContent).toContain('They answer once the proxy starts.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Record 2 mocks' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.api.recordMocks).toHaveBeenCalledWith(undefined, { ignoreQuery: false });
    expect(useUiStore.getState().notice?.text).toMatch(/^Recorded 2 new mocks\./);
  });

  it('offers the filtered rows, and sends their ids', async () => {
    useProxyStore.setState({ filterText: 'users', running: true });
    useUiStore.getState().setRecordMocks(true);
    render(<RecordMocksDialog />);
    expect(
      (screen.getByLabelText('The 2 requests the filter lists') as HTMLInputElement).checked
    ).toBe(true);
    expect(preview().textContent).toContain('1 new mock');
    expect(screen.getByRole('dialog').textContent).toContain('They answer at once.');
    fireEvent.click(screen.getByLabelText('Match any query string', { exact: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Record 1 mock' }));
    await waitFor(() =>
      expect(fake.api.recordMocks).toHaveBeenCalledWith([1, 2], { ignoreQuery: true })
    );
  });

  it('records one request from the row context menu, and shows updates of saved mocks', async () => {
    useProxyStore.setState({
      settings: {
        ...defaultSettings,
        mocks: [
          {
            id: 'mine',
            enabled: true,
            method: 'GET',
            pathPattern: '^/health(?:\\?.*)?$',
            statusCode: 200,
            headers: {},
            body: 'old',
          },
        ],
      },
    });
    useUiStore.getState().setRecordMocks(true, 3);
    render(<RecordMocksDialog />);
    expect((screen.getByLabelText('Only #3: GET /health') as HTMLInputElement).checked).toBe(true);
    expect(preview().textContent).toContain('0 new mocks, 1 updated');
    fireEvent.click(screen.getByRole('button', { name: 'Record 1 mock' }));
    await waitFor(() =>
      expect(fake.api.recordMocks).toHaveBeenCalledWith([3], { ignoreQuery: false })
    );
  });

  it('cannot record when nothing qualifies', () => {
    useUiStore.getState().setRecordMocks(true, 4);
    render(<RecordMocksDialog />);
    expect(preview().textContent).toContain('Nothing to record.');
    expect((screen.getByRole('button', { name: 'Record' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
