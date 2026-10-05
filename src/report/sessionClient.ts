/** Optional enhancement. Native POST forms and 303 navigation remain the fallback. */
export const sessionClient = `(() => {
  let revision = 0;
  const fingerprint = (s) => JSON.stringify([s.generation, s.status, s.operations.map((o) => [o.id, o.state])]);
  let seen = fingerprint(window.__cityInitialStatus);
  delete window.__cityInitialStatus;
  const clearExpired = () => document.querySelectorAll('[data-expires]').forEach((el) => {
    if (Date.now() >= Date.parse(el.dataset.expires)) {
      const notice = document.createElement('p');
      notice.textContent = 'Content expired. Receipt evidence remains; semantic replay is unavailable.';
      el.replaceChildren(notice); el.removeAttribute('data-expires');
    }
  });
  const formKey = (form) => {
    const field = (name) => form.querySelector('input[type=hidden][name="' + name + '"]')?.value || '';
    return [field('action'), field('service'), field('invocationId'), field('feedbackId'), field('operatorId'), field('city'), field('index'), field('state')].join('|');
  };
  const panels = new Set(['overview', 'discover', 'ask', 'review', 'resilience', 'ownership']);
  const panelFromHash = () => {
    const hash = (location.hash || '').slice(1);
    return hash === 'choose' ? 'discover' : panels.has(hash) ? hash : null;
  };
  const setPanel = (main, panel) => {
    if (!main || !panels.has(panel)) return;
    main.dataset.panel = panel;
    for (const link of main.querySelectorAll('.task-tabs [data-panel-link]')) {
      if (link.dataset.panelLink === panel) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };
  const enhanceBudget = (root) => {
    for (const label of root.querySelectorAll('[data-budget-input]')) {
      const cents = label.querySelector('[name=budget]');
      if (!cents || label.querySelector('[data-budget-dollars]')) continue;
      const dollars = document.createElement('input');
      dollars.type = 'number'; dollars.min = '0'; dollars.max = '100000'; dollars.step = '0.01'; dollars.required = true;
      dollars.inputMode = 'decimal'; dollars.dataset.budgetDollars = 'true';
      dollars.value = (Number(cents.value) / 100).toFixed(2);
      const sync = () => {
        const value = dollars.value;
        const match = /^(0|[1-9][0-9]{0,5})(?:\\.([0-9]{1,2}))?$/.exec(value);
        const valid = !!match && Number(value) <= 100000;
        dollars.setCustomValidity(valid ? '' : 'Enter a dollar amount from $0 to $100,000, with at most two decimals.');
        cents.value = valid ? String(Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))) : '';
      };
      dollars.addEventListener('input', sync);
      cents.type = 'hidden'; cents.required = false;
      label.querySelector('[data-budget-label]').textContent = 'Budget for two (USD)';
      label.append(dollars); sync();
    }
  };
  const remember = () => {
    const main = document.querySelector('main'), focus = document.activeElement;
    return { generation: main?.dataset.generation, city: main?.dataset.city, selection: main?.dataset.selection,
      panel: main?.dataset.panel, scroll: window.scrollY, panelScroll: main?.querySelector?.('.panel-scroll')?.scrollTop || 0,
      open: [...main.querySelectorAll('details[data-disclosure-key]')].filter((el) => el.open).map((el) => el.dataset.disclosureKey),
      values: [...main.querySelectorAll('form')].map((form) => [formKey(form), [...form.querySelectorAll('input:not([type=hidden]),textarea,select')].map((el) => [el.dataset.budgetDollars ? '__dollars' : el.name, el.value])]),
      focus: focus?.closest('form') ? [formKey(focus.closest('form')), focus.dataset.budgetDollars ? '__dollars' : focus.name] : null,
      focusKey: focus?.dataset?.focusKey || (focus?.matches?.('summary') ?
        (focus.closest('details[data-disclosure-key]')?.dataset.disclosureKey ? 'summary:' + focus.closest('details[data-disclosure-key]').dataset.disclosureKey : null) : null) };
  };
  const applyPage = (html, request, desiredPanel = null) => {
    if (request !== revision) return false;
    const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
    const current = document.querySelector('main');
    if (!next || !current || !next.dataset.generation) { location.reload(); return; }
    if (Number(next.dataset.generation) < Number(current.dataset.generation)) return false;
    const prior = remember();
    const sameGeneration = next.dataset.generation === prior.generation;
    const sameInputs = sameGeneration && next.dataset.city === prior.city && next.dataset.selection === prior.selection;
    current.replaceWith(next);
    setPanel(next, desiredPanel || panelFromHash() || prior.panel || 'overview');
    if (desiredPanel) {
      const destination = new URL(location.href);
      destination.hash = desiredPanel;
      if (window.history?.replaceState) window.history.replaceState(null, '', destination);
      else location.hash = '#' + desiredPanel;
    }
    enhanceBudget(next);
    if (sameInputs) {
      const values = new Map(prior.values);
      for (const form of next.querySelectorAll('form')) for (const [name, value] of values.get(formKey(form)) || []) {
        const field = [...form.querySelectorAll('input:not([type=hidden]),textarea,select')].find((el) => (el.dataset.budgetDollars ? '__dollars' : el.name) === name);
        if (field) { field.value = value; if (name === '__dollars') field.dispatchEvent(new Event('input')); }
      }
      if (prior.focus) {
        const form = [...next.querySelectorAll('form')].find((item) => formKey(item) === prior.focus[0]);
        const field = [...(form?.querySelectorAll('input:not([type=hidden]),textarea,select') || [])].find((item) => (item.dataset.budgetDollars ? '__dollars' : item.name) === prior.focus[1]);
        field?.focus({ preventScroll: true });
      }
    }
    if (sameGeneration) {
      for (const key of prior.open) { const details = [...next.querySelectorAll('details[data-disclosure-key]')].find((item) => item.dataset.disclosureKey === key); if (details) details.open = true; }
      if (prior.focusKey && (!desiredPanel || desiredPanel === prior.panel)) {
        const target = prior.focusKey.startsWith('summary:')
          ? [...next.querySelectorAll('details[data-disclosure-key]')].find((item) => item.dataset.disclosureKey === prior.focusKey.slice(8))?.querySelector('summary')
          : [...next.querySelectorAll('[data-focus-key]')].find((item) => item.dataset.focusKey === prior.focusKey);
        if (target && (!target.closest('.task-panel') || target.closest('.task-panel').id === next.dataset.panel)) target.focus({ preventScroll: true });
        else if (prior.focusKey.startsWith('heading:') || prior.focusKey.startsWith('summary:')) next.querySelector?.('#' + next.dataset.panel + ' .section-head h2')?.focus({ preventScroll: true });
      }
      const panelScroll = next.querySelector?.('.panel-scroll'); if (panelScroll && (!desiredPanel || desiredPanel === prior.panel)) panelScroll.scrollTop = prior.panelScroll;
      window.scrollTo(0, prior.scroll);
    }
    if (desiredPanel) {
      const target = desiredPanel === 'resilience' ? next.querySelector?.('.experiment-result') : next.querySelector?.('#' + desiredPanel + ' .section-head h2');
      target?.focus({ preventScroll: true });
      // A submitted action presents its new outcome at the top of its panel;
      // background polling (no desiredPanel) still preserves the reader's place.
      const scroll = next.querySelector?.('.panel-scroll'); if (scroll) scroll.scrollTop = 0;
    }
    clearExpired();
    return true;
  };
  const page = async (request) => {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Page refresh unavailable');
    return applyPage(await response.text(), request);
  };
  const message = (text) => {
    let notice = document.querySelector('#client-error');
    if (!notice) { notice = document.createElement('p'); notice.id = 'client-error'; notice.className = 'notice'; notice.setAttribute('role', 'alert'); document.querySelector('.hero')?.after(notice); }
    notice.textContent = text;
  };
  setPanel(document.querySelector('main'), panelFromHash() || 'overview');
  window.addEventListener('hashchange', () => setPanel(document.querySelector('main'), panelFromHash() || 'overview'));
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-panel-link]');
    if (link) setPanel(document.querySelector('main'), link.dataset.panelLink);
  });
  document.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-budget-minor]');
    if (!preset) return;
    const form = preset.closest('.form-panel')?.querySelector('form[data-ask-form]');
    const dollars = form?.querySelector('[data-budget-dollars]');
    const cents = form?.querySelector('[name=budget]');
    if (dollars) { dollars.value = (Number(preset.dataset.budgetMinor) / 100).toFixed(2); dollars.dispatchEvent(new Event('input')); dollars.focus(); }
    else if (cents) { cents.value = preset.dataset.budgetMinor; cents.focus(); }
  });
  let submitting = false;
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || new URL(form.getAttribute('action') || '', location.href).href !== new URL('/action', location.href).href || !window.fetch) return;
    event.preventDefault();
    submitting = true;
    const request = ++revision;
    const submitter = event.submitter;
    if (submitter) submitter.disabled = true;
    try {
      const response = await fetch(new URL(form.getAttribute('action'), location.href).href, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)), credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { message(await response.text()); if (submitter) submitter.disabled = false; return; }
      if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Action response unavailable');
      const panel = form.querySelector?.('input[type=hidden][name="panel"]')?.value || null;
      applyPage(await response.text(), request, panel);
    } catch { location.href = '/'; }
    finally { submitting = false; }
  });
  let polling = false;
  setInterval(async () => {
    if (polling || submitting || document.hidden) return;
    polling = true;
    const startedRevision = revision;
    try {
      const response = await fetch('/status', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok || submitting || revision !== startedRevision) return;
      const status = await response.json();
      if (submitting || revision !== startedRevision) return;
      const next = fingerprint(status);
      const active = status.operations.some((operation) => operation.state === 'queued' || operation.state === 'running');
      if (next !== seen || active) {
        const request = ++revision;
        if (await page(request) && !submitting && revision === request) seen = next;
      }
    } catch { /* Native refresh remains available. */ }
    finally { polling = false; }
  }, 1500);
  enhanceBudget(document); clearExpired(); setInterval(clearExpired, 250);
  document.addEventListener('visibilitychange', clearExpired);
  window.addEventListener('pageshow', clearExpired);
})();`;
