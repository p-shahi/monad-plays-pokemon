// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VoteButtons } from "../src/components/VoteButtons";
import { submitRelayVote } from "../src/utils/relay";

const fixtures = vi.hoisted(() => ({
  owner: "0x1111111111111111111111111111111111111111",
  delegate: "0x2222222222222222222222222222222222222222",
  hash: `0x${"ab".repeat(32)}` as `0x${string}`,
  request: vi.fn(async () => `0x${"11".repeat(65)}`),
  signAuthorization: vi.fn(async () => ({ chainId: 10143, nonce: 0, r: "0x11", s: "0x22", yParity: 0 })),
}));
vi.mock("@privy-io/react-auth", () => ({
  useWallets: () => ({ wallets: [{ address: fixtures.owner, walletClientType: "privy", getEthereumProvider: async () => ({ request: fixtures.request }) }] }),
  useSign7702Authorization: () => ({ signAuthorization: fixtures.signAuthorization }),
}));
vi.mock("@privy-io/react-auth/smart-wallets", () => ({ useSmartWallets: () => ({}) }));
vi.mock("wagmi", () => ({ useWriteContract: () => ({ isPending: false }) }));
vi.mock("../src/config/wagmi", () => ({
  Action: { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 },
  CONTRACT_ADDRESS: fixtures.delegate, CONTRACT_ABI: [],
  RELAY_CONFIG: { delegationContract: fixtures.delegate }, monadTestnet: { id: 10143 },
}));
vi.mock("../src/utils/relay", () => ({ submitRelayVote: vi.fn() }));
afterEach(cleanup);

it("uses Privy's raw personal_sign payload and authorization hook for relay voting", async () => {
  vi.mocked(submitRelayVote).mockImplementation(async signer => {
    signer.assertActive();
    await signer.signMessage(fixtures.hash);
    await signer.signAuthorization(0);
  });
  render(<VoteButtons authMode="relay" meraVote={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "A" }));
  await waitFor(() => expect(fixtures.signAuthorization).toHaveBeenCalledOnce());
  expect(fixtures.request).toHaveBeenCalledWith({ method: "personal_sign", params: [fixtures.hash, fixtures.owner] });
  expect(fixtures.signAuthorization).toHaveBeenCalledWith(
    { contractAddress: fixtures.delegate, chainId: 10143, nonce: 0 }, { address: fixtures.owner },
  );
});
