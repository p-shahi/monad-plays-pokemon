import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession,
  isMeraError, type PasskeyCredentialMetadata,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { isAddress, type Address } from "viem";

export const MERA_ENABLED = (import.meta.env.VITE_MERA_ENABLED ?? "true") === "true";
export const IDLE_TIMEOUT = 15 * 60 * 1000;
const STORAGE_KEY = "pokemon.mera.account.v1";
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface MeraIdentity {
  version: 1;
  rpId: string;
  credential: PasskeyCredentialMetadata;
  address: Address;
}

export function relyingParty() {
  const rpId = import.meta.env.VITE_MERA_RP_ID || (location.hostname === "localhost" ? "localhost" : "");
  if (!window.isSecureContext || !rpId || rpId !== location.hostname) {
    throw new Error("Passkeys require HTTPS and a configured RP ID matching this hostname.");
  }
  return { id: rpId, name: import.meta.env.VITE_MERA_RP_NAME || "Monad Plays Pokemon" };
}

export function loadMeraIdentity(): MeraIdentity | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (value?.version === 1 && value.rpId === relyingParty().id && isAddress(value.address) &&
        typeof value.credential?.credentialId === "string" && /^[\w-]+$/.test(value.credential.credentialId)) {
      return { version: 1, rpId: value.rpId, address: value.address, credential: { credentialId: value.credential.credentialId } };
    }
  } catch { /* Discovery can recover an account without local metadata. */ }
}

export function deriveMeraAccount(prfOutput: Uint8Array) {
  let seed: Uint8Array | undefined;
  const nodes: HDKey[] = [];
  let privateKey: Uint8Array | null = null;
  try {
    seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    let node: HDKey = HDKey.fromMasterSeed(seed);
    nodes.push(node);
    // Derive one level at a time so every intermediate private node is wiped.
    for (const index of [0x8000002c, 0x8000003c, 0x80000000, 0, 0]) {
      const child: HDKey = node.deriveChild(index);
      nodes.push(child);
      node = child;
    }
    privateKey = node.privateKey;
    if (!privateKey) throw new Error("Could not derive the passkey account.");
    const session = createSecp256k1SigningSession({ privateKey });
    try { return { account: toViemAccount(session), end: () => session.end() }; }
    catch (error) { session.end(); throw error; }
  } finally {
    prfOutput.fill(0);
    seed?.fill(0);
    privateKey?.fill(0);
    for (const node of nodes) node.wipePrivateData();
  }
}

export async function openMeraAccount(mode: "create" | "discover" | "unlock", known?: MeraIdentity) {
  const rp = relyingParty();
  if (mode === "create" && !MERA_ENABLED) throw new Error("New passkey accounts are temporarily unavailable.");
  const result = mode === "create"
    ? await createPasskeyWithPrfOutput({ rp, user: { name: "Pokemon player", displayName: `Pokemon ${new Date().toLocaleDateString()}` } })
    : await getPasskeyPrfOutput({ rpId: rp.id, ...(mode === "unlock" && known ? { credential: known.credential } : {}) });
  const wallet = deriveMeraAccount(result.prfOutput);
  if (mode === "unlock" && known && wallet.account.address.toLowerCase() !== known.address.toLowerCase()) {
    wallet.end();
    throw new Error("This passkey has a different address. Use account selection to switch.");
  }
  const identity: MeraIdentity = { version: 1, rpId: rp.id, credential: { credentialId: result.credentialId }, address: wallet.account.address };
  return { ...wallet, identity };
}

export function rememberMeraIdentity(identity: MeraIdentity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export async function exportMeraPhrase(identity: MeraIdentity) {
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: relyingParty().id, credential: identity.credential });
  try {
    const phrase = entropyToMnemonic(prfOutput, wordlist);
    const wallet = deriveMeraAccount(prfOutput);
    try {
      if (wallet.account.address.toLowerCase() !== identity.address.toLowerCase()) throw new Error("Passkey address does not match.");
      return phrase;
    } finally { wallet.end(); }
  } finally { prfOutput.fill(0); }
}

export function meraError(error: unknown) {
  if (isMeraError(error)) {
    switch (error.code) {
      case "PRF_UNAVAILABLE": return "This authenticator cannot unlock a passkey account. Try a PRF-capable passkey provider or another login option.";
      case "PASSKEY_OPERATION_FAILED": return "Passkey request cancelled or unavailable. If creation already succeeded, try Use existing passkey.";
      case "SESSION_ENDED": return "Your passkey account is locked. Unlock it to vote.";
      case "CRYPTO_UNAVAILABLE": return "This browser does not provide the required cryptography APIs.";
    }
  }
  return error instanceof Error ? error.message : "Passkey operation failed.";
}
