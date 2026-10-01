import { Router, type Request, type Response } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import { CONTRACT_ABI, DELEGATION_ABI } from "./config";
import { RelayStore, type RelayRecord } from "./relayStore";

export interface RelayOptions {
  enabled: boolean; privateKey: string; delegationContract: string;
  rpcUrl: string; contractAddress: string; chainId: number; saveDir: string;
  maxGasPrice: number; signatureValiditySeconds: number;
  dailyBudget: string; minBalance: string; maxPending: number;
  addressLimit: number; ipLimit: number;
}

const address = z.string().refine(ethers.isAddress).transform(ethers.getAddress);
const hash = z.string().regex(/^0x[\da-fA-F]{64}$/);
const requestSchema = z.object({
  userAddress: address, action: z.number().int().min(0).max(7),
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  executionNonce: z.string().regex(/^(0|[1-9]\d{0,77})$/).refine(value => BigInt(value) < 2n ** 256n),
  requestId: hash.transform(value => value.toLowerCase()),
  signature: z.string().regex(/^0x[\da-fA-F]{130}$/),
  authorization: z.object({
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    r: hash, s: hash, yParity: z.union([z.literal(0), z.literal(1)]),
  }).nullish(),
});

class RelayError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly requestId?: string) {
    super(message);
  }
}

const voteInterface = new ethers.Interface(CONTRACT_ABI);
const delegationInterface = new ethers.Interface(DELEGATION_ABI);

export function voteHash(owner: string, contract: string, action: number, nonce: bigint, deadline: number, chainId: number) {
  return ethers.solidityPackedKeccak256(
    ["address", "address", "uint256", "bytes", "uint256", "uint256", "uint256"],
    [owner, contract, 0, voteInterface.encodeFunctionData("vote", [action]), nonce, deadline, chainId],
  );
}

function publicRecord(record: RelayRecord) {
  return { requestId: record.requestId, status: record.status, txHash: record.txHash, error: record.error };
}

export async function createRelay(options: RelayOptions) {
  const provider = new ethers.JsonRpcProvider(options.rpcUrl, undefined, { cacheTimeout: -1 });
  const wallet = options.privateKey ? new ethers.Wallet(options.privateKey, provider) : undefined;
  if (options.enabled && !wallet) throw new Error("RELAY_PRIVATE_KEY is required");
  const contract = ethers.getAddress(options.contractAddress);
  const delegate = ethers.getAddress(options.delegationContract);
  const cap = ethers.parseUnits(String(options.maxGasPrice), "gwei");
  const budget = ethers.parseEther(options.dailyBudget);
  const minBalance = ethers.parseEther(options.minBalance);
  for (const value of [options.maxPending, options.addressLimit, options.ipLimit, options.signatureValiditySeconds, options.chainId]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Relay limits must be positive integers");
  }
  if (cap <= 0n || budget <= 0n || minBalance < 0n) throw new Error("Invalid relay spending limits");
  if (Number((await provider.getNetwork()).chainId) !== options.chainId) throw new Error("Relay RPC chain mismatch");
  if (options.enabled && ((await provider.getCode(contract)) === "0x" || (await provider.getCode(delegate)) === "0x")) {
    throw new Error("Relay contracts are not deployed on the configured chain");
  }
  const store = await RelayStore.open(options.saveDir, `${options.chainId}:${contract}:${delegate}`, wallet?.address ?? "");
  const router = Router();
  let queue = Promise.resolve();
  let queued = 0;
  let closed = false;
  let recoveryError = false;
  const rate = new Map<string, { count: number; until: number }>();

  function limit(key: string, maximum: number) {
    const now = Date.now();
    for (const [entry, value] of rate) if (value.until <= now) rate.delete(entry);
    const current = rate.get(key) ?? { count: 0, until: now + 60000 };
    if (current.count >= maximum || (!rate.has(key) && rate.size >= 10000)) {
      throw new RelayError("RATE_LIMITED", "Voting limit reached. Please wait a minute.", 429);
    }
    current.count++;
    rate.set(key, current);
  }

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    if (closed || queued >= options.maxPending) return Promise.reject(new RelayError("BUSY", "Relay is busy. Try again shortly.", 503));
    queued++;
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {}).finally(() => { queued--; });
    return result;
  }

  async function accountState(owner: string) {
    const block = await provider.getBlockNumber();
    const [code, transactionNonce] = await Promise.all([
      provider.getCode(owner, block), provider.getTransactionCount(owner, block),
    ]);
    const delegated = code.toLowerCase() === `0xef0100${delegate.slice(2).toLowerCase()}`;
    let nonce = 0n;
    let state = "unsupported";
    if (delegated) {
      state = "delegated";
      const result = await provider.call({
        to: owner, data: delegationInterface.encodeFunctionData("getNonce", [owner]), blockTag: block,
      });
      nonce = delegationInterface.decodeFunctionResult("getNonce", result)[0] as bigint;
    } else if (code === "0x" && transactionNonce === 0) state = "fresh";
    return { state, delegated, nonceDecimal: nonce.toString(), transactionNonce };
  }

  async function reconcile(record: RelayRecord) {
    const receipt = await provider.getTransactionReceipt(record.txHash);
    if (receipt) {
      const voted = receipt.status === 1 && receipt.logs.some(log => {
        if (log.address.toLowerCase() !== contract.toLowerCase()) return false;
        try {
          const event = voteInterface.parseLog(log);
          return event?.name === "VoteCast" && event.args.player.toLowerCase() === record.owner.toLowerCase() && Number(event.args.action) === record.action;
        } catch { return false; }
      });
      await store.settle(record, voted ? "confirmed" : "failed", receipt.fee, voted ? undefined : "Transaction did not emit the expected vote.");
      return;
    }
    if (record.cancelHash) {
      const cancellation = await provider.getTransactionReceipt(record.cancelHash);
      if (cancellation) {
        await store.settle(record, "failed", cancellation.fee, "Vote expired before execution.");
        return;
      }
    }
    if (!options.enabled || !wallet) return;
    store.assertWritable();
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Latest block unavailable");
    if (block.timestamp > record.deadline && !record.cancelRaw) {
      const original = ethers.Transaction.from(record.rawTransaction);
      const fees = await provider.getFeeData();
      const bumped = (original.maxFeePerGas ?? 0n) * 1125n / 1000n + 1n;
      const maxFeePerGas = bumped > (fees.maxFeePerGas ?? 0n) ? bumped : fees.maxFeePerGas!;
      const priority = (original.maxPriorityFeePerGas ?? 0n) * 1125n / 1000n + 1n;
      if (maxFeePerGas > cap || priority > maxFeePerGas) return;
      record.cancelRaw = await wallet.signTransaction({
        type: 2, chainId: options.chainId, nonce: record.sponsorNonce, to: wallet.address,
        value: 0n, gasLimit: 21000n, maxFeePerGas, maxPriorityFeePerGas: priority,
      });
      record.cancelHash = ethers.keccak256(record.cancelRaw);
      await store.save();
    }
    const raw = record.cancelRaw ?? record.rawTransaction;
    if (block.timestamp > record.deadline && !record.cancelRaw) return;
    try { await provider.broadcastTransaction(raw); } catch {
      // A timeout or "already known" response does not settle a transaction.
    }
  }

  async function recover() {
    store.assertWritable();
    for (const record of store.pending()) await reconcile(record);
  }

  const handle = (operation: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.json(await operation(req)); }
    catch (error) {
      if (error instanceof RelayError) {
        res.status(error.status).json({ code: error.code, error: error.message, requestId: error.requestId });
      } else {
        res.status(503).json({ code: "UNAVAILABLE", error: "Relay unavailable. Pending votes can be checked again later." });
      }
    }
  };

  router.get("/health", handle(async () => {
    store.assertWritable();
    const sponsor = wallet?.address || store.data.sponsor;
    const balance = sponsor ? await provider.getBalance(sponsor) : 0n;
    const day = new Date().toISOString().slice(0, 10);
    return {
      enabled: options.enabled, ready: options.enabled && !recoveryError && balance > minBalance && store.committed(day) < budget,
      chainId: options.chainId, wallet: sponsor, balance: ethers.formatEther(balance),
      delegationContract: delegate, voteContract: contract, signatureValiditySeconds: options.signatureValiditySeconds,
    };
  }));

  for (const endpoint of ["/delegated/:address", "/nonce/:address"]) {
    router.get(endpoint, handle(async req => {
      const parsed = address.safeParse(req.params.address);
      if (!parsed.success) throw new RelayError("INVALID_ADDRESS", "Invalid wallet address");
      const state = await accountState(parsed.data);
      const pending = store.pending().find(record => record.owner === parsed.data);
      return { ...state, nonce: BigInt(state.nonceDecimal) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(state.nonceDecimal) : undefined, pendingRequestId: pending?.requestId };
    }));
  }

  router.get("/requests/:id", handle(async req => {
    const parsed = hash.safeParse(req.params.id);
    if (!parsed.success) throw new RelayError("INVALID_REQUEST", "Invalid request ID");
    return serial(async () => {
      const record = store.data.records[parsed.data.toLowerCase()];
      if (!record) throw new RelayError("NOT_FOUND", "Request not recorded. Its outcome is not yet known.", 404);
      if (record.status === "pending") await reconcile(record);
      return publicRecord(record);
    });
  }));

  router.post("/", handle(async req => {
    limit(`ip:${req.ip}`, options.ipLimit);
    if (!options.enabled || !wallet) throw new RelayError("DISABLED", "Sponsored voting is unavailable.", 503);
    if (req.body?.executionNonce === undefined || req.body?.requestId === undefined) {
      throw new RelayError("CLIENT_OUTDATED", "Refresh this page to continue voting.", 400);
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) throw new RelayError("INVALID_REQUEST", "Invalid vote request");
    const input = parsed.data;
    const digest = voteHash(input.userAddress, contract, input.action, BigInt(input.executionNonce), input.deadline, options.chainId);
    let signer: string;
    try { signer = ethers.verifyMessage(ethers.getBytes(digest), input.signature); }
    catch { throw new RelayError("INVALID_SIGNATURE", "Invalid vote signature"); }
    if (digest !== input.requestId || signer !== input.userAddress || signer === wallet.address) {
      throw new RelayError("INVALID_SIGNATURE", "Invalid vote signature");
    }
    limit(`owner:${signer}`, options.addressLimit);
    return serial(async () => {
      store.assertWritable();
      const existing = store.data.records[digest];
      if (existing) return publicRecord(existing);
      await recover();
      const pending = store.pending();
      const conflict = pending.find(record => record.owner === signer);
      if (conflict) throw new RelayError("PENDING", "A previous vote is still pending.", 409, conflict.requestId);
      if (pending.length >= options.maxPending) throw new RelayError("BUSY", "Relay queue is full.", 503);
      const now = Math.floor(Date.now() / 1000);
      if (input.deadline <= now || input.deadline > now + options.signatureValiditySeconds) {
        throw new RelayError("EXPIRED", "Vote signature expired or its lifetime is too long.");
      }
      const state = await accountState(signer);
      if (state.state === "unsupported") throw new RelayError("UNSUPPORTED_ACCOUNT", "This account needs external-wallet recovery before sponsored voting.");
      if (state.nonceDecimal !== input.executionNonce) throw new RelayError("STALE_NONCE", "Account nonce changed. Check your previous vote.", 409);
      let authorizationList: ethers.Authorization[] | undefined;
      if (!state.delegated) {
        const auth = input.authorization;
        if (!auth) throw new RelayError("AUTHORIZATION_REQUIRED", "Authorize this account before voting.");
        try {
          const signature = ethers.Signature.from({ r: auth.r, s: auth.s, yParity: auth.yParity });
          const authorization = { address: delegate, chainId: BigInt(auth.chainId), nonce: BigInt(auth.nonce), signature };
          if (auth.chainId !== options.chainId || auth.nonce !== state.transactionNonce || ethers.verifyAuthorization(authorization, signature) !== signer) {
            throw new Error("Authorization mismatch");
          }
          authorizationList = [authorization];
        } catch { throw new RelayError("INVALID_AUTHORIZATION", "Invalid account authorization"); }
      }
      const fees = await provider.getFeeData();
      if (!fees.maxFeePerGas || fees.maxFeePerGas > cap) throw new RelayError("FEE_LIMIT", "Network fees exceed the sponsorship limit.", 503);
      const chainNonce = await provider.getTransactionCount(wallet.address, "pending");
      const nonce = Math.max(chainNonce, ...pending.map(record => record.sponsorNonce + 1));
      const transaction: ethers.TransactionRequest = {
        type: authorizationList ? 4 : 2, chainId: options.chainId, nonce,
        from: wallet.address, to: signer,
        data: delegationInterface.encodeFunctionData("execute", [contract, 0, voteInterface.encodeFunctionData("vote", [input.action]), input.deadline, input.signature]),
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
        ...(authorizationList ? { authorizationList } : {}),
      };
      const estimate = await provider.estimateGas(transaction);
      const gasLimit = estimate * 120n / 100n;
      if (gasLimit > 250000n) throw new RelayError("GAS_LIMIT", "Vote exceeds the sponsorship gas limit.");
      transaction.gasLimit = gasLimit;
      const reserved = gasLimit * cap;
      const day = new Date().toISOString().slice(0, 10);
      const balance = await provider.getBalance(wallet.address);
      const pendingCost = pending.reduce((sum, record) => sum + BigInt(record.reserved), 0n);
      if (store.committed(day) + reserved > budget || balance < minBalance + pendingCost + reserved) {
        throw new RelayError("BUDGET_LIMIT", "Sponsorship funds are temporarily unavailable.", 503);
      }
      const rawTransaction = await wallet.signTransaction(transaction);
      const record: RelayRecord = {
        requestId: digest, owner: signer, action: input.action, executionNonce: input.executionNonce,
        deadline: input.deadline, sponsorNonce: nonce, txHash: ethers.keccak256(rawTransaction),
        rawTransaction, reserved: reserved.toString(), status: "pending",
      };
      store.data.records[digest] = record;
      await store.save();
      await reconcile(record);
      return publicRecord(record);
    });
  }));

  try { await recover(); } catch { recoveryError = true; }
  const interval = setInterval(() => {
    if (queued || closed) return;
    void serial(recover).then(() => { recoveryError = false; }, () => { recoveryError = true; });
  }, 1000);
  interval.unref();
  return {
    router,
    async close() {
      closed = true;
      clearInterval(interval);
      await queue;
      await store.close();
      provider.destroy();
    },
  };
}
