// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { submitRelayVote, type RelaySigner } from "../src/utils/relay";

const fixtures = vi.hoisted(() => ({
  owner: "0x1111111111111111111111111111111111111111" as const,
  contract: "0x2222222222222222222222222222222222222222" as const,
  delegate: "0x3333333333333333333333333333333333333333" as const,
  getBlock: vi.fn(), getTransactionReceipt: vi.fn(),
}));
vi.mock("../src/config/wagmi", () => ({
  CONTRACT_ADDRESS: fixtures.contract,
  CONTRACT_ABI: [{ type: "function", name: "vote", inputs: [{ name: "action", type: "uint8" }], outputs: [], stateMutability: "nonpayable" }],
  RELAY_CONFIG: { enabled: true, apiUrl: "", delegationContract: fixtures.delegate, signatureValiditySeconds: 300 },
  monadTestnet: { id: 10143 },
  publicClient: { getChainId: async () => 10143, getBlock: fixtures.getBlock, getTransactionReceipt: fixtures.getTransactionReceipt },
}));
let calls: { path: string; init?: RequestInit }[];
let responseMode: "lost" | "pending" | "rejected";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  calls = [];
  responseMode = "lost";
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.endsWith("/health")) return json({ ready: true, enabled: true, chainId: 10143, voteContract: fixtures.contract, delegationContract: fixtures.delegate, signatureValiditySeconds: 300 });
    if (path.includes("/nonce/")) return json({ state: "fresh", nonceDecimal: "0", transactionNonce: 0 });
    if (init?.method === "POST") {
      if (responseMode === "rejected") return json({ code: "INVALID_AUTHORIZATION", error: "Invalid authorization" }, 400);
      if (responseMode === "pending") return json({ code: "PENDING", error: "Previous vote pending", requestId: `0x${"ab".repeat(32)}` }, 409);
      throw new TypeError("Connection lost after broadcast");
    }
    return json({ code: "NOT_FOUND", error: "Unknown outcome" }, 404);
  }));
});

function signer(): RelaySigner {
  return {
    address: fixtures.owner, assertActive: vi.fn(),
    signMessage: vi.fn(async () => `0x${"11".repeat(65)}` as Hex),
    signAuthorization: vi.fn(async () => ({ chainId: 10143, nonce: 0, r: `0x${"11".repeat(32)}` as Hex, s: `0x${"22".repeat(32)}` as Hex, yParity: 0 })),
  };
}

it("retains only a public request reference after a lost response and does not sign a fresh vote", async () => {
  const account = signer();
  await expect(submitRelayVote(account, 0, new AbortController().signal)).rejects.toThrow("Connection lost");
  expect(localStorage.length).toBe(1);
  const pending = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
  expect(pending.action).toBe(0);
  expect(pending.signature).toBeUndefined();
  expect(pending.authorization).toBeUndefined();
  fixtures.getBlock.mockResolvedValue({ timestamp: BigInt(pending.deadline - 1) });
  await expect(submitRelayVote(account, 4, new AbortController().signal)).rejects.toThrow("Previous submission is unconfirmed");
  expect(account.signMessage).toHaveBeenCalledOnce();
  expect(calls.filter(call => call.init?.method === "POST")).toHaveLength(1);
});

it("clears a request the relay definitively rejected", async () => {
  responseMode = "rejected";
  await expect(submitRelayVote(signer(), 0, new AbortController().signal)).rejects.toThrow("Invalid authorization");
  expect(localStorage.length).toBe(0);
});

it("does not leave a conflicting unsubmitted request in storage", async () => {
  responseMode = "pending";
  await expect(submitRelayVote(signer(), 0, new AbortController().signal)).rejects.toThrow("Previous vote pending");
  expect(localStorage.length).toBe(0);
});

it("blocks a vote if the account locks while authorization is being signed", async () => {
  const account = signer();
  let active = true;
  account.assertActive = () => { if (!active) throw new Error("Session locked"); };
  const sign = account.signAuthorization;
  account.signAuthorization = async nonce => { active = false; return sign(nonce); };
  await expect(submitRelayVote(account, 0, new AbortController().signal)).rejects.toThrow("Session locked");
  expect(calls.some(call => call.init?.method === "POST")).toBe(false);
  expect(localStorage.length).toBe(0);
});
