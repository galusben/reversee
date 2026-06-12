// @vitest-environment jsdom
// Hit-queue ordering and resume payload tests for the breakpoint store.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBreakpointStore, ruleId } from '../../../src/renderer/src/stores/breakpointStore';

const resumeBreakpoint = vi.fn(() => Promise.resolve());
const setBreakpoints = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  window.reversee = {
    resumeBreakpoint,
    setBreakpoints,
  };
  useBreakpointStore.setState({ rules: [], hits: [], compileErrors: [], editorOpen: false });
});

const hit = (id) => ({ id, url: `/h${id}`, method: 'GET', headers: {}, body: new Uint8Array() });

describe('breakpoint hit queue', () => {
  it('queues hits in arrival order', () => {
    useBreakpointStore.setState({ hits: [hit(1), hit(2), hit(3)] });
    expect(useBreakpointStore.getState().hits.map((h) => h.id)).toEqual([1, 2, 3]);
  });

  it('resume forwards the edited params and removes only that hit', async () => {
    useBreakpointStore.setState({ hits: [hit(1), hit(2)] });
    const edited = { url: '/edited', method: 'POST', headers: { 'x-a': 'b' }, body: 'new body' };
    await useBreakpointStore.getState().resume(1, edited);
    expect(resumeBreakpoint).toHaveBeenCalledWith(1, edited);
    expect(useBreakpointStore.getState().hits.map((h) => h.id)).toEqual([2]);
  });

  it('resuming a middle hit keeps queue order for the rest', async () => {
    useBreakpointStore.setState({ hits: [hit(1), hit(2), hit(3)] });
    await useBreakpointStore.getState().resume(2, { url: '/x', method: 'GET', headers: {} });
    expect(useBreakpointStore.getState().hits.map((h) => h.id)).toEqual([1, 3]);
  });
});

describe('breakpoint rules', () => {
  it('generates order-independent rule ids', () => {
    expect(ruleId('/a', ['POST', 'GET'])).toBe(ruleId('/a', ['GET', 'POST']));
  });

  it('does not add duplicate rules', async () => {
    await useBreakpointStore.getState().addRule('/a', ['GET', 'POST']);
    await useBreakpointStore.getState().addRule('/a', ['POST', 'GET']);
    expect(useBreakpointStore.getState().rules).toHaveLength(1);
    expect(setBreakpoints).toHaveBeenCalledTimes(1);
  });

  it('removes rules by id', async () => {
    await useBreakpointStore.getState().addRule('/a', ['GET']);
    await useBreakpointStore.getState().addRule('/b', ['GET']);
    await useBreakpointStore.getState().removeRule(ruleId('/a', ['GET']));
    expect(useBreakpointStore.getState().rules.map((r) => r.path)).toEqual(['/b']);
  });
});
