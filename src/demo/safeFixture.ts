import { createPublicClient, createTestClient, createWalletClient, http, parseEther,
  type Address, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assertLocalWriteRpcUrl, withOwnedAnvil } from './anvil.js';
import { loadSafeArtifacts, supportNames, type SafeNetworkConfig } from '../safe/contracts.js';
import { executeSafeDeployment, prepareDeploymentExecution, prepareSafeDeployment, type PayerWallet } from '../safe/adapter.js';

/** Five support deployments only; the factory creates the sixth artifact's proxy. */
export async function deploySafeSupportContracts(client: PublicClient, payer: PayerWallet): Promise<SafeNetworkConfig> {
  const readUrl = client.transport.type === 'http' ? client.transport.url : undefined;
  const writeUrl = payer.transport.type === 'http' ? payer.transport.url : undefined;
  if (typeof readUrl !== 'string' || typeof writeUrl !== 'string') throw new Error('Safe fixture requires loopback HTTP RPC');
  assertLocalWriteRpcUrl(readUrl); assertLocalWriteRpcUrl(writeUrl);
  if (readUrl !== writeUrl || await client.getChainId() !== 31337) throw new Error('Safe fixture requires the same owned local chain');
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (!genesis.hash) throw new Error('Safe fixture requires numbered genesis zero');
  const artifacts = loadSafeArtifacts(); const contracts = {} as SafeNetworkConfig['contracts'];
  for (const name of supportNames) {
    assertLocalWriteRpcUrl(writeUrl);
    const artifact = artifacts[name];
    const hash = await payer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, chain: null });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 10_000 });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Safe support deployment failed');
    contracts[name] = { address: receipt.contractAddress, abi: artifact.abi };
  }
  return { chainId: 31337, genesisHash: genesis.hash, rpcUrl: readUrl, safeVersion: '1.4.1', contracts };
}

/** Owned ephemeral Anvil and in-memory generated keys only. No account export or public-chain path. */
export async function withOwnedSafeFixture<T>(run: (fixture: {
  network: SafeNetworkConfig; account: Awaited<ReturnType<typeof executeSafeDeployment>>;
  client: PublicClient; payer: PayerWallet;
}) => Promise<T>): Promise<T> {
  const result = await withOwnedAnvil(async (rpcUrl) => {
    assertLocalWriteRpcUrl(rpcUrl);
    const transport = http(rpcUrl, { retryCount: 0 });
    const client = createPublicClient({ transport, pollingInterval: 25 });
    const payerAccount = privateKeyToAccount(generatePrivateKey());
    const payer = createWalletClient({ account: payerAccount, transport });
    await createTestClient({ transport, mode: 'anvil' }).setBalance({ address: payerAccount.address, value: parseEther('100') });
    const owners = [privateKeyToAccount(generatePrivateKey()).address, privateKeyToAccount(generatePrivateKey()).address] as [Address, Address];
    const network = await deploySafeSupportContracts(client, payer);
    const prepared = await prepareSafeDeployment(network, { owners, threshold: 1, saltNonce: '0',
      fallbackHandler: network.contracts.fallbackHandler.address });
    const signed = await prepareDeploymentExecution(prepared, payer);
    const account = await executeSafeDeployment(signed);
    return run({ network, account, client, payer });
  }, { genesisMarker: { blockNumber: 0n, timestamp: 1_800_000_000n } });
  return result.value;
}
