// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMeraWallet } from "../src/hooks/useMeraWallet";
import { IDLE_TIMEOUT, exportMeraPhrase, openMeraAccount, rememberMeraIdentity } from "../src/utils/mera";

vi.mock("../src/config/wagmi", () => ({ monadTestnet: { id: 10143 }, RELAY_CONFIG: { delegationContract: "0x1111111111111111111111111111111111111111" } }));
vi.mock("../src/utils/relay", () => ({ submitRelayVote: vi.fn() }));
vi.mock("../src/utils/mera", () => ({
  IDLE_TIMEOUT: 900000, MERA_ENABLED: true, openMeraAccount: vi.fn(), loadMeraIdentity: vi.fn(),
  rememberMeraIdentity: vi.fn(), exportMeraPhrase: vi.fn(), meraError: (error: Error) => error.message,
}));

const opened = () => ({
  identity: { version: 1 as const, address: "0x1111111111111111111111111111111111111111" as const, rpId: "localhost", credential: { credentialId: "example" } },
  account: { address: "0x1111111111111111111111111111111111111111" }, end: vi.fn(),
}) as unknown as Awaited<ReturnType<typeof openMeraAccount>>;

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("discards a ceremony that completes after locking", async () => {
  let finish!: (value: Awaited<ReturnType<typeof openMeraAccount>>) => void;
  vi.mocked(openMeraAccount).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useMeraWallet, { wrapper: StrictMode });
  let connecting!: Promise<void>;
  act(() => { connecting = result.current.connect("discover"); });
  act(() => result.current.lock());
  const account = opened();
  await act(async () => { finish(account); await connecting; });
  expect(account.end).toHaveBeenCalledOnce();
  expect(rememberMeraIdentity).not.toHaveBeenCalled();
  expect(result.current.unlocked).toBe(false);
});

it("locks an idle session and ends its signer on unmount", async () => {
  const first = opened();
  vi.mocked(openMeraAccount).mockResolvedValue(first);
  const { result, unmount } = renderHook(useMeraWallet, { wrapper: StrictMode });
  expect(openMeraAccount).not.toHaveBeenCalled();
  await act(() => result.current.connect("discover"));
  expect(result.current.unlocked).toBe(true);
  act(() => vi.advanceTimersByTime(IDLE_TIMEOUT));
  expect(result.current.unlocked).toBe(false);
  expect(first.end).toHaveBeenCalledOnce();
  const second = opened();
  vi.mocked(openMeraAccount).mockResolvedValue(second);
  await act(() => result.current.connect("unlock"));
  unmount();
  expect(second.end).toHaveBeenCalledOnce();
});

it("clears an exported phrase after one minute even when the account is locked", async () => {
  vi.mocked(openMeraAccount).mockResolvedValue(opened());
  vi.mocked(exportMeraPhrase).mockResolvedValue("fixture recovery phrase");
  const { result } = renderHook(useMeraWallet);
  await act(() => result.current.connect("discover"));
  act(() => result.current.lock());
  await act(() => result.current.revealPhrase());
  expect(result.current.phrase).toBe("fixture recovery phrase");
  expect(exportMeraPhrase).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(60000));
  expect(result.current.phrase).toBeUndefined();
  expect(result.current.unlocked).toBe(false);
});
