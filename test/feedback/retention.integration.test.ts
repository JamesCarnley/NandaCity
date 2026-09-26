import assert from 'node:assert/strict';
import test from 'node:test';
import { withSixServiceFixture } from '../../src/demo/sixServiceFixture.js';

test('feedback fixture has past genesis, wall-aligned registry chronology, symmetric fresh Index handles and idempotent source stops',
  { timeout: 180000 }, async () => {
    assert.ok(process.env['NANDA_INDEX_CHECKOUT']);
    await withSixServiceFixture(process.env['NANDA_INDEX_CHECKOUT']!, async (fixture) => {
      assert.ok('indexes' in fixture, 'fixture must expose owned symmetric lifecycle');
      const enhanced = fixture as any;
      const genesis = await fixture.chain.getBlock({ blockNumber: 0n });
      const first = await fixture.chain.getBlock({ blockNumber: 1n });
      const latest = await fixture.chain.getBlock();
      assert.ok(genesis.timestamp < BigInt(Math.floor(Date.now() / 1000) - 86400));
      assert.ok(first.timestamp <= BigInt(Math.floor(Date.now() / 1000)));
      assert.ok(latest.timestamp <= BigInt(Math.floor(Date.now() / 1000)));
      assert.ok(enhanced.feedback, 'feedback deployment must be opt-in and configured before Index startup');
      const old = enhanced.indexes.indexes.B;
      const fresh = await enhanced.indexes.restart('B');
      assert.notEqual(fresh.origin, old.origin);
      assert.equal(fresh.database, old.database);
      await old.stop();
      assert.equal((await fetch(`${fresh.origin}/health`)).status, 200);
      await assert.rejects(fetch(`${old.origin}/health`, { signal: AbortSignal.timeout(500) }));
      await enhanced.stopProvider(fixture.services[0]!.agent.agentId);
      await enhanced.stopProvider(fixture.services[0]!.agent.agentId);
      await enhanced.stopCards(); await enhanced.stopCards();
      await assert.rejects(fetch(fixture.services[0]!.serviceUrl, { signal: AbortSignal.timeout(500) }));
      await assert.rejects(fetch(fixture.cardOrigin, { signal: AbortSignal.timeout(500) }));
    }, { feedback: { documentUrls: ['http://127.0.0.1:34567/review'] } });
  });

test('actual signed negative survives two independent DBs, all source outages, reorg and revocation; empty DB cannot recover bytes',
  { timeout: 240000 }, async () => {
    const module = await import('../../src/demo/feedbackRetention.js').catch(() => undefined);
    assert.ok(module, 'real feedback retention drill must be implemented');
    const result = await module.runFeedbackRetentionDemo(process.env['NANDA_INDEX_CHECKOUT']!);
    assert.equal(result.mode, 'local-fixture');
    assert.equal(result.failure.execution, 'failed');
    assert.equal(result.failure.completionClaimedOutcome, 'failed');
    assert.equal(result.failure.reviewValue, 1);
    assert.deepEqual(result.outages, { provider: true, cards: true, documents: true, indexA: true });
    for (const stage of [result.retained.A, result.retained.B, result.restarted.A, result.restarted.B]) {
      assert.deepEqual(stage, [result.publications.primary.documentHash, result.publications.suffix.documentHash]);
    }
    const primary = result.bOnly.primary;
    assert.equal(primary.historical?.originalAuthority.status, 'matched');
    assert.equal(primary.historical?.publication.publication, 'matched');
    assert.equal(primary.historical?.publication.revocation, 'active');
    assert.equal(primary.historical?.publication.claimedFeedbackTime, 'not-after-publication');
    assert.equal(primary.historical?.historical.status, 'evaluated');
    if (primary.historical?.historical.status === 'evaluated') {
      assert.equal(primary.historical.historical.findings.resultEvidence, 'matched');
      assert.equal(primary.historical.historical.findings.completionClaimedOutcome, 'failed');
      assert.equal(primary.historical.historical.findings.historicalExistence, 'unknown');
      assert.equal(primary.historical.historical.findings.claimedTime, 'consistent');
    }
    assert.equal(result.bOnly.missingBundle.historical?.bundle.availability, 'absent');
    assert.equal(result.bOnly.missingBundle.historical?.publication.publication, 'matched');
    assert.equal(result.reorg.primary.index.event.canonicality, 'canonical');
    assert.equal(result.reorg.primary.historical?.publication.publication, 'matched');
    assert.equal(result.reorg.suffix.index.documentAvailability, 'retained');
    assert.equal(result.reorg.suffix.historical?.publication.publication, 'orphaned');
    assert.ok(['withdrawn', 'orphaned'].includes(result.reorg.suffix.index.event.canonicality));
    assert.equal(result.revoked.historical?.publication.revocation, 'revoked');
    assert.equal(result.revoked.index.documentAvailability, 'retained');
    assert.equal(result.emptyRebuild.index.documentAvailability, 'unavailable');
    assert.equal(result.emptyRebuild.historical?.publication.document.decoding, 'unavailable');
    assert.equal(result.emptyRebuild.historical?.publication.revocation, 'revoked');
    assert.equal(result.emptyRebuild.index.completeness, 'index-reported-only');
    assert.equal(result.cleanup.ownedResourcesStopped, true);
    const serialized = JSON.stringify(result);
    for (const privateText of ['Trigger provider fault', 'privateKey', 'bundle.json', 'storeDirectory', 'DATABASE_URL']) assert.equal(serialized.includes(privateText), false);
  });
