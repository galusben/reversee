// The pure tab helpers (src/shared/tabs.ts) shared by main, the window and MCP:
// which settings are per tab, how tabs are named, and how a reference resolves.
import { describe, it, expect } from 'vitest';
import {
  autoTabBaseName,
  isGlobalKey,
  nextFreeListenPort,
  resolveTabRef,
  splitSettingsPatch,
  tabNameError,
  uniqueTabName,
} from '../../src/shared/tabs';

describe('tab settings split', () => {
  it('keeps theme, the MCP switches and the history cap global; the rest is per tab', () => {
    expect(['theme', 'mcpEnabled', 'mcpAllowControl', 'trafficCap'].every(isGlobalKey)).toBe(true);
    expect(isGlobalKey('dest')).toBe(false);
    expect(splitSettingsPatch({ theme: 'dark', dest: 'a', mocks: [] })).toEqual({
      global: { theme: 'dark' },
      tab: { dest: 'a', mocks: [] },
    });
  });
});

describe('tab names', () => {
  it('derives a name from the destination', () => {
    expect(autoTabBaseName({ captureAll: false, dest: ' api.test ' })).toBe('api.test');
    expect(autoTabBaseName({ captureAll: false, dest: '' })).toBe('New tab');
    expect(autoTabBaseName({ captureAll: true, dest: 'api.test' })).toBe('Capture anything');
  });

  it('adds the lowest free #n suffix on a clash, ignoring case', () => {
    expect(uniqueTabName('api', [])).toBe('api');
    expect(uniqueTabName('api', ['API'])).toBe('api #2');
    expect(uniqueTabName('api', ['api', 'api #3'])).toBe('api #2');
    expect(uniqueTabName('api', ['api', 'api #2', 'api #3'])).toBe('api #4');
  });

  it('validates a chosen name', () => {
    expect(tabNameError('Web', ['api'])).toBeNull();
    expect(tabNameError('  ', [])).toMatch(/cannot be empty/);
    expect(tabNameError('x'.repeat(61), [])).toMatch(/at most 60/);
    expect(tabNameError('T12', [])).toMatch(/looks like a tab id/);
    expect(tabNameError('API', ['api'])).toBe('Another tab is already called "API"');
  });
});

describe('resolveTabRef', () => {
  const tabs = [
    { id: 't1', name: 'api.test' },
    { id: 't2', name: 'Mobile app' },
  ];

  it('finds a tab by id first, then by name (case-insensitive)', () => {
    expect(resolveTabRef(tabs, 't2')?.name).toBe('Mobile app');
    expect(resolveTabRef(tabs, 'T1')?.name).toBe('api.test');
    expect(resolveTabRef(tabs, ' mobile APP ')?.id).toBe('t2');
    expect(resolveTabRef(tabs, 'nope')).toBeUndefined();
  });
});

describe('nextFreeListenPort', () => {
  it('skips the ports other tabs are configured with', () => {
    const tab = (listenPort) => ({ settings: { listenPort } });
    expect(nextFreeListenPort([tab(8000), tab(8001), tab(8003)])).toBe(8002);
    expect(nextFreeListenPort([tab(9000)], 9000)).toBe(9001);
  });
});
