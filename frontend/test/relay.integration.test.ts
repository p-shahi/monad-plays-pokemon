import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { deriveMeraAccount } from "../src/utils/mera";
import { createRelay, voteHash, type RelayOptions } from "../../indexer/src/relay";
import { RelayStore } from "../../indexer/src/relayStore";
import { VoteAggregator } from "../../indexer/src/voteAggregator";

const requireIndexer = createRequire(new URL("../../indexer/package.json", import.meta.url));
const express = requireIndexer("express") as typeof import("../../indexer/node_modules/express");
const root = path.resolve(import.meta.dirname, "../..");
let anvil: ChildProcess;
let provider: ethers.JsonRpcProvider;
let sponsor: ethers.Wallet;
let directory: string;
let options: RelayOptions;
let relay: Awaited<ReturnType<typeof createRelay>>;
let server: Server;
let api: string;
let contract: string;
let delegate: string;

async function startRelay() {
  relay = await createRelay(options);
  const app = express();
  app.use(express.json());
  app.use("/relay", relay.router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}/relay`;
}

async function stopRelay() {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await relay.close();
}

beforeAll(async () => {
  execFileSync("forge", ["build"], { cwd: path.join(root, "contracts"), stdio: "pipe" });
  directory = await mkdtemp(path.join(tmpdir(), "pokemon-relay-"));
  const reservation = createServer().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => reservation.once("listening", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--hardfork", "prague", "--silent"], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  provider = new ethers.JsonRpcProvider(rpcUrl, 31337, { cacheTimeout: -1 });
  for (let attempt = 0; ; attempt++) {
    try { await provider.getBlockNumber(); break; }
    catch { if (attempt === 50) throw new Error("Anvil did not start"); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  // Public Anvil fixture key, used only on the disposable local chain.
  const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  sponsor = new ethers.Wallet(privateKey, provider);
  async function deploy(name: string) {
    const artifact = JSON.parse(await readFile(path.join(root, `contracts/out/${name}.sol/${name}.json`), "utf8"));
    const instance = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, sponsor).deploy();
    await instance.waitForDeployment();
    return instance.getAddress();
  }
  contract = await deploy("MonadPlaysPokemon");
  delegate = await deploy("SimpleDelegation");
  options = {
    enabled: true, privateKey, delegationContract: delegate, contractAddress: contract, rpcUrl,
    chainId: 31337, saveDir: directory, maxGasPrice: 200, signatureValiditySeconds: 300,
    dailyBudget: "10", minBalance: "0", maxPending: 16, addressLimit: 100, ipLimit: 200,
  };
  await startRelay();
}, 120000);

afterAll(async () => {
  if (server?.listening) await stopRelay();
  provider?.destroy();
  anvil?.kill();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function signedVote(seed: number, action = 0, executionNonce = "0", authorize = true) {
  const wallet = deriveMeraAccount(new Uint8Array(32).fill(seed));
  try {
    const userAddress = wallet.account.address;
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const requestId = voteHash(userAddress, contract, action, BigInt(executionNonce), deadline, 31337) as `0x${string}`;
    const signature = await wallet.account.signMessage({ message: { raw: requestId } });
    const authorization = authorize ? await wallet.account.signAuthorization!({ contractAddress: delegate as `0x${string}`, chainId: 31337, nonce: 0 }) : null;
    return { userAddress, action, deadline, requestId, signature, executionNonce, authorization };
  } finally { wallet.end(); }
}

async function post(body: unknown) {
  const response = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value) });
  return { status: response.status, data: await response.json() };
}

async function settled(id: string) {
  for (let i = 0; i < 50; i++) {
    const result = await (await fetch(`${api}/requests/${id}`)).json();
    if (result.status && result.status !== "pending") return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Vote did not settle");
}

it("sponsors first and repeat Mera votes from an unfunded EOA", async () => {
  const first = await signedVote(11);
  expect(await provider.getBalance(first.userAddress)).toBe(0n);
  const result = await post(first);
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  expect((await settled(first.requestId)).status).toBe("confirmed");
  const receipt = await provider.getTransactionReceipt(result.data.txHash);
  const event = new ethers.Interface(["event VoteCast(address indexed player, uint8 action)"]).parseLog(receipt!.logs[0]);
  let winningAction: string | undefined;
  const aggregator = new VoteAggregator(1, result => { winningAction = result.winningAction; });
  aggregator.addVote(event!.args.player, Number(event!.args.action), receipt!.blockNumber, receipt!.hash);
  aggregator.onBlock(receipt!.blockNumber + 1, `0x${"12".repeat(32)}`);
  expect(winningAction).toBe("UP");
  expect((await provider.getCode(first.userAddress)).toLowerCase()).toBe(`0xef0100${delegate.slice(2).toLowerCase()}`);
  expect((await (await fetch(`${api}/nonce/${first.userAddress}`)).json()).nonceDecimal).toBe("1");
  const second = await signedVote(11, 4, "1", false);
  expect((await post(second)).status).toBe(200);
  expect((await settled(second.requestId)).status).toBe("confirmed");
  expect((await (await fetch(`${api}/nonce/${first.userAddress}`)).json()).nonceDecimal).toBe("2");
});

it("rejects malformed votes and mismatched authorization before spending gas", async () => {
  const vote = await signedVote(12);
  const nonce = await provider.getTransactionCount(sponsor.address);
  expect((await post({ ...vote, action: "1" })).status).toBe(400);
  expect((await post({ ...vote, signature: `0x${"11".repeat(65)}` })).status).toBe(400);
  expect((await post({ ...vote, authorization: { ...vote.authorization, chainId: 1 } })).data.code).toBe("INVALID_AUTHORIZATION");
  expect(await provider.getTransactionCount(sponsor.address)).toBe(nonce);
});

it("rejects unexpected delegation and cleared accounts with a used authority nonce", async () => {
  const vote = await signedVote(25);
  const nonce = await provider.getTransactionCount(sponsor.address);
  await provider.send("anvil_setCode", [vote.userAddress, `0xef0100${contract.slice(2)}`]);
  expect((await post(vote)).data.code).toBe("UNSUPPORTED_ACCOUNT");
  await provider.send("anvil_setCode", [vote.userAddress, "0x"]);
  await provider.send("anvil_setNonce", [vote.userAddress, "0x1"]);
  expect((await post(vote)).data.code).toBe("UNSUPPORTED_ACCOUNT");
  expect(await provider.getTransactionCount(sponsor.address)).toBe(nonce);
});

it("recovers the same request after a lost response and process restart", async () => {
  await provider.send("evm_setAutomine", [false]);
  const vote = await signedVote(13);
  const first = await post(vote);
  expect(first.status, JSON.stringify(first.data)).toBe(200);
  const journal = JSON.parse(await readFile(path.join(directory, "relay.json"), "utf8"));
  expect(journal.records[vote.requestId].rawTransaction).toMatch(/^0x04/);
  await stopRelay();
  await startRelay();
  const repeated = await post(vote);
  expect(repeated.data.txHash).toBe(first.data.txHash);
  await provider.send("evm_mine", []);
  await provider.send("evm_setAutomine", [true]);
  expect((await settled(vote.requestId)).status).toBe("confirmed");
  expect((await post(vote)).data.txHash).toBe(first.data.txHash);
  expect((await (await fetch(`${api}/nonce/${vote.userAddress}`)).json()).nonceDecimal).toBe("1");
  const status = await (await fetch(`${api}/requests/${vote.requestId}`)).json();
  expect(status.rawTransaction).toBeUndefined();
});

it("coordinates sponsor nonces for simultaneous players", async () => {
  await provider.send("evm_setAutomine", [false]);
  const votes = await Promise.all([signedVote(14), signedVote(15)]);
  const responses = await Promise.all(votes.map(post));
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  const journal = JSON.parse(await readFile(path.join(directory, "relay.json"), "utf8"));
  const nonces = votes.map(vote => journal.records[vote.requestId].sponsorNonce);
  expect(new Set(nonces).size).toBe(2);
  await provider.send("evm_mine", []);
  await provider.send("evm_setAutomine", [true]);
  for (const vote of votes) expect((await settled(vote.requestId)).status).toBe("confirmed");
});

it("reserves a player nonce against conflicting requests from two tabs", async () => {
  await provider.send("evm_setAutomine", [false]);
  const first = await signedVote(17, 0);
  const second = await signedVote(17, 4);
  expect((await post(first)).status).toBe(200);
  const conflict = await post(second);
  expect(conflict.status).toBe(409);
  expect(conflict.data).toMatchObject({ code: "PENDING", requestId: first.requestId });
  await provider.send("evm_mine", []);
  await provider.send("evm_setAutomine", [true]);
  expect((await settled(first.requestId)).status).toBe("confirmed");
});

it("recognizes delegation retained after a reverted first vote", async () => {
  await provider.send("evm_setAutomine", [false]);
  const vote = await signedVote(18);
  expect((await post(vote)).status).toBe(200);
  await provider.send("evm_setNextBlockTimestamp", [vote.deadline + 1]);
  await provider.send("evm_mine", []);
  await provider.send("evm_setAutomine", [true]);
  expect((await settled(vote.requestId)).status).toBe("failed");
  const state = await (await fetch(`${api}/nonce/${vote.userAddress}`)).json();
  expect(state).toMatchObject({ state: "delegated", nonceDecimal: "0" });
  await provider.send("evm_setTime", [Date.now()]);
});

it("keeps request lookup available while sponsorship is disabled", async () => {
  await stopRelay();
  options.enabled = false;
  await startRelay();
  const vote = await signedVote(16);
  expect((await post(vote)).data.code).toBe("DISABLED");
  expect((await (await fetch(`${api}/health`)).json()).ready).toBe(false);
  await stopRelay();
  options.enabled = true;
  await startRelay();
});

it("refuses a second writer and retains spending after restart", async () => {
  await expect(RelayStore.open(directory, "another", sponsor.address)).rejects.toThrow();
  const before = JSON.parse(await readFile(path.join(directory, "relay.json"), "utf8"));
  expect(BigInt(Object.values(before.spent)[0] as string)).toBeGreaterThan(0n);
  await stopRelay();
  await startRelay();
  const after = JSON.parse(await readFile(path.join(directory, "relay.json"), "utf8"));
  expect(after.spent).toEqual(before.spent);
});

it("enforces the shared spending budget, minimum balance, fee cap, and owner limit", async () => {
  const defaults = { ...options };
  const nonce = await provider.getTransactionCount(sponsor.address);
  for (const [setting, expected] of [
    [{ dailyBudget: "0.000000000000000001" }, "BUDGET_LIMIT"],
    [{ minBalance: "1000000" }, "BUDGET_LIMIT"],
    [{ maxGasPrice: 0.001 }, "FEE_LIMIT"],
  ] as const) {
    await stopRelay();
    options = { ...defaults, ...setting };
    await startRelay();
    expect((await post(await signedVote(21))).data.code).toBe(expected);
  }
  await stopRelay();
  options = { ...defaults, addressLimit: 1 };
  await startRelay();
  const vote = await signedVote(22);
  expect((await post({ ...vote, authorization: null })).data.code).toBe("AUTHORIZATION_REQUIRED");
  expect((await post(vote)).data.code).toBe("RATE_LIMITED");
  expect(await provider.getTransactionCount(sponsor.address)).toBe(nonce);
  await stopRelay();
  options = defaults;
  await startRelay();
});

it("cancels a dropped and expired submission at its reserved sponsor nonce", async () => {
  await provider.send("evm_setAutomine", [false]);
  const vote = await signedVote(23);
  const submitted = await post(vote);
  expect(submitted.status).toBe(200);
  await stopRelay();
  await provider.send("anvil_dropTransaction", [submitted.data.txHash]);
  await provider.send("evm_setNextBlockTimestamp", [vote.deadline + 1]);
  await provider.send("evm_mine", []);
  await startRelay();
  await provider.send("evm_mine", []);
  await provider.send("evm_setAutomine", [true]);
  expect((await settled(vote.requestId)).status).toBe("failed");
  expect(await provider.getCode(vote.userAddress)).toBe("0x");
  const journal = JSON.parse(await readFile(path.join(directory, "relay.json"), "utf8"));
  expect(journal.records[vote.requestId].cancelHash).toMatch(/^0x/);
  expect(journal.records[vote.requestId].rawTransaction).toBe("");
  await provider.send("evm_setTime", [Date.now()]);
});

it("stops before broadcast when the journal cannot be written", async () => {
  const vote = await signedVote(24);
  const nonce = await provider.getTransactionCount(sponsor.address);
  const obstruction = path.join(directory, "relay.json.tmp");
  await mkdir(obstruction);
  expect((await post(vote)).data.code).toBe("UNAVAILABLE");
  expect((await (await fetch(`${api}/health`)).json()).code).toBe("UNAVAILABLE");
  expect(await provider.getTransactionCount(sponsor.address, "pending")).toBe(nonce);
  await stopRelay();
  await rm(obstruction, { recursive: true });
  await startRelay();
  expect((await fetch(`${api}/requests/${vote.requestId}`)).status).toBe(404);
});

it("encodes a Game Boy sized frame with sharp on the supported Node runtime", async () => {
  const sharp = requireIndexer("sharp") as typeof import("../../indexer/node_modules/sharp");
  const jpeg = await sharp(Buffer.alloc(160 * 144 * 4), { raw: { width: 160, height: 144, channels: 4 } }).jpeg().toBuffer();
  expect(await sharp(jpeg).metadata()).toMatchObject({ format: "jpeg", width: 160, height: 144 });
});
