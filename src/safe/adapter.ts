import SafeExport, { calculateSafeTransactionHash, EthSafeSignature } from '@safe-global/protocol-kit';
import { isDeepStrictEqual } from 'node:util';
import type { SafeTransactionData } from '@safe-global/types-kit';
import { createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, keccak256,
  padHex, parseAbi, parseTransaction, recoverMessageAddress, recoverTransactionAddress,
  toEventSelector, toHex, zeroAddress, type Account, type Address, type Hash, type Hex,
  type PublicClient, type TransactionReceipt, type Transport, type WalletClient } from 'viem';
import { assertLocalWriteRpcUrl } from '../demo/anvil.js';
import { compileReferenceContracts } from '../demo/contracts.js';
import { IMPLEMENTATION_SLOT, type IdentityContinuityDomain } from '../identity/continuity.js';
import { boundedRpcFetch } from '../identity/rpcTransport.js';
import { exactKeys, expectedSupportRuntime, loadSafeArtifacts, protocolContractNetworks, requireAddress,
  supportNames, validateAccount, validateNetwork, type SafeAccountDeploymentConfig,
  type SafeAccountInput, type SafeNetworkConfig } from './contracts.js';

// 8.0.7 exposes an ESM default class but its .d.ts package is classified as
// CommonJS by NodeNext. This only corrects that declaration/runtime mismatch.
const Safe = SafeExport as unknown as typeof SafeExport.default;

export type { SafeAccountDeploymentConfig, SafeNetworkConfig } from './contracts.js';
export type PayerWallet = WalletClient<Transport, undefined, Account>;
export type SafeSingleCall = { to: Address; value: '0'; data: Hex; operation: 0 };
export type PreparedSafeCall = {
  version: '0.1'; network: SafeNetworkConfig; safe: Address; nonce: number;
  call: SafeSingleCall; transactionData: SafeTransactionData; safeTxHash: Hash;
};
/** Private capability: never log, publish or place in public account exports. */
export type ApprovedSafeCall = PreparedSafeCall & {
  owner: Address; ownerSignature: Hex; executionCalldata: Hex;
};
/** Private capability: record durably before submission, never re-sign on uncertainty. */
export type PreparedSafeExecution = ApprovedSafeCall & {
  payer: Address; payerNonce: number; rawTransaction: Hex; transactionHash: Hash;
};
export type SafeExecution = PreparedSafeExecution & { blockNumber: string; blockHash: Hash };
type UnsignedTransaction = { to: Address; value: '0'; data: Hex };
export type PreparedSafeDeployment = {
  version: '0.1'; network: SafeNetworkConfig; account: SafeAccountDeploymentConfig;
  predictedAddress: Address; transaction: UnsignedTransaction;
};
export type PreparedDeploymentExecution = PreparedSafeDeployment & {
  payer: Address; payerNonce: number; rawTransaction: Hex; transactionHash: Hash;
};
export type SafeAccountReadback = {
  network: SafeNetworkConfig; safe: Address; owners: [Address, Address]; threshold: 1;
  fallbackHandler: Address; modules: Address[]; guard: Address; blockNumber: string; blockHash: Hash;
};
const safeAbi = parseAbi([
  'function VERSION() view returns(string)', 'function getOwners() view returns(address[])',
  'function getThreshold() view returns(uint256)', 'function nonce() view returns(uint256)',
  'function getModulesPaginated(address,uint256) view returns(address[],address)',
  'event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)', 'event ExecutionFailure(bytes32 indexed txHash,uint256 payment)',
]);
const registryAbi = parseAbi([
  'event Registered(uint256 indexed agentId,string agentURI,address indexed owner)',
  'function ownerOf(uint256) view returns(address)', 'function tokenURI(uint256) view returns(string)',
  'function getApproved(uint256) view returns(address)', 'function isApprovedForAll(address,address) view returns(bool)',
]);
const sentinel = '0x0000000000000000000000000000000000000001';
const fallbackSlot = keccak256(new TextEncoder().encode('fallback_manager.handler.address'));
const guardSlot = keccak256(new TextEncoder().encode('guard_manager.guard.address'));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hasCode = (code: Hex | undefined) => !!code && code !== '0x';
const clone = <T>(value: T): T => structuredClone(value);
const hex = (value: string): value is Hex => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const hash = (value: string): value is Hash => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

/** Protocol Kit uses number nonces; reject before narrowing chain uint256 values. */
export function checkedNonce(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsafe nonce');
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('unsafe nonce');
  return value;
}

function localClient(network: SafeNetworkConfig): PublicClient {
  validateNetwork(network);
  return createPublicClient({ transport: http(network.rpcUrl, { retryCount: 0, timeout: 5_000,
    fetchFn: boundedRpcFetch }), pollingInterval: 25 });
}
function clientUrl(client: PublicClient | PayerWallet): string {
  const url = client.transport.type === 'http' ? client.transport.url : undefined;
  if (typeof url !== 'string') throw new Error('Safe requires explicit loopback HTTP RPC');
  assertLocalWriteRpcUrl(url);
  return url;
}
async function checkNetwork(client: PublicClient, network: SafeNetworkConfig, blockNumber?: bigint): Promise<void> {
  validateNetwork(network);
  if (clientUrl(client) !== network.rpcUrl) throw new Error('Safe RPC binding mismatch');
  if (await client.getChainId() !== network.chainId ||
      !same((await client.getBlock({ blockNumber: 0n })).hash!, network.genesisHash)) throw new Error('Safe chain/genesis mismatch');
  for (const name of supportNames) {
    const address = network.contracts[name].address;
    const code = await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) });
    if (!code || !same(code, expectedSupportRuntime(name, address))) throw new Error('Safe support runtime mismatch');
  }
}
async function canonicalBlock(client: PublicClient, blockNumber: bigint, blockHash: Hash): Promise<void> {
  const block = await client.getBlock({ blockNumber });
  if (block.number !== blockNumber || !block.hash || !same(block.hash, blockHash)) throw new Error('Safe numbered block is not canonical');
}

/** Independently reusable configuration read-back; RPC-derived, not finality or a state proof. */
export async function readSafeAccount(networkInput: SafeNetworkConfig, safe: Address,
  expected?: SafeAccountDeploymentConfig, atBlock?: bigint): Promise<SafeAccountReadback> {
  const network = clone(networkInput); const client = localClient(network); requireAddress(safe);
  const blockNumber = atBlock ?? await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error('Safe block unavailable');
  await checkNetwork(client, network, blockNumber);
  const code = await client.getCode({ address: safe, blockNumber });
  if (!code || !same(code, loadSafeArtifacts().safeProxy.deployedBytecode)) throw new Error('Safe proxy runtime mismatch');
  const [singleton, handler, guard, version, owners, threshold, modules] = await Promise.all([
    client.getStorageAt({ address: safe, slot: toHex(0n, { size: 32 }), blockNumber }),
    client.getStorageAt({ address: safe, slot: fallbackSlot, blockNumber }),
    client.getStorageAt({ address: safe, slot: guardSlot, blockNumber }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'VERSION', blockNumber }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners', blockNumber }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold', blockNumber }),
    client.readContract({ address: safe, abi: safeAbi, functionName: 'getModulesPaginated', args: [sentinel, 1n], blockNumber }),
  ]);
  if (!singleton || !same(singleton, padHex(network.contracts.safeSingleton.address, { size: 32 })) ||
      !handler || !same(handler, padHex(network.contracts.fallbackHandler.address, { size: 32 })) ||
      !guard || BigInt(guard) !== 0n || version !== '1.4.1' || threshold !== 1n || owners.length !== 2 ||
      same(owners[0]!, owners[1]!) || modules[0].length !== 0 || !same(modules[1], sentinel)) {
    throw new Error('Safe account configuration mismatch');
  }
  for (const owner of owners) {
    requireAddress(owner);
    if (hasCode(await client.getCode({ address: owner, blockNumber }))) throw new Error('Safe owners must be EOAs');
  }
  if (expected) {
    validateAccount(network, expected);
    await predictedKit(network, expected);
    if (!same(expected.predictedAddress, safe) || !expected.owners.every((owner) => owners.some((actual) => same(owner, actual)))) {
      throw new Error('Safe deployed owners/address mismatch');
    }
  }
  await canonicalBlock(client, blockNumber, block.hash);
  return { network, safe: getAddress(safe), owners: [owners[0]!, owners[1]!], threshold: 1,
    fallbackHandler: network.contracts.fallbackHandler.address, modules: [], guard: zeroAddress,
    blockNumber: String(blockNumber), blockHash: block.hash };
}

async function predictedKit(network: SafeNetworkConfig, account: SafeAccountInput) {
  const kit = await Safe.init({ provider: network.rpcUrl, isL1SafeSingleton: true,
    contractNetworks: protocolContractNetworks(network), predictedSafe: {
      safeAccountConfig: { owners: [...account.owners], threshold: 1, fallbackHandler: account.fallbackHandler,
        to: zeroAddress, data: '0x', paymentToken: zeroAddress, payment: 0, paymentReceiver: zeroAddress },
      safeDeploymentConfig: { safeVersion: '1.4.1', saltNonce: account.saltNonce, deploymentType: 'canonical' },
    } });
  const predictedAddress = getAddress(await kit.getAddress());
  if (account.predictedAddress && !same(account.predictedAddress, predictedAddress)) throw new Error('Safe predicted address mismatch');
  return { kit, predictedAddress };
}
async function deployment(network: SafeNetworkConfig, account: SafeAccountInput, allowDeployed = false): Promise<PreparedSafeDeployment> {
  const client = localClient(network); validateAccount(network, account); await checkNetwork(client, network);
  for (const owner of account.owners) if (hasCode(await client.getCode({ address: owner }))) throw new Error('Safe owners must be EOAs');
  const { kit, predictedAddress } = await predictedKit(network, account);
  if (!allowDeployed && hasCode(await client.getCode({ address: predictedAddress }))) throw new Error('Safe already deployed');
  // The SDK's createSafeDeploymentTransaction intentionally refuses an existing
  // proxy. Its predicted initCode derives the same factory call without sending
  // or requiring absence, so recovery can validate the original exact bytes.
  const initCode = allowDeployed ? await kit.getInitCode() : undefined;
  const tx = initCode ? { to: initCode.slice(0, 42), value: '0', data: `0x${initCode.slice(42)}` }
    : await kit.createSafeDeploymentTransaction();
  if (tx.value !== '0' || !hex(tx.data) || !same(tx.to, network.contracts.safeProxyFactory.address)) throw new Error('Safe deployment transaction mismatch');
  return { version: '0.1', network, account: { ...account, predictedAddress }, predictedAddress,
    transaction: { to: getAddress(tx.to), value: '0', data: tx.data } };
}
export async function prepareSafeDeployment(network: SafeNetworkConfig, account: SafeAccountInput): Promise<PreparedSafeDeployment> {
  validateNetwork(network); return deployment(clone(network), clone(account));
}
async function validateDeployment(prepared: PreparedSafeDeployment): Promise<void> {
  const derived = await deployment(prepared.network, prepared.account);
  if (prepared.version !== '0.1' || !same(derived.predictedAddress, prepared.predictedAddress) ||
      JSON.stringify(derived.transaction) !== JSON.stringify(prepared.transaction)) throw new Error('Safe deployment binding mismatch');
}

/** Strict, no-sign/no-send validation against separately trusted deployment configuration. */
export async function validateStoredDeployment(input: PreparedSafeDeployment | PreparedDeploymentExecution,
  expected: PreparedSafeDeployment, payer: Address): Promise<void> {
  validateNetwork(expected.network); validateNetwork(input.network); requireAddress(payer);
  const signed = 'rawTransaction' in input;
  exactKeys(input, ['version', 'network', 'account', 'predictedAddress', 'transaction',
    ...(signed ? ['payer', 'payerNonce', 'rawTransaction', 'transactionHash'] : [])]);
  const derived = await deployment(expected.network, expected.account, true);
  for (const key of ['version', 'network', 'account', 'predictedAddress', 'transaction'] as const) {
    if (!isDeepStrictEqual(input[key], derived[key]) || !isDeepStrictEqual(expected[key], derived[key])) {
      throw new Error('Safe stored deployment configuration mismatch');
    }
  }
  if (signed) {
    if (!same(input.payer, payer)) throw new Error('Safe configured payer mismatch');
    await validateOuter(expected.network, derived.transaction, input, [...derived.account.owners, derived.predictedAddress], false);
  }
}

export type ExpectedSafeCall = { network: SafeNetworkConfig; account: SafeAccountDeploymentConfig;
  call: SafeSingleCall; payer: Address };
/** Historical validation intentionally does not require an unconsumed nonce. */
export async function validateStoredCall(input: PreparedSafeCall | ApprovedSafeCall | PreparedSafeExecution,
  expected: ExpectedSafeCall, atBlock?: bigint): Promise<void> {
  validateNetwork(expected.network); validatePrepared(input); validateCall(expected.call);
  const approved = 'ownerSignature' in input; const signed = 'rawTransaction' in input;
  exactKeys(input, ['version', 'network', 'safe', 'nonce', 'call', 'transactionData', 'safeTxHash',
    ...(approved ? ['owner', 'ownerSignature', 'executionCalldata'] : []),
    ...(signed ? ['payer', 'payerNonce', 'rawTransaction', 'transactionHash'] : [])]);
  if (!isDeepStrictEqual(input.network, expected.network) || !same(input.safe, expected.account.predictedAddress) ||
      !sameCall(input.call, expected.call)) throw new Error('Safe configured call mismatch');
  const state = await readSafeAccount(expected.network, input.safe, expected.account, atBlock);
  if (approved) await validateApproval(input, state);
  if (signed) {
    if (!approved || !same(input.payer, expected.payer)) throw new Error('Safe configured payer mismatch');
    await validateOuter(expected.network, { to: input.safe, value: '0', data: input.executionCalldata }, input,
      [...expected.account.owners, input.safe], false);
  }
}

function sameCall(a: SafeSingleCall, b: SafeSingleCall): boolean {
  validateCall(a); validateCall(b);
  return same(a.to, b.to) && a.value === b.value && a.data === b.data && a.operation === b.operation;
}

function validateCall(call: SafeSingleCall): void {
  exactKeys(call, ['to', 'value', 'data', 'operation']); requireAddress(call.to);
  if (call.value !== '0' || call.operation !== 0 || !hex(call.data) || call.data.length > 131074) {
    throw new Error('Safe accepts one bounded zero-value Call only');
  }
}
function transactionData(call: SafeSingleCall, nonce: number): SafeTransactionData {
  validateCall(call); checkedNonce(nonce);
  return { ...call, nonce, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress };
}
function validatePrepared(prepared: PreparedSafeCall): void {
  validateNetwork(prepared.network); requireAddress(prepared.safe); checkedNonce(prepared.nonce);
  const data = transactionData(prepared.call, prepared.nonce);
  exactKeys(prepared.transactionData, Object.keys(data));
  if (prepared.version !== '0.1' || !Object.entries(data).every(([key, value]) =>
    prepared.transactionData[key as keyof SafeTransactionData] === value)) throw new Error('Safe transaction fields changed');
  const txHash = calculateSafeTransactionHash(prepared.safe, data, '1.4.1', BigInt(prepared.network.chainId));
  if (!hash(prepared.safeTxHash) || !same(txHash, prepared.safeTxHash)) throw new Error('Safe transaction hash mismatch');
}
async function currentNonce(client: PublicClient, safe: Address, atBlock?: bigint): Promise<number> {
  return checkedNonce(await client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce',
    ...(atBlock === undefined ? {} : { blockNumber: atBlock }) }));
}
async function checkPreparedState(prepared: PreparedSafeCall): Promise<SafeAccountReadback> {
  validatePrepared(prepared);
  const state = await readSafeAccount(prepared.network, prepared.safe);
  if (await currentNonce(localClient(prepared.network), prepared.safe) !== prepared.nonce) throw new Error('Safe nonce is stale');
  return state;
}
export async function prepareSingleCall(networkInput: SafeNetworkConfig, safe: Address, callInput: SafeSingleCall): Promise<PreparedSafeCall> {
  const network = clone(networkInput); validateNetwork(network); const call = clone(callInput); validateCall(call);
  await readSafeAccount(network, safe);
  const nonce = await currentNonce(localClient(network), safe);
  const kit = await Safe.init({ provider: network.rpcUrl, safeAddress: safe, isL1SafeSingleton: true,
    contractNetworks: protocolContractNetworks(network) });
  const tx = await kit.createTransaction({ transactions: [call], onlyCalls: true,
    options: { nonce, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress } });
  const result: PreparedSafeCall = { version: '0.1', network, safe, nonce, call,
    transactionData: tx.data, safeTxHash: await kit.getTransactionHash(tx) as Hash };
  validatePrepared(result); return result;
}
function executionData(approved: ApprovedSafeCall): Hex {
  const tx = approved.transactionData;
  return encodeFunctionData({ abi: loadSafeArtifacts().safeSingleton.abi, functionName: 'execTransaction',
    args: [tx.to, BigInt(tx.value), tx.data, tx.operation, 0n, 0n, 0n, zeroAddress, zeroAddress, approved.ownerSignature] });
}
async function validateApproval(approved: ApprovedSafeCall, state: SafeAccountReadback): Promise<void> {
  validatePrepared(approved); requireAddress(approved.owner);
  if (!state.owners.some((owner) => same(owner, approved.owner))) throw new Error('Safe signer is not a current owner');
  if (!/^0x[0-9a-fA-F]{130}$/.test(approved.ownerSignature)) throw new Error('Safe signature invalid');
  const v = Number.parseInt(approved.ownerSignature.slice(-2), 16);
  if (v !== 31 && v !== 32) throw new Error('Safe signature must be an EOA eth_sign signature');
  const normalized = `${approved.ownerSignature.slice(0, -2)}${(v - 4).toString(16)}` as Hex;
  let recovered: Address;
  try { recovered = await recoverMessageAddress({ message: { raw: approved.safeTxHash }, signature: normalized }); }
  catch { throw new Error('Safe signature invalid'); }
  if (!same(recovered, approved.owner) || approved.executionCalldata !== executionData(approved)) throw new Error('Safe signature/calldata binding mismatch');
}
export async function approveSingleCall(input: PreparedSafeCall, ownerKit: InstanceType<typeof Safe>): Promise<ApprovedSafeCall> {
  const prepared = clone(input); const state = await checkPreparedState(prepared);
  const provider = ownerKit.getSafeProvider();
  if (typeof provider.provider !== 'string') throw new Error('Safe owner kit must use the configured loopback RPC');
  assertLocalWriteRpcUrl(provider.provider);
  if (provider.provider !== prepared.network.rpcUrl || !same(await ownerKit.getAddress(), prepared.safe) ||
      await provider.getChainId() !== BigInt(prepared.network.chainId) || ownerKit.getContractVersion() !== '1.4.1') {
    throw new Error('Safe owner kit network/account mismatch');
  }
  const owner = await provider.getSignerAddress();
  if (!owner || !state.owners.some((address) => same(owner, address))) throw new Error('Safe signer is not a current owner');
  let signature;
  try { signature = await ownerKit.signHash(prepared.safeTxHash); }
  catch { throw new Error('Safe owner approval failed'); }
  if (signature.isContractSignature || !same(signature.signer, owner)) throw new Error('Safe requires EOA owner approval');
  const approved = { ...prepared, owner: getAddress(owner), ownerSignature: signature.data as Hex, executionCalldata: '0x' as Hex };
  approved.executionCalldata = executionData(approved);
  // Cross-check the stock SDK encoding, without allowing its outer send path.
  const tx = await ownerKit.createTransaction({ transactions: [prepared.call], options: prepared.transactionData });
  tx.addSignature(new EthSafeSignature(owner, approved.ownerSignature));
  if (await ownerKit.getEncodedTransaction(tx) !== approved.executionCalldata) throw new Error('Safe SDK execution encoding mismatch');
  await validateApproval(approved, state); return approved;
}

async function payerNonce(client: PublicClient, payer: Address): Promise<number> {
  const rpcNonce = await client.request({ method: 'eth_getTransactionCount', params: [payer, 'pending'] });
  return checkedNonce(BigInt(rpcNonce));
}
async function signOuter(network: SafeNetworkConfig, transaction: UnsignedTransaction,
  wallet: PayerWallet, excluded: readonly Address[]) {
  validateNetwork(network);
  if (clientUrl(wallet) !== network.rpcUrl || wallet.account?.type !== 'local') throw new Error('Safe requires a local payer bound to the configured RPC');
  const payer = wallet.account.address; requireAddress(payer);
  if (excluded.some((address) => same(address, payer))) throw new Error('Safe payer must be separate from owners and Safe');
  const client = localClient(network); await checkNetwork(client, network);
  const nonce = await payerNonce(client, payer);
  let rawTransaction: Hex;
  try {
    const gas = await client.estimateGas({ account: payer, to: transaction.to, data: transaction.data, value: 0n });
    const fees = await client.estimateFeesPerGas({ type: 'eip1559', chain: undefined });
    rawTransaction = await wallet.signTransaction({ account: wallet.account, chain: null, type: 'eip1559',
      chainId: network.chainId, to: transaction.to, value: 0n, data: transaction.data, nonce,
      gas: gas + gas / 5n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  } catch { throw new Error('Safe payer transaction preparation failed'); }
  const result = { payer, payerNonce: nonce, rawTransaction, transactionHash: keccak256(rawTransaction) };
  await validateOuter(network, transaction, result, excluded, false); return result;
}
type SignedOuter = Pick<PreparedSafeExecution, 'payer' | 'payerNonce' | 'rawTransaction' | 'transactionHash'>;
async function validateOuter(network: SafeNetworkConfig, transaction: UnsignedTransaction, signed: SignedOuter,
  excluded: readonly Address[], requireCurrentNonce: boolean): Promise<void> {
  validateNetwork(network); checkedNonce(signed.payerNonce); requireAddress(signed.payer);
  if (!hex(signed.rawTransaction) || signed.rawTransaction.length > 262146 || !hash(signed.transactionHash) ||
      !same(keccak256(signed.rawTransaction), signed.transactionHash)) throw new Error('Safe outer bytes/hash mismatch');
  let parsed; let recovered;
  if (!signed.rawTransaction.startsWith('0x02')) throw new Error('Safe requires EIP-1559 outer bytes');
  try { parsed = parseTransaction(signed.rawTransaction); recovered = await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction as `0x02${string}` }); }
  catch { throw new Error('Safe outer transaction invalid'); }
  if (parsed.type !== 'eip1559' || parsed.chainId !== network.chainId || parsed.nonce !== signed.payerNonce ||
      !parsed.to || !same(parsed.to, transaction.to) || parsed.data !== transaction.data || (parsed.value ?? 0n) !== 0n ||
      !parsed.gas || !parsed.maxFeePerGas || parsed.maxPriorityFeePerGas === undefined ||
      parsed.maxPriorityFeePerGas > parsed.maxFeePerGas || (parsed.accessList?.length ?? 0) !== 0 ||
      !same(recovered, signed.payer) || excluded.some((address) => same(address, signed.payer))) {
    throw new Error('Safe outer transaction binding mismatch');
  }
  checkedNonce(parsed.nonce);
  if (requireCurrentNonce && await payerNonce(localClient(network), signed.payer) !== signed.payerNonce) throw new Error('Safe payer nonce is stale');
}
export async function prepareDeploymentExecution(input: PreparedSafeDeployment, wallet: PayerWallet): Promise<PreparedDeploymentExecution> {
  validateNetwork(input.network);
  if (clientUrl(wallet) !== input.network.rpcUrl) throw new Error('Safe payer RPC mismatch');
  const prepared = clone(input); await validateDeployment(prepared);
  return { ...prepared, ...await signOuter(prepared.network, prepared.transaction, wallet,
    [...prepared.account.owners, prepared.predictedAddress]) };
}
export async function prepareExecution(input: ApprovedSafeCall, wallet: PayerWallet): Promise<PreparedSafeExecution> {
  validateNetwork(input.network);
  if (clientUrl(wallet) !== input.network.rpcUrl) throw new Error('Safe payer RPC mismatch');
  const approved = clone(input); const state = await checkPreparedState(approved); await validateApproval(approved, state);
  return { ...approved, ...await signOuter(approved.network, { to: approved.safe, value: '0', data: approved.executionCalldata },
    wallet, [...state.owners, approved.safe]) };
}
const submitted = new Set<string>();
async function sendOnce(network: SafeNetworkConfig, signed: SignedOuter): Promise<TransactionReceipt> {
  validateNetwork(network); const client = localClient(network);
  const key = `${network.genesisHash}:${signed.transactionHash}`.toLowerCase();
  if (submitted.has(key)) throw new Error('Safe signed transaction already submitted; reconcile its exact hash');
  submitted.add(key);
  try {
    const result = await client.request({ method: 'eth_sendRawTransaction', params: [signed.rawTransaction] }, { retryCount: 0 });
    if (!same(result, signed.transactionHash)) throw new Error('unexpected transaction hash');
    const receipt = await client.waitForTransactionReceipt({ hash: signed.transactionHash, timeout: 10_000 });
    if (receipt.status !== 'success' || !same(receipt.transactionHash, signed.transactionHash)) throw new Error('outer transaction failed');
    await canonicalBlock(client, receipt.blockNumber, receipt.blockHash); return receipt;
  } catch { throw new Error('Safe submission outcome unresolved or failed; reconcile exact prepared transaction hash without re-signing'); }
}
export async function executeSafeDeployment(input: PreparedDeploymentExecution): Promise<SafeAccountReadback & {
  account: SafeAccountDeploymentConfig; transactionHash: Hash;
}> {
  const prepared = clone(input); await validateDeployment(prepared);
  await validateOuter(prepared.network, prepared.transaction, prepared, [...prepared.account.owners, prepared.predictedAddress], true);
  const receipt = await sendOnce(prepared.network, prepared);
  const state = await readSafeAccount(prepared.network, prepared.predictedAddress, prepared.account, receipt.blockNumber);
  if (!same(state.blockHash, receipt.blockHash)) throw new Error('Safe deployment read-back block changed');
  return { ...state, account: prepared.account, transactionHash: prepared.transactionHash };
}
function successfulExecution(receipt: TransactionReceipt, safe: Address, safeTxHash: Hash): void {
  const success = toEventSelector('ExecutionSuccess(bytes32,uint256)');
  const failure = toEventSelector('ExecutionFailure(bytes32,uint256)');
  const events = receipt.logs.filter((log) => same(log.address, safe) &&
    (log.topics[0] === success || log.topics[0] === failure));
  if (receipt.status !== 'success' || events.length !== 1 || events[0]!.topics[0] !== success) throw new Error('Safe inner execution did not succeed exactly once');
  const log = events[0]!;
  if (log.topics.length !== 2 || log.data.length !== 66 || log.removed) throw new Error('Safe execution event malformed');
  const decoded = decodeEventLog({ abi: safeAbi, eventName: 'ExecutionSuccess', data: log.data, topics: log.topics, strict: true });
  if (!same(decoded.args.txHash, safeTxHash) || decoded.args.payment !== 0n) throw new Error('Safe execution hash/payment mismatch');
}
export async function executePrepared(input: PreparedSafeExecution): Promise<SafeExecution> {
  const prepared = clone(input); const state = await checkPreparedState(prepared); await validateApproval(prepared, state);
  await validateOuter(prepared.network, { to: prepared.safe, value: '0', data: prepared.executionCalldata }, prepared,
    [...state.owners, prepared.safe], true);
  const receipt = await sendOnce(prepared.network, prepared);
  successfulExecution(receipt, prepared.safe, prepared.safeTxHash);
  await canonicalBlock(localClient(prepared.network), receipt.blockNumber, receipt.blockHash);
  return { ...prepared, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash };
}

export type ExpectedRegisteredAgent = {
  /** Trusted fixture deployment configuration, never candidate-supplied or TOFU. */
  domain: IdentityContinuityDomain; registryRuntimeCodeHash: Hash; call: SafeSingleCall;
};
/** Shared exact-hash outer/inner/canonical-block and pinned registry read-back. No nonce-based success inference. */
export async function readSafeExecutionEffect(client: PublicClient, input: PreparedSafeExecution | SafeExecution,
  expectedInput: ExpectedRegisteredAgent) {
  const execution = clone(input); const expected = clone(expectedInput); validatePrepared(execution);
  if (clientUrl(client) !== execution.network.rpcUrl) throw new Error('Safe reader RPC mismatch');
  const { domain } = expected;
  if (domain.chainId !== execution.network.chainId || !same(domain.genesisHash, execution.network.genesisHash) ||
      !same(expected.call.to, domain.registry) ||
      !sameCall(expected.call, execution.call)) throw new Error('Safe expected call/domain mismatch');
  validateCall(expected.call); requireAddress(domain.registry);
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: execution.transactionHash }), client.getTransaction({ hash: execution.transactionHash }),
  ]);
  if (!transaction.to || !same(transaction.from, execution.payer) || !same(transaction.to, execution.safe) ||
      transaction.input !== execution.executionCalldata || transaction.value !== 0n || transaction.nonce !== execution.payerNonce ||
      transaction.chainId !== execution.network.chainId || !same(receipt.transactionHash, execution.transactionHash) ||
      !same(transaction.hash, execution.transactionHash) || transaction.blockNumber !== receipt.blockNumber ||
      !transaction.blockHash || !same(transaction.blockHash, receipt.blockHash) ||
      !same(receipt.from, execution.payer) || !receipt.to || !same(receipt.to, execution.safe)) throw new Error('Safe receipt/transaction binding mismatch');
  if ('blockNumber' in execution && (execution.blockNumber !== String(receipt.blockNumber) || !same(execution.blockHash, receipt.blockHash))) {
    throw new Error('Safe execution numbered block mismatch');
  }
  const state = await readSafeAccount(execution.network, execution.safe, undefined, receipt.blockNumber);
  await validateApproval(execution, state);
  await validateOuter(execution.network, { to: execution.safe, value: '0', data: execution.executionCalldata }, execution,
    [...state.owners, execution.safe], false);
  successfulExecution(receipt, execution.safe, execution.safeTxHash);
  await readSafeRegistryConfiguration(client, expected, receipt.blockNumber);
  await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  return { receipt, state };
}

/** Same pinned registry check at a selected numbered block, also used before new onboarding writes. */
export async function readSafeRegistryConfiguration(client: PublicClient,
  expected: Pick<ExpectedRegisteredAgent, 'domain' | 'registryRuntimeCodeHash'>, atBlock?: bigint): Promise<void> {
  clientUrl(client);
  const { domain } = expected;
  if (await client.getChainId() !== domain.chainId || !same((await client.getBlock({ blockNumber: 0n })).hash!, domain.genesisHash)) {
    throw new Error('Safe registry domain mismatch');
  }
  const blockNumber = atBlock ?? await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error('Safe registry block unavailable');
  const artifacts = compileReferenceContracts();
  const implementation = domain.knownImplementation;
  // The fixture records the deployed implementation runtime, including UUPS's
  // address-dependent immutable. Its zero-filled compiler template is not it.
  if (!implementation || !hash(implementation.codeHash) ||
      !same(expected.registryRuntimeCodeHash, keccak256(artifacts.erc1967Proxy.deployedBytecode))) throw new Error('Safe registry runtime pin mismatch');
  const [proxyCode, implementationCode, slot] = await Promise.all([
    client.getCode({ address: domain.registry, blockNumber }),
    client.getCode({ address: implementation.address, blockNumber }),
    client.getStorageAt({ address: domain.registry, slot: IMPLEMENTATION_SLOT, blockNumber }),
  ]);
  if (!proxyCode || !same(keccak256(proxyCode), expected.registryRuntimeCodeHash) || !implementationCode ||
      !same(keccak256(implementationCode), implementation.codeHash) || !slot ||
      !same(slot, padHex(implementation.address, { size: 32 }))) throw new Error('Safe registry deployed runtime mismatch');
  await canonicalBlock(client, blockNumber, block.hash);
}

/** Independently fetches exact-hash transaction/receipt and original-block effect; no supplied receipt is trusted. */
export async function readRegisteredAgentEffect(client: PublicClient, input: PreparedSafeExecution | SafeExecution,
  expectedInput: ExpectedRegisteredAgent) {
  const execution = clone(input); const expected = clone(expectedInput); const { domain } = expected;
  if (expected.call.data !== '0x1aa3a008') throw new Error('Safe expected register call mismatch');
  const { receipt } = await readSafeExecutionEffect(client, execution, expected);
  const events = receipt.logs.filter((log) => same(log.address, domain.registry) &&
    log.topics[0] === toEventSelector('Registered(uint256,string,address)'));
  if (events.length !== 1) throw new Error('Safe register effect must contain one canonical Registered event');
  const log = events[0]!;
  if (log.topics.length !== 3 || log.removed || log.logIndex === null || !same(log.blockHash!, receipt.blockHash)) throw new Error('Safe Registered log malformed');
  const event = decodeEventLog({ abi: registryAbi, eventName: 'Registered', data: log.data, topics: log.topics, strict: true });
  const agentId = event.args.agentId;
  const [owner, uri] = await Promise.all([
    client.readContract({ address: domain.registry, abi: registryAbi, functionName: 'ownerOf', args: [agentId], blockNumber: receipt.blockNumber }),
    client.readContract({ address: domain.registry, abi: registryAbi, functionName: 'tokenURI', args: [agentId], blockNumber: receipt.blockNumber }),
  ]);
  if (!same(owner, execution.safe) || !same(event.args.owner, execution.safe) || uri !== '' || event.args.agentURI !== '') throw new Error('Safe registered ownership/URI mismatch');
  await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  return { transactionHash: execution.transactionHash, safeTxHash: execution.safeTxHash, registry: domain.registry,
    agentId: String(agentId), owner, agentURI: uri, payment: '0' as const, blockNumber: String(receipt.blockNumber),
    blockHash: receipt.blockHash, registeredLogIndex: log.logIndex };
}

/** Exact factory transaction and canonical deployed configuration, independently read after restart. */
export async function readSafeDeploymentEffect(client: PublicClient, input: PreparedDeploymentExecution,
  expected: PreparedSafeDeployment, payer: Address) {
  await validateStoredDeployment(input, expected, payer);
  if (clientUrl(client) !== expected.network.rpcUrl) throw new Error('Safe reader RPC mismatch');
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: input.transactionHash }), client.getTransaction({ hash: input.transactionHash }),
  ]);
  if (receipt.status !== 'success' || !same(receipt.transactionHash, input.transactionHash) ||
      !same(transaction.hash, input.transactionHash) || !transaction.to || !same(transaction.to, expected.transaction.to) ||
      !same(transaction.from, payer) || transaction.input !== expected.transaction.data || transaction.value !== 0n ||
      transaction.nonce !== input.payerNonce || transaction.chainId !== expected.network.chainId ||
      transaction.blockNumber !== receipt.blockNumber || !transaction.blockHash || !same(transaction.blockHash, receipt.blockHash) ||
      !same(receipt.from, payer) || !receipt.to || !same(receipt.to, expected.transaction.to)) {
    throw new Error('Safe deployment transaction/receipt mismatch');
  }
  const state = await readSafeAccount(expected.network, expected.predictedAddress, expected.account, receipt.blockNumber);
  if (!same(state.blockHash, receipt.blockHash)) throw new Error('Safe deployment block mismatch');
  await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  return { safe: state.safe, transactionHash: input.transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash };
}
export async function assertRuntimeSeparated(runtime: Address, account: { network: SafeNetworkConfig; safe: Address },
  registry?: Address, agentId?: string): Promise<void> {
  requireAddress(runtime); const state = await readSafeAccount(account.network, account.safe);
  const client = localClient(account.network); const blockNumber = BigInt(state.blockNumber);
  if (same(runtime, account.safe) || state.owners.some((owner) => same(owner, runtime))) throw new Error('runtime must not be a Safe owner');
  if (hasCode(await client.getCode({ address: runtime, blockNumber }))) throw new Error('runtime must be an EOA');
  if (registry !== undefined) {
    requireAddress(registry);
    if (await client.readContract({ address: registry, abi: registryAbi, functionName: 'isApprovedForAll',
      args: [account.safe, runtime], blockNumber })) throw new Error('runtime operator approval refused');
    if (agentId !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(agentId) || agentId.length > 78 || BigInt(agentId) >= 1n << 256n) throw new Error('invalid runtime agent ID');
      const [owner, approved] = await Promise.all([
        client.readContract({ address: registry, abi: registryAbi, functionName: 'ownerOf', args: [BigInt(agentId)], blockNumber }),
        client.readContract({ address: registry, abi: registryAbi, functionName: 'getApproved', args: [BigInt(agentId)], blockNumber }),
      ]);
      if (!same(owner, account.safe)) throw new Error('runtime token is not Safe-owned');
      if (same(approved, runtime)) throw new Error('runtime token approval refused');
    }
  } else if (agentId !== undefined) throw new Error('runtime agent ID requires registry');
  await canonicalBlock(client, blockNumber, state.blockHash);
}
