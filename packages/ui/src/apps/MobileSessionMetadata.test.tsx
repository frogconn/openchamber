import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }),
}));

let MobileSessionMetadataButton: typeof import('./MobileSessionMetadata').MobileSessionMetadataButton;

const DOM_GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement',
  'HTMLIFrameElement', 'localStorage', 'getComputedStyle', 'ResizeObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  Object.defineProperty(win, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(win, '__OPENCHAMBER_API_BASE_URL__', { value: 'http://mobile-metadata.test', configurable: true });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const values = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLIFrameElement: win.HTMLIFrameElement,
    localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win),
    ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    configurable: true,
    writable: true,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
      else Reflect.deleteProperty(globalThis, 'fetch');
      void win.happyDOM.close();
    },
  };
};

describe('MobileSessionMetadata subagents', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let directory: string;
  let sequence = 0;
  const parentId = 'mobile-parent';
  const sdk = createOpencodeClient({
    baseUrl: 'http://mobile-metadata.test',
    fetch: () => new Promise<Response>(() => undefined),
  });

  const render = async (onOpenChange = () => undefined) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>
          <MobileSessionMetadataButton
            open
            onOpenChange={onOpenChange}
            currentSessionId={parentId}
            effectiveDirectory={directory}
            isNewSessionDraftOpen={false}
          />
        </I18nProvider>
      </SyncProvider>,
    ));
  };

  const session = (id: string, title: string, parentID?: string, cost = 0): Session => ({
    id,
    slug: id,
    projectID: 'project',
    directory,
    title,
    version: '1',
    parentID,
    cost,
    time: { created: 1, updated: 1 },
  });

  beforeEach(async () => {
    dom = installDom();
    ({ MobileSessionMetadataButton } = await import('./MobileSessionMetadata'));
    directory = `/repo/mobile-metadata-${sequence++}`;
    root = createRoot(dom.container);
    useUIStore.setState({ isMobile: true, workStatusExpandedSections: {} });
    useSessionUIStore.getState().setCurrentSession(parentId, directory);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useSessionUIStore.getState().setCurrentSession(null);
    dom.restore();
  });

  test('omits Subagents when the current session has no direct children', () => {
    expect(dom.container.textContent).not.toContain('Subagents');
  });

  test('shows canonical status priority, recursive child cost, and a capped mobile list', async () => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected mounted directory store');
    const children = [
      session('child-blocked', 'Blocked child', parentId, 0.3),
      session('child-question', 'Question child', parentId, 0.4),
      session('child-busy', 'Busy child', parentId, 0.2),
      session('child-done', 'A very long child name that should remain truncated in the row', parentId, 0.1),
      ...Array.from({ length: 7 }, (_, index) => session(`child-${index}`, `Extra child ${index}`, parentId)),
      session('nested', 'Nested child', 'child-busy', 0.5),
    ];
    await act(async () => store.setState({
      session: [session(parentId, 'Parent', undefined, 0.1), ...children],
      session_status: {
        'child-blocked': { type: 'busy' },
        'child-question': { type: 'busy' },
        'child-busy': { type: 'busy' },
      },
      // SAFETY: this fixture only needs non-empty request buckets; the section
      // reads their lengths and does not inspect request fields.
      permission: { 'child-blocked': [{ id: 'permission-1' }] as never[] },
      // SAFETY: this fixture only needs a non-empty question bucket; the
      // section reads its length and does not inspect request fields.
      question: { 'child-question': [{ id: 'question-1' }] as never[] },
    }));

    expect(dom.container.textContent).toContain('Subagents3/11');
    const renderedText = dom.container.textContent ?? '';
    expect(renderedText.indexOf('Usage')).toBeLessThan(renderedText.indexOf('Subagents'));
    const content = dom.container.textContent?.toLowerCase() ?? '';
    expect(content).toContain('needs permission');
    expect(content).toContain('asked a question');
    expect(content).toContain('working');
    expect(content).toContain('done');
    expect(dom.container.textContent).toContain('$0.7');
    const list = dom.container.querySelector('.max-h-56.overflow-y-auto');
    expect(list).not.toBeNull();
    expect(list?.className).toContain('overflow-y-auto');
  });

  test('navigates to a child session in place and closes through the caller', async () => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected mounted directory store');
    await act(async () => store.setState({
      session: [session(parentId, 'Parent'), session('child', 'Child', parentId)],
    }));
    let closed = false;
    await render(() => { closed = true; });
    const child = Array.from(dom.container.querySelectorAll('button')).find((button) => button.textContent?.includes('Child'));
    if (!child) throw new Error('Expected child session row');
    await act(async () => child.click());
    expect(useSessionUIStore.getState().currentSessionId).toBe('child');
    expect(closed).toBe(false);
    // MobileHeader's existing session-change effect owns this close transition.
    useSessionUIStore.getState().setCurrentSession(null);
  });
});
