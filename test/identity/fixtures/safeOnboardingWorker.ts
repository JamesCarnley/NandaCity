import { withJournalLock, type JournalAccess } from '../../../src/safe/onboardingJournal.js';
import type { OnboardingConfig } from '../../../src/safe/onboarding.js';
import type { ApprovedSafeCall } from '../../../src/safe/adapter.js';

process.once('message', async (message: JournalAccess & { mode: 'hold' | 'race' | 'onboarding';
  operation?: 'reopen' | 'next' | 'approve' | 'resume'; config?: OnboardingConfig; approval?: ApprovedSafeCall;
  fault?: 'drop-request'; barrier?: 'hold' | 'attempt' }) => {
  process.channel?.ref();
  const access = { ...message, guard: () => undefined };
  try {
    if (message.mode === 'onboarding') {
      const onboarding = await import('../../../src/safe/onboarding.js');
      if (message.barrier === 'hold') {
        const send = process.send!.bind(process); let held = false; let announced = false;
        const release = new Promise<void>((resolve) => { process.on('message', (value) => {
          if (value === 'barrier-release') resolve();
        }); });
        process.send = ((value: unknown, ...args: unknown[]) => {
          if (value && typeof value === 'object' && 'type' in value && value.type === 'onboarding-lock-held') held = true;
          return (send as (...values: unknown[]) => boolean)(value, ...args);
        }) as NonNullable<typeof process.send>;
        const fetcher = globalThis.fetch;
        globalThis.fetch = async (...args) => {
          // Pause an actual operation's first RPC only after production confirms its real lock.
          if (held && !announced) { announced = true; send('barrier-acquired'); await release; }
          return fetcher(...args);
        };
      }
      if (message.fault === 'drop-request') {
        const fetcher = globalThis.fetch;
        globalThis.fetch = async (...args) => {
          if (typeof args[1]?.body === 'string' && JSON.parse(args[1].body).method === 'eth_sendRawTransaction') {
            throw new Error('synthetic lost request');
          }
          return fetcher(...args);
        };
      }
      const config = message.config!;
      if (message.barrier === 'attempt') process.send?.('barrier-attempt');
      if (message.operation === 'next') {
        const next = await onboarding.prepareNextAction(config, access);
        process.send?.({ type: 'result', report: next.report,
          ...(next.action && next.action.kind !== 'deploy' ? { safeTxHash: next.action.prepared.safeTxHash } : {}) });
      } else {
        const report = message.operation === 'approve' ? await onboarding.recordApproval(config, access, message.approval!) :
          message.operation === 'resume' ? await onboarding.resumeOnboarding(config, access) : await onboarding.prepareOnboarding(config, access);
        process.send?.({ type: 'result', report });
      }
      process.disconnect(); return;
    }
    await withJournalLock(access, (value) => value as { reservation: string }, async (current, persist) => {
      if (!current) await persist({ reservation: 'chicago:0' });
      process.send?.('held');
      if (message.mode === 'hold') await new Promise(() => undefined);
    });
  } catch { process.send?.('locked'); }
  if (message.mode !== 'hold') process.disconnect();
});
