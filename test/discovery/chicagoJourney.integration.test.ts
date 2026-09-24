import assert from 'node:assert/strict';
import test from 'node:test';

import { runChicagoJourney } from '../../src/demo/chicagoJourney.js';

test('owned Chicago journey selects a real Index candidate and independently verifies success and accepted failure',
  { timeout: 180_000 }, async () => {
    const checkout = process.env['NANDA_INDEX_CHECKOUT'];
    assert.ok(checkout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    const result = await runChicagoJourney(checkout);
    assert.equal(result.mode, 'local-fixture');
    assert.equal(result.city, 'Chicago');
    assert.equal(result.indexSourceCommit, '94dca70d86fcd915d8f6e46442e1e3a71ebb9ce7');
    assert.equal(result.indexOrigins.length, 2);
    assert.notEqual(result.identities.owner, result.identities.runtime);
    assert.notEqual(result.identities.owner, result.identities.caller);
    assert.notEqual(result.identities.runtime, result.identities.caller);
    assert.equal(result.success.report.discovery.status, 'verified');
    assert.equal(result.success.report.request?.cryptography, 'valid');
    assert.equal(result.success.report.acceptance?.cryptography, 'valid');
    assert.equal(result.success.report.completion?.cryptography, 'valid');
    assert.equal(result.success.report.completion?.answerBinding, 'matched');
    assert.equal(result.success.report.execution, 'completed');
    assert.equal(result.success.report.contentValidation, 'not-tested');
    assert.equal(result.success.report.evidenceUsable, true);
    assert.equal(result.failure.report.discovery.status, 'verified');
    assert.equal(result.failure.report.acceptance?.cryptography, 'valid');
    assert.equal(result.failure.report.completion?.terminalOutcome, 'failed');
    assert.equal(result.failure.report.execution, 'failed');
    assert.equal(result.failure.report.evidenceUsable, true);
    assert.equal(result.tamperRejected, true);
    assert.equal(result.diagnosticCardMismatch.firstBrokenBoundary, 'discovery');
    assert.equal(result.diagnosticCardMismatch.evidenceUsable, false);
    assert.equal(result.diagnosticCardMismatch.request, undefined);
    assert.equal(result.diagnosticMalformedCompletion.firstBrokenBoundary, 'interaction');
    assert.equal(result.diagnosticMalformedCompletion.evidenceUsable, false);
    // A completed-looking Task with no provider-signed completion cannot have no broken boundary.
    const missing = (result as unknown as { diagnosticMissingCompletion?: {
      firstBrokenBoundary: string | null; evidenceUsable: boolean } }).diagnosticMissingCompletion;
    assert.equal(missing?.firstBrokenBoundary, 'interaction');
    assert.equal(missing?.evidenceUsable, false);
    assert.equal(result.independentProcessVerified, true);
    assert.notEqual(result.success.evidence.task.id, result.failure.evidence.task.id);
    assert.equal(result.cleanup.ownedResourcesStopped, true);
  });
