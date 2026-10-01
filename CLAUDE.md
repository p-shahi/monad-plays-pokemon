# Monad Plays Pokemon

This proof of concept collects on-chain votes on Monad Testnet. The indexer runs one authoritative Pokemon Red emulator, aggregates votes into block windows, and streams frames to viewers.

## Components

- `contracts/src/MonadPlaysPokemon.sol` emits `VoteCast(msg.sender, action)`.
- `contracts/src/SimpleDelegation.sol` verifies signed EIP-7702 executions. Its nonce lives in the delegated EOA's storage.
- `indexer/src/index.ts` runs vote ingestion, aggregation, emulator state, HTTP, Socket.io, and frame streaming.
- `indexer/src/relay.ts` validates and sponsors signed votes. `relayStore.ts` journals signed transactions and spending reservations under `SAVE_DIR` before broadcast.
- `frontend/src/App.tsx` selects the active identity: Privy, injected wallet, or Mera passkey account.
- `frontend/src/utils/mera.ts` fixes account derivation. `hooks/useMeraWallet.ts` owns the signing session. `utils/relay.ts` is shared by Mera and Privy relay voting.

## Working conventions

Use Node 24. Frontend and indexer have separate npm dependencies and builds. Initialize the OpenZeppelin submodule before building contracts.

Mera uses the default PRF salt and BIP-39/BIP-32 path `m/44'/60'/0'/0/0` with an empty passphrase. Treat these and the production RP ID as persistent account configuration. Never store or log passkey output, seeds, private keys, or recovery phrases.

A submitted transaction hash is not a completed vote. Reconcile the receipt and matching event. Preserve pending request identity across reload, logout, and server restart. Keep one relay writer per sponsor and persistent journal; never reset the journal to clear a nonce error.

The implementation plan is in `docs/mera-integration-plan.md`. Deployment settings and recovery instructions are in `README.md` and the application `.env.example` files.

## Checks

- Frontend: `npm test`, `npm run build`, `npm run lint`.
- Relay integration: `npm run test:integration` in `frontend`, with Forge and Anvil installed.
- Indexer: `npm run build`.
- Contracts: `forge test`.

Use real passkeys and the intended deployment for browser/provider and Monad Testnet smoke checks. Local signing and Anvil tests cover their own boundaries.
