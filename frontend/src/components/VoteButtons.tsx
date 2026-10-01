import { useState, useEffect, useRef } from "react";
import { useWallets, useSign7702Authorization } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useWriteContract } from "wagmi";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { Action, CONTRACT_ADDRESS, CONTRACT_ABI, RELAY_CONFIG, monadTestnet, type ActionType, type AuthMode } from "../config/wagmi";
import { submitRelayVote } from "../utils/relay";
import "./VoteButtons.css";

const VOTE_COOLDOWN_MS = Number(import.meta.env.VITE_VOTE_COOLDOWN_MS || "500");

interface VoteButtonsProps {
  disabled?: boolean;
  disabledReason?: string;
  authMode?: AuthMode;
  meraVote: (action: ActionType, signal: AbortSignal, onSubmitted: () => void) => Promise<void>;
}

export function VoteButtons({ disabled, disabledReason, authMode, meraVote }: VoteButtonsProps) {
  const [pendingAction, setPendingAction] = useState<ActionType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [sentAction, setSentAction] = useState<ActionType | null>(null);
  const inFlight = useRef(false);
  const lastVote = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { wallets } = useWallets();
  const { signAuthorization } = useSign7702Authorization();
  const { client: smartWalletClient } = useSmartWallets();
  const { writeContractAsync, isPending: isWriting } = useWriteContract();

  useEffect(() => () => {
    controller.current?.abort();
    clearTimeout(sentTimer.current);
  }, [authMode]);

  const markVoteSent = (action: ActionType) => {
    setSentAction(action);
    clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSentAction(null), 1500);
  };

  const vote = async (action: ActionType) => {
    if (disabled || inFlight.current || Date.now() - lastVote.current < VOTE_COOLDOWN_MS) return;
    inFlight.current = true;
    lastVote.current = Date.now();
    const abort = new AbortController();
    controller.current = abort;
    setPendingAction(action);
    setError(null);
    setIsVoting(true);
    const submitted = () => { if (!abort.signal.aborted) markVoteSent(action); };
    try {
      if (authMode === "mera") {
        await meraVote(action, abort.signal, submitted);
      } else if (authMode === "relay") {
        const userWallet = wallets.find(wallet => wallet.walletClientType === "privy") || wallets[0];
        if (!userWallet) throw new Error("No wallet connected");
        const provider = await userWallet.getEthereumProvider();
        await submitRelayVote({
          address: userWallet.address as Address,
          assertActive: () => abort.signal.throwIfAborted(),
          signMessage: async hash => provider.request({ method: "personal_sign", params: [hash, userWallet.address] }) as Promise<Hex>,
          signAuthorization: async nonce => {
            abort.signal.throwIfAborted();
            if (userWallet.walletClientType !== "privy") throw new Error("Use Connect Wallet for direct voting with this wallet.");
            const authorization = await signAuthorization({
              contractAddress: RELAY_CONFIG.delegationContract as Hex,
              chainId: monadTestnet.id, nonce,
            }, { address: userWallet.address });
            return { chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity! };
          },
        }, action, abort.signal, submitted);
      } else if (authMode === "privy") {
        if (!smartWalletClient) throw new Error("Smart wallet is still connecting.");
        const isDeployed = await smartWalletClient.account?.isDeployed();
        abort.signal.throwIfAborted();
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
        submitted();
      } else if (authMode === "direct") {
        await writeContractAsync({ address: CONTRACT_ADDRESS as Hex, abi: CONTRACT_ABI, functionName: "vote", args: [action] });
        submitted();
      } else {
        throw new Error("Connect an account to vote.");
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "Vote failed.";
        setError(message.includes("rejected") || message.includes("denied") ? "Signature cancelled" : message.slice(0, 240));
      }
    } finally {
      inFlight.current = false;
      setIsVoting(false);
      setPendingAction(null);
    }
  };

  const isDisabled = disabled || isVoting || isWriting;
  const isButtonSent = (action: ActionType) => sentAction === action;
  const getButtonText = (action: ActionType, label: string) => pendingAction === action ? "..." : label;

  return (
    <div className="vote-buttons">
      <h3>Cast Your Vote</h3>

      {/* D-Pad */}
      <div className="dpad">
        <button
          className={`dpad-btn up ${isButtonSent(Action.UP) ? 'sent' : ''}`}
          onClick={() => vote(Action.UP)}
          disabled={isDisabled}
        >
          {pendingAction === Action.UP && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.UP)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
        <button
          className={`dpad-btn left ${isButtonSent(Action.LEFT) ? 'sent' : ''}`}
          onClick={() => vote(Action.LEFT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.LEFT && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.LEFT)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
        <div className="dpad-center" />
        <button
          className={`dpad-btn right ${isButtonSent(Action.RIGHT) ? 'sent' : ''}`}
          onClick={() => vote(Action.RIGHT)}
          disabled={isDisabled}
        >
          {pendingAction === Action.RIGHT && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.RIGHT)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
        <button
          className={`dpad-btn down ${isButtonSent(Action.DOWN) ? 'sent' : ''}`}
          onClick={() => vote(Action.DOWN)}
          disabled={isDisabled}
        >
          {pendingAction === Action.DOWN && (isVoting || isWriting)
            ? <span className="loading">...</span>
            : isButtonSent(Action.DOWN)
            ? <span className="checkmark">✓</span>
            : <span className="arrow" />}
        </button>
      </div>

      {/* Action buttons */}
      <div className="action-buttons">
        <button
          className={`action-btn b ${isButtonSent(Action.B) ? 'sent' : ''}`}
          onClick={() => vote(Action.B)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.B) ? "✓" : getButtonText(Action.B, "B")}
        </button>
        <button
          className={`action-btn a ${isButtonSent(Action.A) ? 'sent' : ''}`}
          onClick={() => vote(Action.A)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.A) ? "✓" : getButtonText(Action.A, "A")}
        </button>
      </div>

      {/* Start/Select */}
      <div className="menu-buttons">
        <button
          className={`menu-btn ${isButtonSent(Action.SELECT) ? 'sent' : ''}`}
          onClick={() => vote(Action.SELECT)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.SELECT) ? "✓ SENT" : getButtonText(Action.SELECT, "SELECT")}
        </button>
        <button
          className={`menu-btn ${isButtonSent(Action.START) ? 'sent' : ''}`}
          onClick={() => vote(Action.START)}
          disabled={isDisabled}
        >
          {isButtonSent(Action.START) ? "✓ SENT" : getButtonText(Action.START, "START")}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {disabled && <p className="warning">{disabledReason || "Sign in to vote"}</p>}
    </div>
  );
}
