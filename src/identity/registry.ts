import { isAddress, type PublicClient } from 'viem';

import type { AgentRef, AuthoritySnapshot } from './verify.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

const ownerOfAbi = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const tokenUriAbi = [
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

function parseAgentId(value: string): bigint {
  if (value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('agent.agentId must be a canonical uint256 decimal string');
  }

  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) {
    throw new Error('agent.agentId must fit in uint256');
  }
  return parsed;
}

function assertAgentRef(agent: AgentRef): bigint {
  if (!Number.isSafeInteger(agent.chainId) || agent.chainId <= 0) {
    throw new Error('agent.chainId must be a positive safe integer');
  }
  if (
    !isAddress(agent.registry, { strict: true }) ||
    agent.registry.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error('agent.registry must be a non-zero Ethereum address');
  }
  return parseAgentId(agent.agentId);
}

/**
 * Reads owner and URI at one numbered block and checks that its hash did not
 * change during the reads. The result is RPC-derived evidence, not a
 * cryptographic state proof; a later reorganization can supersede it.
 */
export async function readIdentitySnapshot(
  client: PublicClient,
  agent: AgentRef,
  blockNumber?: bigint,
): Promise<AuthoritySnapshot> {
  const agentId = assertAgentRef(agent);
  if (blockNumber !== undefined && blockNumber < 0n) {
    throw new Error('blockNumber must be nonnegative');
  }

  const rpcChainId = await client.getChainId();
  if (rpcChainId !== agent.chainId) {
    throw new Error(
      `RPC chain ID ${rpcChainId} does not match agent chain ID ${agent.chainId}`,
    );
  }

  const selectedBlock =
    blockNumber === undefined
      ? await client.getBlock({ blockTag: 'latest' })
      : await client.getBlock({ blockNumber });
  if (selectedBlock.number === null || selectedBlock.hash === null) {
    throw new Error('RPC did not return a numbered block with a hash');
  }

  const selectedNumber = selectedBlock.number;
  const selectedHash = selectedBlock.hash;
  const [agentOwner, agentURI] = await Promise.all([
    client.readContract({
      address: agent.registry,
      abi: ownerOfAbi,
      functionName: 'ownerOf',
      args: [agentId],
      blockNumber: selectedNumber,
    }),
    client.readContract({
      address: agent.registry,
      abi: tokenUriAbi,
      functionName: 'tokenURI',
      args: [agentId],
      blockNumber: selectedNumber,
    }),
  ]);

  let checkedBlock;
  try {
    checkedBlock = await client.getBlock({ blockNumber: selectedNumber });
  } catch (error) {
    throw new Error('reorganization detected while reading identity snapshot', {
      cause: error,
    });
  }
  if (checkedBlock.hash === null || checkedBlock.hash !== selectedHash) {
    throw new Error('reorganization detected while reading identity snapshot');
  }

  const blockTimestamp = Number(selectedBlock.timestamp);
  if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0) {
    throw new Error('block timestamp is outside the supported safe-integer range');
  }

  return {
    agent: { ...agent },
    blockNumber: selectedNumber.toString(),
    blockHash: selectedHash,
    blockTimestamp,
    agentOwner,
    agentURI,
  };
}
