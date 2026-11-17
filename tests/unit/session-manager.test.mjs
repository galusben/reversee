// Tabs in main (src/main/session-manager.ts + session.ts): one proxy session
// per saved tab, kept in step with the tabs in settings, with ids that are
// unique across tabs. ProxyHost (a utilityProcess) is faked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const backing = new Map();
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(key) {
      return backing.get(key);
    }
    set(key, value) {
      backing.set(key, structuredClone(value));
    }
    has(key) {
      return backing.has(key);
    }
    delete(key) {
      backing.delete(key);
    }
  },
}));
vi.mock('electron', () => ({}));
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));

const settings = await import('../../src/main/settings');
const { SessionManager } = await import('../../src/main/session-manager');

let manager;
let hosts;
let events;

function fakeHost(hostEvents) {
  const host = {
    events: hostEvents,
    start: vi.fn(async ({ settings: s }) => {
      hostEvents.onStateChanged(true, s.listenPort);
      return s.listenPort;
    }),
    stop: vi.fn(() => hostEvents.onStateChanged(false)),
    restart: vi.fn(),
    kill: vi.fn(),
    setBreakpoints: vi.fn(),
    setRules: vi.fn(),
    setScripts: vi.fn(),
    setProtoSpecs: vi.fn(),
    resumeBreakpoint: vi.fn(),
    tryScript: vi.fn(),
  };
  hosts.push(host);
  return host;
}

const entry = (url) => ({
  trafficId: 0,
  request: { method: 'GET', url, headers: {} },
  response: { statusCode: 200, headers: {} },
  timings: { start: new Date().toISOString() },
});

beforeEach(() => {
  backing.clear();
  hosts = [];
  events = {
    traffic: vi.fn(),
    trafficCleared: vi.fn(),
    state: vi.fn(),
    error: vi.fn(),
    breakpointHit: vi.fn(),
    breakpointResumed: vi.fn(),
    breakpointsChanged: vi.fn(),
    breakpointErrors: vi.fn(),
    tabsChanged: vi.fn(),
  };
  settings.setSettings({ dest: 'one.test' });
  manager = new SessionManager({
    getLeafCert: () => undefined,
    issueCert: () => ({ key: 'k', cert: 'c' }),
    createProxyHost: fakeHost,
    events,
    summaryDelayMs: 0,
  });
});

afterEach(() => manager.dispose());

describe('SessionManager', () => {
  it('starts with a session for every saved tab and follows created and closed tabs', () => {
    expect(manager.all().map((s) => s.id)).toEqual(['t1']);
    manager.create({ settings: { dest: 'two.test' } });
    expect(manager.all().map((s) => s.id)).toEqual(['t1', 't2']);
    expect(manager.activeTabId).toBe('t2');
    expect(events.tabsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeTabId: 't2' })
    );

    manager.close('t2');
    expect(manager.all().map((s) => s.id)).toEqual(['t1']);
    // The closed tab's worker is stopped for good.
    expect(hosts[1].kill).toHaveBeenCalled();
  });

  it('numbers requests and held exchanges uniquely across tabs, and tags them with the tab', () => {
    manager.create({ settings: { dest: 'two.test' } });
    const [a, b] = manager.all();
    a.recordTraffic(entry('/a'));
    b.recordTraffic(entry('/b'));
    a.recordTraffic(entry('/c'));
    expect(a.trafficStore.getAll().map((e) => [e.trafficId, e.tabId])).toEqual([
      [1, 't1'],
      [3, 't1'],
    ]);
    expect(manager.findTraffic(2)).toMatchObject({ session: b, entry: { request: { url: '/b' } } });

    hosts[0].events.onBreakpointHit({ id: 0, phase: 'request', url: '/a', method: 'GET' });
    hosts[1].events.onBreakpointHit({ id: 0, phase: 'request', url: '/b', method: 'GET' });
    expect(manager.allHeldHits().map((h) => [h.id, h.tabId])).toEqual([
      [1, 't1'],
      [2, 't2'],
    ]);
    expect(manager.findHeld(2)).toBe(b);
    b.resumeHeld(2, { url: '/b', method: 'GET', headers: {} });
    expect(hosts[1].resumeBreakpoint).toHaveBeenCalledWith(0, expect.anything());
    expect(manager.snapshot().tabs.map((t) => t.heldCount)).toEqual([1, 0]);
  });

  it('refuses to start a tab on a port another running tab listens on, naming that tab', async () => {
    manager.create({ settings: { dest: 'two.test', listenPort: 8000 } });
    const [a, b] = manager.all();
    await expect(a.start()).resolves.toEqual({ ok: true, port: 8000 });
    const result = await b.start();
    expect(result).toMatchObject({ ok: false, error: { code: 'EADDRINUSE' } });
    expect(result.error.message).toContain('the tab "one.test" (t1)');
    expect(hosts[1].start).not.toHaveBeenCalled();
    expect(manager.snapshot().tabs[1].error).toMatch(/already used/);
  });

  it('resolves a tab reference by id or name, defaulting to the active tab', () => {
    manager.create({ settings: { dest: 'two.test' }, name: 'Mobile', activate: false });
    expect(manager.resolve().id).toBe('t1');
    expect(manager.resolve('t2').id).toBe('t2');
    expect(manager.resolve('mobile').id).toBe('t2');
    expect(() => manager.resolve('t9')).toThrow(
      /no tab "t9" \(open tabs: t1 "one.test", t2 "Mobile"/
    );
  });

  it("applies rule and script changes to that tab's worker only", () => {
    manager.create({ activate: false });
    hosts.forEach((h) => h.setRules.mockClear());
    settings.setSettings({ mocks: [] }, 't2');
    expect(hosts[1].setRules).toHaveBeenCalled();
    expect(hosts[0].setRules).not.toHaveBeenCalled();
  });

  it('summarises each tab for the tab strip', async () => {
    const [a] = manager.all();
    a.recordTraffic({ ...entry('/x'), pending: true });
    await a.start();
    expect(manager.snapshot()).toEqual({
      activeTabId: 't1',
      tabs: [
        {
          id: 't1',
          name: 'one.test',
          nameIsCustom: false,
          running: true,
          port: 8000,
          listenProtocol: 'http',
          listenPort: 8000,
          captureAll: false,
          destination: 'https://one.test:443',
          trafficCount: 1,
          pendingCount: 1,
          heldCount: 0,
        },
      ],
    });
  });

  it('pushes compiled proto specs to every tab, including ones opened later', () => {
    const bundle = { specs: [], methodMap: {} };
    manager.setProtoSpecs(bundle);
    manager.create();
    expect(hosts[0].setProtoSpecs).toHaveBeenCalledWith(bundle);
    expect(hosts[1].setProtoSpecs).toHaveBeenCalledWith(bundle);
  });
});
