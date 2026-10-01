import { useCallback, useEffect, useRef, useState } from "react";
import { type Hex } from "viem";
import { monadTestnet, RELAY_CONFIG, type ActionType } from "../config/wagmi";
import { IDLE_TIMEOUT, MERA_ENABLED, exportMeraPhrase, loadMeraIdentity, meraDiagnostics, meraError, openMeraAccount, rememberMeraIdentity } from "../utils/mera";
import { submitRelayVote } from "../utils/relay";

export function useMeraWallet() {
  const [identity, setIdentity] = useState(loadMeraIdentity);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<string>();
  const [phrase, setPhrase] = useState<string>();
  const wallet = useRef<Awaited<ReturnType<typeof openMeraAccount>>>(undefined);
  const generation = useRef(0);
  const ceremony = useRef(false);
  const lastActivity = useRef(Date.now());

  const lock = useCallback(() => {
    generation.current++;
    wallet.current?.end();
    wallet.current = undefined;
    setUnlocked(false);
    setPhrase(undefined);
  }, []);

  useEffect(() => {
    const activity = () => {
      if (Date.now() - lastActivity.current >= IDLE_TIMEOUT) lock();
      lastActivity.current = Date.now();
    };
    const expiry = setInterval(() => {
      if (Date.now() - lastActivity.current >= IDLE_TIMEOUT && wallet.current) lock();
    }, 1000);
    document.addEventListener("pointerdown", activity);
    document.addEventListener("keydown", activity);
    window.addEventListener("pagehide", lock);
    return () => {
      clearInterval(expiry);
      document.removeEventListener("pointerdown", activity);
      document.removeEventListener("keydown", activity);
      window.removeEventListener("pagehide", lock);
      lock();
    };
  }, [lock]);

  useEffect(() => {
    if (!phrase) return;
    const timeout = setTimeout(() => setPhrase(undefined), 60000);
    return () => clearTimeout(timeout);
  }, [phrase]);

  const connect = async (mode: "create" | "discover" | "unlock") => {
    if (ceremony.current) return;
    ceremony.current = true;
    lock();
    const current = generation.current;
    setBusy(true);
    setError(undefined);
    setDiagnostics(undefined);
    try {
      const opened = await openMeraAccount(mode, identity);
      if (generation.current !== current) { opened.end(); return; }
      try { rememberMeraIdentity(opened.identity); }
      catch (cause) { opened.end(); throw cause; }
      wallet.current = opened;
      lastActivity.current = Date.now();
      setIdentity(opened.identity);
      setUnlocked(true);
    } catch (cause) {
      if (generation.current === current) {
        setError(meraError(cause));
        setDiagnostics(meraDiagnostics(cause, mode));
      }
    } finally {
      ceremony.current = false;
      setBusy(false);
    }
  };

  const revealPhrase = async () => {
    if (!identity || ceremony.current) return;
    ceremony.current = true;
    const current = generation.current;
    setBusy(true);
    setError(undefined);
    setDiagnostics(undefined);
    try {
      const exported = await exportMeraPhrase(identity);
      if (generation.current === current) setPhrase(exported);
    } catch (cause) {
      if (generation.current === current) {
        setError(meraError(cause));
        setDiagnostics(meraDiagnostics(cause, "export recovery phrase"));
      }
    } finally { ceremony.current = false; setBusy(false); }
  };

  const vote = async (action: ActionType, signal: AbortSignal, onSubmitted: () => void) => {
    const current = wallet.current;
    const version = generation.current;
    const assertActive = () => {
      if (!MERA_ENABLED) throw new Error("Passkey voting is temporarily unavailable.");
      if (!current || wallet.current !== current || generation.current !== version || Date.now() - lastActivity.current >= IDLE_TIMEOUT) {
        throw new Error("Unlock your passkey account to vote.");
      }
    };
    assertActive();
    await submitRelayVote({
      address: current!.account.address,
      assertActive,
      signMessage: hash => { assertActive(); return current!.account.signMessage({ message: { raw: hash } }); },
      signAuthorization: async nonce => {
        assertActive();
        const auth = await current!.account.signAuthorization!({ contractAddress: RELAY_CONFIG.delegationContract as Hex, chainId: monadTestnet.id, nonce });
        return { chainId: auth.chainId, nonce: auth.nonce, r: auth.r, s: auth.s, yParity: auth.yParity! };
      },
    }, action, signal, onSubmitted);
  };

  return { address: identity?.address, unlocked, busy, error, diagnostics, phrase, connect, lock, revealPhrase, hidePhrase: () => setPhrase(undefined), vote };
}
