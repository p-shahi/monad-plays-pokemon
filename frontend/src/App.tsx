import { useEffect, useCallback, useState, useMemo } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet, RELAY_CONFIG, type AuthMode } from "./config/wagmi";
import { useMeraWallet } from "./hooks/useMeraWallet";
import type { PrivyWallet } from "./hooks/usePrivyWallet";
import { MERA_ENABLED } from "./utils/mera";
import { checkPendingVote, relayHealth } from "./utils/relay";
import type { Address } from "viem";
import { useSocket } from "./hooks/useSocket";
import { VoteButtons } from "./components/VoteButtons";
import { GameScreen } from "./components/GameScreen";
import { VoteChat } from "./components/VoteChat";
import { GameStatusPanel } from "./components/GameStatusPanel";
import { PartyPanel } from "./components/PartyPanel";
import "./App.css";

function App({ privy }: { privy?: PrivyWallet }) {
  const mera = useMeraWallet();
  const { login, logout, ready = true, authenticated = false, wallets, walletsReady = true, setActiveWallet } = privy ?? {};
  const { address, isConnected: walletConnected, connector } = useAccount();

  // Direct wallet connection (wagmi)
  const { connect, isPending: isConnecting } = useConnect();
  const { disconnect: disconnectWagmi } = useDisconnect();
  const { switchChain } = useSwitchChain();

  // Current chain ID
  const chainId = useChainId();

  // Create injected connector
  const injectedConnector = useMemo(() => injected(), []);

  const [selectedLogin, setSelectedLogin] = useState<"mera" | "privy" | "direct" | "auto" | null>(mera.address ? "mera" : "auto");
  const [relayError, setRelayError] = useState("Checking sponsored voting...");
  const [voteStatus, setVoteStatus] = useState<{ address: string; message: string }>();

  // User preference for relay vs privy mode (only matters when logged in via Privy)
  // Default to relay (EIP-7702) when available, but allow toggle to privy (EIP-4337) for debugging
  const [preferRelay, setPreferRelay] = useState(true);
  const authMode: AuthMode = selectedLogin === "mera" ? (mera.address ? "mera" : null)
    : (selectedLogin === "privy" || selectedLogin === "auto") && authenticated && walletConnected
      ? (RELAY_CONFIG.enabled && preferRelay ? "relay" : "privy")
      : (selectedLogin === "direct" || selectedLogin === "auto") && walletConnected ? "direct"
      : null;

  // Get embedded wallet address (for native Privy transactions)
  const embeddedWallet = wallets?.find((w) => w.walletClientType === "privy");
  const embeddedWalletAddress = embeddedWallet?.address;
  const {
    isConnected: indexerConnected,
    resultHistory,
    recentVotes,
    screenInfo,
    viewerCount,
    gameState,
    setFrameCallback,
  } = useSocket();

  useEffect(() => {
    if (selectedLogin !== "mera" || !MERA_ENABLED) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        await relayHealth(controller.signal);
        if (!controller.signal.aborted) setRelayError("");
      } catch (error) {
        if (!controller.signal.aborted) setRelayError(error instanceof Error ? error.message : "Sponsored voting unavailable.");
      }
    };
    void check();
    const interval = setInterval(check, 15000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [selectedLogin]);

  // Prompt to switch chain if connected to wrong network (for direct wallet connections)
  useEffect(() => {
    if (authMode === "direct" && walletConnected && chainId !== monadTestnet.id) {
      console.log(`Wrong chain (${chainId}), switching to Monad Testnet (${monadTestnet.id})`);
      switchChain({ chainId: monadTestnet.id });
    }
  }, [authMode, walletConnected, chainId, switchChain]);

  // Debug: log wallet state
  useEffect(() => {
    console.log("Auth state:", {
      authMode,
      ready,
      authenticated,
      walletsReady,
      walletCount: wallets?.length ?? 0,
      walletConnected,
      connectorName: connector?.name,
      address,
    });
  }, [authMode, ready, authenticated, walletsReady, wallets, walletConnected, connector, address]);

  // Connect Privy wallet to wagmi when user authenticates
  useEffect(() => {
    const connectWallet = async () => {
      if ((selectedLogin === "privy" || selectedLogin === "auto") && authenticated && walletsReady && wallets?.length && setActiveWallet && !walletConnected) {
        // Find embedded wallet or use the first available wallet
        const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");
        const walletToConnect = embeddedWallet || wallets[0];
        if (walletToConnect) {
          console.log("Connecting wallet to wagmi:", walletToConnect.address);
          try {
            await setActiveWallet(walletToConnect);
          } catch (err) {
            console.error("Failed to set active wallet:", err);
          }
        }
      }
    };
    connectWallet();
  }, [authenticated, walletsReady, wallets, walletConnected, setActiveWallet, selectedLogin]);

  // Handle Privy login (email/social) - creates embedded wallet with AA
  const handlePrivyLogin = () => {
    mera.lock();
    setSelectedLogin("privy");
    if (!authenticated) {
      login?.();
    }
  };

  // Handle direct wallet connection (EOA - user pays gas)
  const handleDirectConnect = async () => {
    mera.lock();
    setSelectedLogin(null);
    try {
      await connect(
        { connector: injectedConnector },
        {
          onSuccess: () => {
            setSelectedLogin("direct");
            // After connection, switch to Monad Testnet
            switchChain({ chainId: monadTestnet.id });
          },
        }
      );
    } catch (err) {
      console.error("Failed to connect wallet:", err);
    }
  };

  // Handle disconnect for all modes
  const handleDisconnect = () => {
    mera.lock();
    if (authMode === "privy" || authMode === "relay") {
      logout?.();
    } else if (authMode === "direct") {
      disconnectWagmi();
    }
    setSelectedLogin(null);
  };

  const handlePasskey = (mode: "create" | "discover" | "unlock") => {
    setSelectedLogin("mera");
    void mera.connect(mode);
  };

  // Determine connection state
  const isLoggedIn = authMode === "mera" ? !!mera.address : authMode !== null && walletConnected;
  const passkeyDisabledReason = !MERA_ENABLED ? "Passkey voting is temporarily unavailable. Account recovery is available."
    : !mera.unlocked ? "Unlock your passkey account to vote." : relayError;
  const canVote = isLoggedIn && (authMode !== "mera" || !passkeyDisabledReason);
  const isLoading = !ready || isConnecting;

  // Get display address - use embedded wallet for Privy/relay users
  // For direct EOA connections, use the connected address
  const displayAddress = authMode === "mera" ? mera.address : (authMode === "privy" || authMode === "relay")
    ? embeddedWalletAddress
    : authMode === "direct" ? address : undefined;

  const checkVote = async () => {
    if (!displayAddress) return;
    setVoteStatus({ address: displayAddress, message: "Checking your previous vote..." });
    try {
      const message = await checkPendingVote(displayAddress as Address, AbortSignal.timeout(35000));
      setVoteStatus({ address: displayAddress, message });
    } catch (error) {
      setVoteStatus({ address: displayAddress, message: error instanceof Error ? error.message : "Could not check your vote." });
    }
  };

  // Copy address state
  const [copied, setCopied] = useState(false);

  // FPS from game screen
  const [fps, setFps] = useState(0);

  const copyAddress = useCallback(() => {
    if (displayAddress) {
      navigator.clipboard.writeText(displayAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [displayAddress]);

  return (
    <div className="app">
      <header className="header">
        <h1>Monad Plays Pokemon</h1>
        <p className="subtitle">Decentralized gaming on Monad's 400ms blocks</p>

        <div className="wallet-section">
          {isLoggedIn ? (
            <div className="wallet-info">
              <span className="auth-badge" data-mode={authMode}>
                {authMode === "mera" ? "Passkey" : authMode === "relay" ? "EIP-7702" : authMode === "privy" ? "EIP-4337" : "EOA"}
              </span>
              <span className="address" title={displayAddress || undefined}>
                {displayAddress
                  ? `${displayAddress.slice(0, 6)}...${displayAddress.slice(-4)}`
                  : "No wallet"}
              </span>
              {displayAddress && (
                <button onClick={copyAddress} className="copy-btn" title="Copy full address">
                  {copied ? "Copied!" : "Copy"}
                </button>
              )}
              {/* Toggle between EIP-7702 (relay) and EIP-4337 (privy) modes */}
              {(authMode === "privy" || authMode === "relay") && RELAY_CONFIG.enabled && (
                <button
                  onClick={() => setPreferRelay(!preferRelay)}
                  className="mode-toggle-btn"
                  title={preferRelay ? "Switch to EIP-4337 (Privy bundler)" : "Switch to EIP-7702 (Relay)"}
                >
                  {preferRelay ? "Use 4337" : "Use 7702"}
                </button>
              )}
              {authMode === "mera" && <>
                <button className="disconnect-btn" disabled={mera.busy} onClick={() => mera.unlocked ? mera.lock() : handlePasskey("unlock")}>
                  {mera.unlocked ? "Lock" : "Unlock"}
                </button>
                <button className="disconnect-btn" disabled={mera.busy} onClick={() => void mera.revealPhrase()}>Back up account</button>
                <button className="disconnect-btn" disabled={mera.busy} onClick={() => handlePasskey("discover")}>Switch passkey</button>
              </>}
              {(authMode === "mera" || authMode === "relay") && <button className="disconnect-btn" onClick={() => void checkVote()}>Check pending vote</button>}
              {(authMode === "privy" || authMode === "relay") && !walletConnected && (
                <span className="connecting"> (connecting wallet...)</span>
              )}
              <button onClick={handleDisconnect} className="disconnect-btn">
                {authMode === "privy" || authMode === "relay" ? "Logout" : "Disconnect"}
              </button>
            </div>
          ) : (
            <>
              <div className="login-options">
                {MERA_ENABLED && <button className="connect-btn" disabled={mera.busy} onClick={() => handlePasskey("create")}>Create passkey account</button>}
                <button className="connect-btn wallet-btn" disabled={mera.busy} onClick={() => handlePasskey("discover")}>Use existing passkey</button>
                {privy && <button
                  onClick={handlePrivyLogin}
                  disabled={isLoading}
                  className="connect-btn privy-btn"
                >
                  {isLoading ? "Loading..." : "Login (Gasless)"}
                </button>}
                <span className="login-divider">or</span>
                <button
                  onClick={handleDirectConnect}
                  disabled={isLoading}
                  className="connect-btn wallet-btn"
                >
                  Connect Wallet*
                </button>
              </div>
            </>
          )}
        </div>

        {selectedLogin === "mera" && <div className="passkey-status" aria-live="polite">
          {mera.busy && <p>Complete the passkey prompt on your device. <button onClick={mera.lock}>Cancel</button></p>}
          {mera.error && <p className="error">{mera.error}</p>}
          {mera.diagnostics && <details className="passkey-diagnostics">
            <summary>Passkey diagnostics</summary>
            <p>These details contain the failure stage and browser information. You can copy them when asking for help.</p>
            <pre>{mera.diagnostics}</pre>
            <a href="https://github.com/category-labs/mera/blob/main/docs/src/content/docs/authenticator-support.md" target="_blank" rel="noreferrer">Supported passkey providers</a>
          </details>}
          {!isLoggedIn && <p>A new passkey creates a separate wallet. Existing wallets keep their own addresses.</p>}
        </div>}
        {voteStatus?.address === displayAddress && <p className="passkey-status" role="status">{voteStatus?.message}</p>}
        {mera.phrase && <section className="passkey-backup" aria-label="Account recovery phrase">
          <h2>Back up your account</h2>
          <p>Keep these words private. Anyone with them can control this wallet. They hide automatically after one minute.</p>
          <p className="recovery-phrase">{mera.phrase}</p>
          <p>Import into an EVM wallet using path <code>m/44'/60'/0'/0/0</code> and an empty passphrase, then use Connect Wallet. Direct voting requires MON. This restores your wallet, not the original passkey.</p>
          <button className="disconnect-btn" onClick={mera.hidePhrase}>Hide recovery phrase</button>
        </section>}

        <div className="connection-status-bar">
          <span className={`status-dot ${indexerConnected ? "connected" : ""}`} />
          <span>{indexerConnected ? "Connected" : "Disconnected"}</span>
          {indexerConnected && <span className="fps-counter">{fps} FPS</span>}
          {viewerCount > 0 && (
            <span className="viewer-count">
              <span className="viewer-dot" />
              {viewerCount} watching
            </span>
          )}
        </div>
      </header>

      <div className="landscape-hint">
        For the best experience, rotate your device to landscape mode
      </div>

      <main className="main">
        <div className="game-row">
          <div className="game-area">
            <div className="game-with-party">
              <div className="game-column">
                <GameScreen
                  screenInfo={screenInfo}
                  setFrameCallback={setFrameCallback}
                  onFpsUpdate={setFps}
                />
                <GameStatusPanel gameState={gameState} />
              </div>
              <PartyPanel gameState={gameState} />
            </div>
          </div>

          <div className="controls-column">
            <div className="controls-chat-row">
              <div className="controls-container">
                <VoteButtons key={`${authMode}:${displayAddress}`} disabled={!canVote} disabledReason={authMode === "mera" ? passkeyDisabledReason : undefined} authMode={authMode} meraVote={mera.vote} privyVote={privy?.vote} />
              </div>

              <VoteChat
                votes={recentVotes}
                userAddress={displayAddress}
              />
            </div>

            {resultHistory.length > 0 && (() => {
              const lastResult = resultHistory[resultHistory.length - 1];
              const sortedVotes = Object.entries(lastResult.votes)
                .filter(([, count]) => count > 0)
                .sort(([, a], [, b]) => b - a);
              const winningVotes = lastResult.votes[lastResult.winningAction] || 0;
              return (
                <div className="last-winning-move">
                  <span className="last-move-label">Last action:</span>
                  <span className="last-move-action">{lastResult.winningAction}</span>
                  <span className="last-move-total">
                    ({winningVotes} / {lastResult.totalVotes} vote{lastResult.totalVotes !== 1 ? 's' : ''})
                  </span>
                  <span className="last-move-breakdown">
                    {sortedVotes.map(([action, count]) => (
                      <span
                        key={action}
                        className={`breakdown-item ${action === lastResult.winningAction ? 'winner' : ''}`}
                      >
                        {action}:{count}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      </main>

      <footer className="footer">
        <p>
          All players see the same game state (Pokemon Red) and vote on Monad Testnet for the next action.
          {" "}<strong>Every block</strong> (approx. 400ms), the most popular action is executed on the shared game. Ties are broken randomly.
        </p>
        <p className="inspiration">
          Inspired by{" "}
          <a
            href="https://en.wikipedia.org/wiki/Twitch_Plays_Pok%C3%A9mon"
            target="_blank"
            rel="noopener noreferrer"
          >
            Twitch Plays Pokémon
          </a>
        </p>
        <p className="wallet-note">*Phantom wallet is known to be buggy; MetaMask works</p>
      </footer>
    </div>
  );
}

export default App;
