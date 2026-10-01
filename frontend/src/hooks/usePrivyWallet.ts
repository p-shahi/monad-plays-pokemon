import { usePrivy, useWallets, useSign7702Authorization } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { CONTRACT_ADDRESS, CONTRACT_ABI, RELAY_CONFIG, monadTestnet, type ActionType } from "../config/wagmi";
import { submitRelayVote } from "../utils/relay";

export function usePrivyWallet() {
  const { login, logout, ready, authenticated } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { signAuthorization } = useSign7702Authorization();
  const { client: smartWalletClient } = useSmartWallets();

  const vote = async (mode: "privy" | "relay", action: ActionType, signal: AbortSignal, onSubmitted: () => void) => {
    signal.throwIfAborted();
    if (mode === "relay") {
      const userWallet = wallets.find(wallet => wallet.walletClientType === "privy") || wallets[0];
      if (!userWallet) throw new Error("No wallet connected");
      const provider = await userWallet.getEthereumProvider();
      await submitRelayVote({
        address: userWallet.address as Address,
        assertActive: () => signal.throwIfAborted(),
        signMessage: async hash => provider.request({ method: "personal_sign", params: [hash, userWallet.address] }) as Promise<Hex>,
        signAuthorization: async nonce => {
          signal.throwIfAborted();
          if (userWallet.walletClientType !== "privy") throw new Error("Use Connect Wallet for direct voting with this wallet.");
          const authorization = await signAuthorization({
            contractAddress: RELAY_CONFIG.delegationContract as Hex,
            chainId: monadTestnet.id, nonce,
          }, { address: userWallet.address });
          return { chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity };
        },
      }, action, signal, onSubmitted);
      return;
    }
    if (!smartWalletClient) throw new Error("Smart wallet is still connecting.");
    const isDeployed = await smartWalletClient.account?.isDeployed();
    signal.throwIfAborted();
    await smartWalletClient.sendTransaction({
      calls: [{
        to: CONTRACT_ADDRESS as Hex,
        data: encodeFunctionData({ abi: CONTRACT_ABI, functionName: "vote", args: [action] }),
      }],
      ...(isDeployed ? {
        callGasLimit: 15000n, verificationGasLimit: 130000n, preVerificationGas: 165000n,
        maxFeePerGas: 155000000000n, maxPriorityFeePerGas: 2500000000n,
      } : {}),
    }, { uiOptions: { showWalletUIs: false } });
    onSubmitted();
  };

  return { login, logout, ready, authenticated, wallets, walletsReady, setActiveWallet, vote };
}

export type PrivyWallet = ReturnType<typeof usePrivyWallet>;
