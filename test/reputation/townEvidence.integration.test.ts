import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import type { Address } from 'viem';

import { withSixServiceFixture } from '../../src/demo/sixServiceFixture.js';
import { readIdentityFeedbackEpoch } from '../../src/identity/continuity.js';
import { readIdentitySnapshot } from '../../src/identity/registry.js';
import { verifyProfile } from '../../src/identity/verify.js';
import type { CityRequest } from '../../src/interaction/schema.js';
import { qualifyTownTestAdmission, readTownEvidence } from '../../src/reputation/townEvidence.js';

const execFileAsync = promisify(execFile);
const limitations = [
  'Synthetic same-host observer selected by demo policy; not independent operators or official Town accreditation.',
  'Protocol shape and one exact retry only; not Ethereum authorization, EIP-712 validity, or ownership verification.',
  'No certification of truthful venues, answer quality, or semantic task success.',
  'One observed retry is not global exactly-once execution.',
  'Replay evaluates retained observer records, not an independent rerun or proof the observer told the truth.',
] as const;

const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

test('native Town observes one owned Chicago service and qualifies only its chain-bound epoch',
  { timeout: 180_000 }, async () => {
    const indexCheckout = process.env['NANDA_INDEX_CHECKOUT'];
    const townCheckout = process.env['NANDATOWN_CHECKOUT'];
    const python = process.env['NANDATOWN_PYTHON'];
    assert.ok(indexCheckout, 'NANDA_INDEX_CHECKOUT must identify the pinned public Index checkout');
    assert.ok(townCheckout, 'NANDATOWN_CHECKOUT must identify the pinned Town checkout');
    assert.ok(python, 'NANDATOWN_PYTHON must identify the pinned Python interpreter');

    await withSixServiceFixture(indexCheckout, async (fixture) => {
      const service = fixture.services.find((item) => item.operatorIndex === 0 && item.city === 'Chicago');
      assert.ok(service, 'owned Chicago service missing');
      const root = await mkdtemp(join(await realpath(tmpdir()), 'nandacity-town-integration-'));
      await chmod(root, 0o700);
      try {
        const observerDirectory = join(root, 'observer');
        const observerName = 'city-six-service-observer';
        const identityScript = [
          'from nandatown.identity_portable import Keystore',
          `print(Keystore(${JSON.stringify(observerDirectory)}).new_identity(${JSON.stringify(observerName)})["agent_id"])`,
        ].join(';');
        const childOptions = {
          cwd: townCheckout, env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1' },
          timeout: 35_000, killSignal: 'SIGKILL' as const,
          maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const,
        };
        const observer = (await execFileAsync(python, ['-I', '-B', '-c', identityScript], childOptions))
          .stdout.trim();
        assert.match(observer, /^did:town:[0-9a-f]{24}$/);

        const createdAt = utcNow();
        const deadline = new Date(Date.parse(createdAt) + 600_000).toISOString().replace('.000Z', 'Z');
        const source = service.profile.source;
        const request: CityRequest = {
          kind: 'request', version: '0.1', service: { method: 'erc8004', agent: service.agent },
          caller: { method: 'eip155-eoa', chainId: fixture.domain.chainId,
            address: fixture.callerAddress.toLowerCase() as Address },
          interactionId: `0x${randomBytes(32).toString('hex')}`,
          profileBasis: {
            blockNumber: source.blockNumber, blockHash: source.blockHash.toLowerCase() as `0x${string}`,
            agentOwner: source.agentOwner.toLowerCase() as Address,
            agentUriDigest: source.agentUriDigest.toLowerCase() as `0x${string}`,
            registrationDigest: source.registrationDigest.toLowerCase() as `0x${string}`,
            cardDigest: source.cardDigest.toLowerCase() as `0x${string}`,
            receiptSigner: service.profile.registration['x-nandacity'].receiptSigner.toLowerCase() as Address,
          },
          createdAt, deadline,
          input: {
            version: '0.1', capability: 'evening-plan', city: 'Chicago', area: 'The Loop',
            timeWindow: { start: '2026-10-02T18:00:00-05:00', end: '2026-10-02T22:00:00-05:00',
              timeZone: 'America/Chicago' },
            budget: { currency: 'USD', minorUnits: '8500' },
            transport: ['walk', 'public-transit'], preferences: ['Fixture request'],
          },
        };
        const signed = await fixture.signAsCaller(request);
        const requestBytes = Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: 'town-integration-request', method: 'message/send', params: {
            message: { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'data',
              data: { type: 'org.nandacity.city-request', version: '0.1', envelope: signed } }] },
            configuration: { blocking: false, acceptedOutputModes: ['application/json'] },
          },
        }));
        const cardFile = join(root, 'card.json');
        const requestFile = join(root, 'request.json');
        await writeFile(cardFile, service.cardBytes, { mode: 0o600 });
        await writeFile(requestFile, requestBytes, { mode: 0o600 });
        const cardUrl = `${fixture.cardOrigin}/cards/${service.agent.agentId}.json`;
        const town = await execFileAsync(python, ['-I', '-B', '-m', 'nandatown.city_path',
          '--subject-url', service.serviceUrl, '--card-url', cardUrl, '--pinned-card', cardFile,
          '--request', requestFile, '--out-dir', join(root, 'bundles'),
          '--observer-key-dir', observerDirectory, '--observer-name', observerName], childOptions);
        const summary = JSON.parse(town.stdout) as { bundle: string; verdict: string };
        assert.equal(summary.verdict, 'passed');

        const evidence = await readTownEvidence({ bundleDirectory: summary.bundle,
          runtime: { checkout: townCheckout, python } });
        assert.equal(evidence.receipt.observer, observer);
        assert.equal(evidence.receipt.subject, service.serviceUrl);
        assert.equal(evidence.observation.cardUrl, cardUrl);
        assert.deepEqual(evidence.receipt.limitations, [...limitations]);
        assert.deepEqual(evidence.result.stages.map(({ name, status }) => [name, status]), [
          ['pinned_card', 'passed'], ['structured_send', 'passed'], ['acceptance_task', 'passed'],
          ['exact_retry', 'passed'], ['terminal_task', 'passed'],
        ]);
        assert.equal(Buffer.from(evidence.observation.cardBase64, 'base64').equals(service.cardBytes), true);
        assert.equal(Buffer.from(evidence.observation.requestRpcBase64, 'base64').equals(requestBytes), true);

        const currentSnapshot = await readIdentitySnapshot(fixture.chain, service.agent);
        const currentProfile = verifyProfile({ agent: service.agent, agentURI: currentSnapshot.agentURI,
          cardBytes: service.cardBytes }, currentSnapshot);
        const epoch = await readIdentityFeedbackEpoch(fixture.chain, {
          domain: fixture.domain, agent: service.agent,
          basis: { blockNumber: BigInt(service.profile.source.blockNumber),
            blockHash: service.profile.source.blockHash },
          observation: { blockNumber: BigInt(currentProfile.source.blockNumber),
            blockHash: currentProfile.source.blockHash },
          limits: { maxBlocks: 128, maxLogs: 64 },
        });
        assert.equal(epoch.epoch, 'same', JSON.stringify(epoch.diagnostics));
        const qualified = await qualifyTownTestAdmission({ evidence,
          service: `erc8004:${service.agent.chainId}:${service.agent.registry}:${service.agent.agentId}`,
          acceptedEvaluators: [observer], basisProfile: service.profile, currentProfile,
          currentCardBytes: service.cardBytes, epoch });
        assert.equal(qualified.admission.status, 'valid', JSON.stringify(qualified.diagnostics));
        assert.equal(qualified.admission.endpoint, service.serviceUrl);
        assert.equal(qualified.admission.issuer, observer);
        const exported = JSON.stringify({ evidence, qualified });
        assert.equal(exported.includes(root), false);
        assert.equal(exported.includes('answerBase64'), false);
        assert.equal(exported.includes('controller_private'), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
