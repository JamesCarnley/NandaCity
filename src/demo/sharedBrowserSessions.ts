import { randomBytes } from 'node:crypto';
import type { DemoSession, SessionAction, SessionFeedback, SessionInvocation, SessionOperation, SessionView } from './sessionController.js';

export type DemoSessionPool = {
  status(): SessionView['status'];
  open(id: string): DemoSession;
  drop(id: string): Promise<void>;
  close(): Promise<void>;
};

type LocalOperation = { action: string; view: SessionOperation; done: Promise<void> };
type BrowserContext = {
  id: string;
  prefix: string;
  generation: number;
  sequence: number;
  closed: boolean;
  resetting: Promise<void> | undefined;
  state: SessionView;
  operations: Map<string, LocalOperation>;
  invocations: Map<string, string>;
  feedback: Map<string, string>;
};

const operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function initial(base: DemoSession, generation: number): SessionView {
  const shared = base.view();
  return { ...shared, browserIsolation: 'shared-fixture', generation, freshConsumer: null, originComparison: null, invocations: [], discovery: null,
    selection: null, operations: [], feedback: [], indexControls: { A: 'online', B: 'online' }, indexRead: null,
    experiment: null, recoveryCheck: null, feedbackCapacity: structuredClone(shared.feedbackCapacity),
    limitations: [...shared.limitations,
      'Public browsers share one local chain, specialist pool and pair of real Index processes. Browser journey history is isolated; network writes and operator recovery remain shared observations.',
      'Index faults are serialized: the real owned fault is observed for one browser, then the Index is restored before the next browser mutation runs.'] };
}

function completed(operation: SessionOperation): void {
  if (operation.state !== 'completed') throw new Error(operation.error ?? 'shared operation unavailable');
}

/**
 * Lightweight browser journeys over one owned fixture. Mutations remain
 * serialized by the underlying controller and this outer queue. A real Index
 * fault is always restored before the queue advances to another browser.
 */
export function createSharedBrowserSessions(base: DemoSession): DemoSessionPool {
  const contexts = new Map<string, BrowserContext>();
  let queue = Promise.resolve();
  let poolClosed = false;
  let degraded = false;
  let degradedIndex: 'A' | 'B' | undefined;
  let pending = 0;
  const pendingBrowsers = new Set<BrowserContext>();
  const degradedMessage = 'Shared demo is recovering from an Index restore failure; mutations are paused until host repair or restart.';

  const syncShared = (context: BrowserContext): void => {
    const shared = base.view();
    context.state.status = context.closed ? 'closed' : context.resetting ? 'resetting' : degraded ? 'failed' : shared.status;
    context.state.lifecycleOperationId = shared.lifecycleOperationId;
    context.state.operators = structuredClone(shared.operators);
    context.state.crossOperatorWrite = shared.crossOperatorWrite;
    context.state.feedbackCapacity = structuredClone(shared.feedbackCapacity);
    if (degradedIndex) context.state.indexControls[degradedIndex] = 'unknown';
  };

  const nextId = (context: BrowserContext): string => `u${context.prefix}${(context.sequence++).toString(36)}`;
  const runBase = async (context: BrowserContext, action: SessionAction, id = nextId(context)): Promise<SessionView> => {
    await base.ready();
    const operation = base.start(action, id);
    completed(await base.wait(operation.id));
    return base.view();
  };

  const syncFeedback = (context: BrowserContext, shared: SessionView): void => {
    const invocationByGlobal = new Map([...context.invocations].map(([local, global]) => [global, local]));
    const values: SessionFeedback[] = [];
    for (const [local, global] of context.feedback) {
      const found = shared.feedback.find((item) => item.id === global);
      if (found) values.push({ ...structuredClone(found), id: local,
        invocationId: invocationByGlobal.get(found.invocationId) ?? found.invocationId });
    }
    context.state.feedback = values;
  };

  const copyDiscovery = (context: BrowserContext, shared: SessionView, preserveSelection = false): void => {
    const selected = preserveSelection ? context.state.selection : null;
    context.state.discovery = structuredClone(shared.discovery);
    context.state.indexRead = structuredClone(shared.indexRead);
    context.state.selection = selected && context.state.discovery?.selected.some((item) => item.service === selected) ? selected : null;
    syncFeedback(context, shared);
    syncShared(context);
  };

  const copyInvocation = (context: BrowserContext, local: string, global: string, shared: SessionView): void => {
    const found = shared.invocations.find((item) => item.id === global);
    if (!found) throw new Error('shared invocation unavailable');
    context.invocations.set(local, global);
    const value: SessionInvocation = { ...structuredClone(found), id: local };
    const index = context.state.invocations.findIndex((item) => item.id === local);
    if (index === -1) context.state.invocations.push(value); else context.state.invocations[index] = value;
  };

  const copyFeedback = (context: BrowserContext, local: string, global: string, shared: SessionView): void => {
    const found = shared.feedback.find((item) => item.id === global);
    if (!found) throw new Error('shared feedback unavailable');
    context.feedback.set(local, global);
    syncFeedback(context, shared);
  };

  const runInvocation = async (context: BrowserContext, action: SessionAction, local: string, global: string,
    operationId?: string): Promise<SessionView> => {
    let shared: SessionView;
    try { shared = await runBase(context, action, operationId); }
    catch (error) {
      shared = base.view();
      if (shared.invocations.some((item) => item.id === global)) copyInvocation(context, local, global, shared);
      syncShared(context);
      throw error;
    }
    copyInvocation(context, local, global, shared);
    return shared;
  };

  const runFeedback = async (context: BrowserContext, action: SessionAction, local: string, global: string,
    operationId?: string): Promise<SessionView> => {
    let shared: SessionView;
    try { shared = await runBase(context, action, operationId); }
    catch (error) {
      shared = base.view();
      if (shared.feedback.some((item) => item.id === global)) copyFeedback(context, local, global, shared);
      syncShared(context);
      throw error;
    }
    copyFeedback(context, local, global, shared);
    return shared;
  };

  const ensureDiscovery = async (context: BrowserContext): Promise<SessionView> => {
    const city = context.state.discovery?.city;
    if (!city) throw new Error('choose a city first');
    const selected = context.state.selection;
    const shared = await runBase(context, { kind: 'refresh', city });
    copyDiscovery(context, shared, true);
    if (selected && !shared.discovery?.selected.some((item) => item.service === selected)) {
      context.state.selection = null; throw new Error('selected service is no longer verified');
    }
    return shared;
  };

  const apply = async (context: BrowserContext, action: SessionAction, localId: string, recoveryCity?: 'Chicago' | 'Boston'): Promise<void> => {
    if (context.closed || poolClosed) throw new Error('browser session is closed');
    if (action.kind === 'refresh') { copyDiscovery(context, await runBase(context, action)); return; }
    if (action.kind === 'invoke') {
      const selected = context.state.selection;
      if (!selected) throw new Error('select a specialist first');
      await ensureDiscovery(context); base.select(selected);
      const global = nextId(context), shared = await runInvocation(context, action, localId, global, global);
      copyDiscovery(context, shared, true); return;
    }
    if (action.kind === 'retry') {
      const invocationId = context.invocations.get(action.invocationId);
      if (!invocationId) throw new Error('unknown browser invocation');
      await runInvocation(context, { ...action, invocationId }, action.invocationId, invocationId);
      syncShared(context); return;
    }
    if (action.kind === 'feedback') {
      const invocationId = context.invocations.get(action.invocationId);
      if (!invocationId) throw new Error('unknown browser invocation');
      const global = nextId(context);
      await runFeedback(context, { ...action, invocationId }, localId, global, global);
      if (context.state.discovery) await ensureDiscovery(context); else syncShared(context);
      return;
    }
    if (action.kind === 'retry-feedback') {
      const feedbackId = context.feedback.get(action.feedbackId);
      if (!feedbackId) throw new Error('unknown browser feedback');
      await runFeedback(context, { ...action, feedbackId }, action.feedbackId, feedbackId);
      if (context.state.discovery) await ensureDiscovery(context); else syncShared(context);
      return;
    }
    if (action.kind === 'index') {
      let observed: SessionView | undefined; let failure: unknown;
      const global = nextId(context);
      try { observed = await runBase(context, action, global); }
      catch (error) {
        failure = error;
        const failed = base.view();
        if (failed.operations.some((item) => item.id === global && item.kind === 'index')) observed = failed;
      }
      let restored: SessionView | undefined;
      if (action.state === 'stop' || action.state === 'tamper') {
        try {
          restored = await runBase(context, { kind: 'index', index: action.index, state: 'restart' });
          if (restored.indexControls[action.index] !== 'online') throw new Error('Index restart was not observed online');
        }
        catch (restoreError) {
          if (observed?.experiment) {
            context.state.experiment = structuredClone(observed.experiment);
            context.state.experiment.phase = 'failed';
            context.state.experiment.note = `${context.state.experiment.note} Index experiment restore failed; host repair is required.`;
          }
          degraded = true;
          degradedIndex = action.index;
          for (const browser of contexts.values()) {
            browser.state.discovery = null; browser.state.indexRead = null; browser.state.selection = null;
            browser.state.indexControls[action.index] = 'unknown';
          }
          throw new AggregateError(failure ? [failure, restoreError] : [restoreError], 'Index experiment restore failed');
        }
      }
      if (observed) {
        context.state.discovery = structuredClone(observed.discovery);
        context.state.indexRead = structuredClone(observed.indexRead);
        context.state.selection = null;
        context.state.indexControls = structuredClone(observed.indexControls);
        context.state.experiment = structuredClone(observed.experiment);
        if (restored) {
          context.state.indexControls[action.index] = restored.indexControls[action.index];
          if (context.state.experiment) context.state.experiment.note =
            `${context.state.experiment.note} The shared Index was restored before another browser mutation was admitted.`;
        }
        syncFeedback(context, observed); syncShared(context);
      }
      if (failure) throw failure;
      if (!observed) throw new Error('Index experiment unavailable');
      return;
    }
    if (action.kind === 'fresh-consumer') {
      await ensureDiscovery(context); const shared = await runBase(context, action);
      context.state.freshConsumer = structuredClone(shared.freshConsumer); syncShared(context); return;
    }
    if (action.kind === 'stop-providers') {
      throw new Error('shared provider shutdown is unavailable in the multi-browser demo; use the signed provider-failure action');
    }
    if (action.kind === 'recover' && recoveryCity) await runBase(context, { kind: 'refresh', city: recoveryCity });
    if (action.kind === 'recover') {
      const global = nextId(context);
      let shared: SessionView | undefined; let failure: unknown;
      try { shared = await runBase(context, action, global); }
      catch (error) {
        failure = error;
        const failed = base.view();
        if (failed.operations.some((item) => item.id === global && item.kind === 'recover')) shared = failed;
      }
      if (shared) {
        context.state.discovery = structuredClone(shared.discovery); context.state.indexRead = structuredClone(shared.indexRead);
        context.state.selection = null; context.state.recoveryCheck = structuredClone(shared.recoveryCheck ?? null);
      }
      syncShared(context);
      if (failure) throw failure;
      if (!shared) throw new Error('shared recovery unavailable');
      return;
    }
    const shared = await runBase(context, action);
    if (action.kind === 'origin-comparison') context.state.originComparison = structuredClone(shared.originComparison);
    syncShared(context);
  };

  const open = (id: string): DemoSession => {
    if (poolClosed || !/^[0-9a-f]{64}$/.test(id)) throw new Error('invalid browser session identity');
    const existing = contexts.get(id);
    if (existing) return sessionFor(existing);
    const context: BrowserContext = { id, prefix: randomBytes(8).toString('hex'), generation: 0, sequence: 0,
      closed: false, resetting: undefined, state: undefined as unknown as SessionView, operations: new Map(), invocations: new Map(), feedback: new Map() };
    context.state = initial(base, context.generation); contexts.set(id, context);
    return sessionFor(context);
  };

  const sessionFor = (context: BrowserContext): DemoSession => ({
    view: () => { syncShared(context); return structuredClone(context.state); },
    ready: () => base.ready(),
    select: (service) => {
      if (context.closed || context.resetting || context.state.operations.some((item) => item.state === 'queued' || item.state === 'running')) throw new Error('selection unavailable while a mutation is running');
      if (!context.state.discovery?.selected.some((candidate) => candidate.service === service)) throw new Error('identity not returned by browser discovery');
      context.state.selection = service;
    },
    start: (action, id = randomBytes(16).toString('hex')) => {
      if (context.closed || poolClosed) throw new Error('browser session is closed');
      if (context.resetting) throw new Error('browser session is resetting');
      if (!operationId.test(id)) throw new Error('invalid operation identity');
      const encoded = JSON.stringify(action), old = context.operations.get(id);
      if (old) { if (old.action !== encoded) throw new Error('operation identity conflict'); return structuredClone(old.view); }
      if (degraded) throw new Error(degradedMessage);
      if (pendingBrowsers.has(context)) throw new Error('This browser already has a pending action; wait for it to finish, then retry.');
      if (pending >= 12) throw new Error('Shared demo is busy; wait for a pending action to finish, then retry.');
      const recoveryCity = action.kind === 'recover' ? context.state.discovery?.city : undefined;
      if (action.kind === 'recover' && !recoveryCity) throw new Error('choose a city before shared operator recovery');
      if (action.kind === 'index') {
        context.state.discovery = null; context.state.indexRead = null; context.state.selection = null;
        context.state.experiment = action.city ? { target: action.index, action: action.state, city: action.city,
          phase: 'applying', before: null, after: null, note: 'Waiting for the isolated browser experiment.' } : null;
      }
      if (action.kind === 'recover') {
        context.state.discovery = null; context.state.indexRead = null; context.state.selection = null;
        context.state.recoveryCheck = { operatorId: action.operatorId, city: null, status: 'recovering', endpoint: null,
          reason: 'Shared operator recovery is queued.' };
      }
      const operation: SessionOperation = { id, generation: context.generation, kind: action.kind, state: 'queued' };
      context.state.operations.push(operation);
      pending++; pendingBrowsers.add(context);
      const done = queue.then(async () => {
        if (context.closed) throw new Error('browser session closed');
        if (degraded) throw new Error(degradedMessage);
        operation.state = 'running'; await apply(context, action, id, recoveryCity); operation.state = 'completed';
      }).catch((error: unknown) => {
        operation.state = context.closed ? 'cancelled' : 'failed';
        operation.error = context.closed ? 'browser session closed' : error instanceof Error ? error.message : 'action unavailable';
        if (action.kind === 'index' && context.state.experiment?.phase === 'applying') {
          context.state.experiment.phase = 'failed'; context.state.experiment.note = operation.error;
        }
        if (action.kind === 'recover' && context.state.recoveryCheck?.status === 'recovering') {
          context.state.recoveryCheck.status = 'unavailable';
          context.state.recoveryCheck.city = recoveryCity ?? null;
          context.state.recoveryCheck.reason = operation.error;
        }
      }).finally(() => { pending--; pendingBrowsers.delete(context); });
      queue = done.then(() => undefined);
      context.operations.set(id, { action: encoded, view: operation, done });
      return structuredClone(operation);
    },
    wait: async (id) => {
      const operation = context.operations.get(id); if (!operation) throw new Error('unknown operation');
      await operation.done; return structuredClone(operation.view);
    },
    frozenInput: () => { throw new Error('browser-private frozen input is not exported'); },
    readContent: (id, generation) => {
      if (generation !== context.generation) return undefined;
      const global = context.invocations.get(id); return global ? base.readContent(global, base.view().generation) : undefined;
    },
    reset: () => {
      if (context.closed) throw new Error('browser session is closed');
      if (context.resetting) return context.resetting;
      context.state.status = 'resetting';
      const beforeReset = queue;
      context.resetting = (async () => {
        await beforeReset;
        if (context.closed) throw new Error('browser session is closed');
        context.generation++; context.operations.clear(); context.invocations.clear(); context.feedback.clear();
        context.state = initial(base, context.generation);
      })().finally(() => { context.resetting = undefined; });
      return context.resetting;
    },
    close: async () => { context.closed = true; context.state.status = 'closed'; },
  });

  return { status: () => degraded ? 'failed' : base.view().status, open,
    drop: async (id) => { const context = contexts.get(id); if (!context) return; await sessionFor(context).close(); contexts.delete(id); },
    close: async () => { poolClosed = true; for (const context of contexts.values()) { context.closed = true; context.state.status = 'closed'; }
      await queue; contexts.clear(); } };
}
