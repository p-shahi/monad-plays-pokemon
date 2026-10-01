import { encodeFunctionData, encodePacked, keccak256, isAddress, isHex, type Address, type Hex } from "viem";
import { CONTRACT_ABI, CONTRACT_ADDRESS, RELAY_CONFIG, monadTestnet, publicClient, type ActionType } from "../config/wagmi";

export interface RelaySigner {
  address: Address;
  signMessage: (hash: Hex) => Promise<Hex>;
  signAuthorization: (nonce: number) => Promise<{ chainId: number; nonce: number; r: Hex; s: Hex; yParity: number }>;
  assertActive: () => void;
}
interface PendingVote {
  requestId: Hex; userAddress: Address; chainId: number; contract: Address;
  action: ActionType; executionNonce: string; deadline: number;
}
interface RelayStatus { requestId: Hex; status: "pending" | "confirmed" | "failed"; txHash: Hex; error?: string }
interface RelayState { state: "fresh" | "delegated" | "unsupported"; nonceDecimal: string; transactionNonce: number; pendingRequestId?: Hex }
interface RelayHealth { ready: boolean; enabled: boolean; chainId: number; voteContract: Address; delegationContract: Address; signatureValiditySeconds: number }

export class RelayRequestError extends Error {
  readonly code: string;
  readonly requestId?: Hex;
  constructor(message: string, code: string, requestId?: Hex) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(`${RELAY_CONFIG.apiUrl}/relay${path}`, {
    ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const result = await response.json();
  if (!response.ok) throw new RelayRequestError(result.error || "Relay request failed.", result.code, result.requestId);
  return result as T;
}

export async function relayHealth(signal?: AbortSignal) {
  const health = await request<RelayHealth>("/health", {}, signal);
  if (!RELAY_CONFIG.enabled || !health.enabled || !health.ready) throw new Error("Sponsored voting is temporarily unavailable.");
  if (health.chainId !== monadTestnet.id || !isAddress(health.voteContract) || !isAddress(health.delegationContract) ||
      health.voteContract.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase() ||
      health.delegationContract.toLowerCase() !== RELAY_CONFIG.delegationContract.toLowerCase() ||
      await publicClient.getChainId() !== monadTestnet.id) throw new Error("Wallet and relay network settings do not match.");
  if (!Number.isSafeInteger(health.signatureValiditySeconds) || health.signatureValiditySeconds <= 0) throw new Error("Invalid relay configuration.");
  return health;
}

export function executionHash(vote: Omit<PendingVote, "requestId">) {
  return keccak256(encodePacked(
    ["address", "address", "uint256", "bytes", "uint256", "uint256", "uint256"],
    [vote.userAddress, vote.contract, 0n, encodeFunctionData({ abi: CONTRACT_ABI, functionName: "vote", args: [vote.action] }), BigInt(vote.executionNonce), BigInt(vote.deadline), BigInt(vote.chainId)],
  ));
}

const storageKey = (address: Address) => `pokemon.pending.${monadTestnet.id}.${CONTRACT_ADDRESS.toLowerCase()}.${address.toLowerCase()}`;

function loadPending(address: Address): PendingVote | undefined {
  const raw = localStorage.getItem(storageKey(address));
  if (!raw) return;
  const value = JSON.parse(raw) as PendingVote;
  if (!isHex(value.requestId) || value.requestId.length !== 66 || value.userAddress?.toLowerCase() !== address.toLowerCase() ||
      value.chainId !== monadTestnet.id || value.contract?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase() ||
      !Number.isInteger(value.action) || value.action < 0 || value.action > 7 ||
      !/^\d+$/.test(value.executionNonce) || !Number.isSafeInteger(value.deadline) || executionHash(value) !== value.requestId) {
    throw new Error("Stored pending vote is invalid. Check this account's transactions before clearing site data.");
  }
  return value;
}

async function waitForVote(requestId: Hex, signal: AbortSignal, onSubmitted?: () => void) {
  const until = Date.now() + 30000;
  let notified = false;
  while (Date.now() < until) {
    signal.throwIfAborted();
    const status = await request<RelayStatus>(`/requests/${requestId}`, {}, signal);
    if (!notified) { onSubmitted?.(); notified = true; }
    if (status.status !== "pending") return status;
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 500);
      signal.addEventListener("abort", stop, { once: true });
    });
  }
  throw new RelayRequestError("Your vote is still pending. Press a vote button to check it again.", "PENDING", requestId);
}

async function verifyVote(status: RelayStatus, pending: PendingVote) {
  if (status.status === "failed") throw new RelayRequestError(status.error || "Vote failed.", "FAILED");
  const receipt = await publicClient.getTransactionReceipt({ hash: status.txHash });
  const topic = keccak256(new TextEncoder().encode("VoteCast(address,uint8)"));
  const voted = receipt.status === "success" && receipt.logs.some(log =>
    log.address.toLowerCase() === pending.contract.toLowerCase() && log.topics[0] === topic &&
    log.topics[1]?.slice(-40).toLowerCase() === pending.userAddress.slice(2).toLowerCase() &&
    BigInt(log.data) === BigInt(pending.action));
  if (!voted) throw new Error("The transaction has no matching vote. Check its status before voting again.");
}

export async function submitRelayVote(signer: RelaySigner, action: ActionType, signal: AbortSignal, onSubmitted?: () => void) {
  const key = storageKey(signer.address);
  const previous = loadPending(signer.address);
  if (previous) {
    try {
      const status = await waitForVote(previous.requestId, signal, onSubmitted);
      await verifyVote(status, previous);
      localStorage.removeItem(key);
      return;
    } catch (error) {
      if (error instanceof RelayRequestError && error.code === "FAILED") localStorage.removeItem(key);
      if (!(error instanceof RelayRequestError) || error.code !== "NOT_FOUND") throw error;
      const block = await publicClient.getBlock();
      if (block.timestamp <= BigInt(previous.deadline)) throw new Error("Previous submission is unconfirmed. Check again after its signature expires.");
      const state = await request<RelayState>(`/nonce/${signer.address}`, {}, signal);
      if (state.pendingRequestId) {
        await waitForVote(state.pendingRequestId, signal, onSubmitted);
        throw new Error("Previous submission was reconciled. Check again before sending another vote.");
      }
      localStorage.removeItem(key);
      throw new Error("Previous signature expired. Review the vote feed, then press a button to send a new vote.");
    }
  }
  const health = await relayHealth(signal);
  const state = await request<RelayState>(`/nonce/${signer.address}`, {}, signal);
  if (state.pendingRequestId) {
    await waitForVote(state.pendingRequestId, signal, onSubmitted);
    throw new Error("Your previous vote was checked. Press a button to submit a new vote.");
  }
  if (state.state !== "fresh" && state.state !== "delegated") throw new Error("Use external-wallet recovery for this account before sponsored voting.");
  const lifetime = Math.min(RELAY_CONFIG.signatureValiditySeconds, health.signatureValiditySeconds);
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) throw new Error("Invalid vote signature lifetime configuration.");
  const vote = {
    userAddress: signer.address, chainId: monadTestnet.id, contract: CONTRACT_ADDRESS as Address,
    action, executionNonce: state.nonceDecimal, deadline: Math.floor(Date.now() / 1000) + lifetime,
  };
  const pending: PendingVote = { ...vote, requestId: executionHash(vote) };
  signer.assertActive();
  const signature = await signer.signMessage(pending.requestId);
  const authorization = state.state === "fresh" ? await signer.signAuthorization(state.transactionNonce) : null;
  signer.assertActive();
  signal.throwIfAborted();
  localStorage.setItem(key, JSON.stringify(pending));
  try {
    await request<RelayStatus>("", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pending, signature, authorization }),
    }, signal);
  } catch (error) {
    if (error instanceof RelayRequestError && ["INVALID_REQUEST", "INVALID_SIGNATURE", "INVALID_AUTHORIZATION", "EXPIRED", "STALE_NONCE", "AUTHORIZATION_REQUIRED", "RATE_LIMITED", "DISABLED", "BUDGET_LIMIT", "FEE_LIMIT", "GAS_LIMIT", "UNSUPPORTED_ACCOUNT", "CLIENT_OUTDATED", "PENDING", "BUSY"].includes(error.code)) {
      localStorage.removeItem(key);
    }
    throw error;
  }
  const status = await waitForVote(pending.requestId, signal, onSubmitted);
  try { await verifyVote(status, pending); }
  catch (error) {
    if (error instanceof RelayRequestError && error.code === "FAILED") localStorage.removeItem(key);
    throw error;
  }
  localStorage.removeItem(key);
}

export async function checkPendingVote(address: Address, signal: AbortSignal) {
  const previous = loadPending(address);
  const state = await request<RelayState>(`/nonce/${address}`, {}, signal);
  const requestId = previous?.requestId ?? state.pendingRequestId;
  if (!requestId) return "No pending vote was found for this account.";
  try {
    const status = await waitForVote(requestId, signal);
    if (previous) {
      try { await verifyVote(status, previous); }
      catch (error) {
        if (error instanceof RelayRequestError && error.code === "FAILED") localStorage.removeItem(storageKey(address));
        throw error;
      }
      localStorage.removeItem(storageKey(address));
    }
    return status.status === "confirmed" ? "Your previous vote was confirmed." : status.error || "Your previous vote failed.";
  } catch (error) {
    if (error instanceof RelayRequestError && error.code === "NOT_FOUND" && previous) {
      const block = await publicClient.getBlock();
      if (block.timestamp > BigInt(previous.deadline) && !state.pendingRequestId) {
        localStorage.removeItem(storageKey(address));
        return "The previous signature expired. Check the vote feed before sending a new vote.";
      }
    }
    throw error;
  }
}
