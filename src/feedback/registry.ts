import { parseAbi } from 'viem';

export const LOCAL_FEEDBACK_CHAIN_ID = 31337;
export const REPUTATION_REGISTRY_VERSION = '2.0.0';
export const FEEDBACK_RUBRIC = 'evening-plan-usefulness-v0.1';

/** Pinned reference ReputationRegistryUpgradeable ABI, not an Index API. */
export const reputationRegistryAbi = parseAbi([
  'function getVersion() view returns (string)',
  'function getIdentityRegistry() view returns (address)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex)',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)',
]);
