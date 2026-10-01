import { describe, expect, it } from "vitest";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { mnemonicToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { deriveMeraAccount } from "../src/utils/mera";

describe("Mera derivation and signing", () => {
  it("recovers the same EVM identity through an exported phrase", async () => {
    const entropy = new Uint8Array(32).fill(7);
    const imported = mnemonicToAccount(entropyToMnemonic(entropy, wordlist));
    const wallet = deriveMeraAccount(entropy);
    expect(wallet.account.address).toBe("0x29458C602E3DB4fC3b54EC2bbEE26Dbe64C7779f");
    expect(wallet.account.address).toBe(imported.address);
    expect(entropy.every(byte => byte === 0)).toBe(true);
    const message = { raw: `0x${"ab".repeat(32)}` as const };
    const signature = await wallet.account.signMessage({ message });
    expect(await recoverMessageAddress({ message, signature })).toBe(imported.address);
    const authorization = await wallet.account.signAuthorization!({
      contractAddress: "0x1111111111111111111111111111111111111111", chainId: 31337, nonce: 0,
    });
    expect(await recoverAuthorizationAddress({ authorization })).toBe(imported.address);
    wallet.end();
    await expect(wallet.account.signMessage({ message })).rejects.toMatchObject({ code: "SESSION_ENDED" });
    await expect(wallet.account.signAuthorization!({ contractAddress: authorization.address, chainId: 31337, nonce: 0 })).rejects.toMatchObject({ code: "SESSION_ENDED" });
  });
});
