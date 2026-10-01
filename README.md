# Monad Plays Pokemon

A decentralized "Twitch Plays Pokémon" proof-of-concept running on the Monad blockchain.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Monad     │◀────│   Indexer   │
│  (React +   │     │  Blockchain │     │  (Node.js)  │
│   Wallet)   │     │             │     │             │
└─────────────┘     └─────────────┘     └──────┬──────┘
      ▲                                        │
      │           Socket.io                    │
      └────────────────────────────────────────┘
```

- **Smart Contract**: Gas-minimized event emitter (no storage writes)
- **Indexer**: Listens to VoteCast events, aggregates votes per window, runs the emulator, streams game frames
- **Frontend**: Wallet connection, voting UI, displays game stream

## The game loop

Let's walk through the game loop using the EIP-7702 relay for gasless voting.

![The game loop](./assets/game-loop.png)

1. The user clicks the UP button on the D-pad. The frontend prepares a vote signature and (for first-time users) an EIP-7702 authorization to delegate their EOA to a SimpleDelegation contract.
2. The signed vote message is sent to the relay endpoint. For first-time users, the message includes an EIP-7702 authorization that delegates their EOA.
3. The relay verifies the signature and prepares to submit on behalf of the user.
4. The relay submits the transaction to Monad, paying gas on behalf of the user. For first-time users, the transaction includes an EIP-7702 authorization list.
5. The next leader includes the transaction in a block (~400 ms block time). The delegated EOA executes `vote(Action.UP)` on the MonadPlaysPokemon contract, which emits a `VoteCast(player, UP)` event.
6. The indexer receives the `VoteCast` event via its WebSocket subscription (`monadLogs`). The event includes the player's address, the action (UP), block number, and transaction hash.
7. The indexer records the vote in the current time window. When the window closes (configurable, default: 1 block), it tallies votes, determines UP as the winner, and presses UP on the emulator.
8. The indexer broadcasts the finalized vote to all clients via [Socket.io](http://socket.io/) (appears in vote feed). It also streams the updated game visuals as a JPEG over WebSocket.
9. The user sees the character walk UP.

If a user connects with an external wallet (EOA), they can choose to pay their own gas and submit transactions directly to the blockchain.

## Quick Start

Use Node 24 (`nvm use` reads `.nvmrc`). Initialize the Solidity dependency with `git submodule update --init` before building contracts.

### 1. Deploy Contract (Monad Testnet)

```bash
cd contracts

# Copy and configure .env
cp .env.example .env

# Deploy
forge script script/MonadPlaysPokemon.s.sol --rpc-url https://testnet-rpc.monad.xyz --broadcast
```

### 2. Start Indexer

```bash
cd indexer

# Copy and configure .env
cp .env.example .env
# Set CONTRACT_ADDRESS to deployed contract

npm install
npm run dev
```

### 3. Start Frontend

```bash
cd frontend

# Copy and configure .env
cp .env.example .env
# Set VITE_CONTRACT_ADDRESS to deployed contract

npm install
npm run dev
```

## Configuration

### Contract (.env)
- `PRIVATE_KEY`: Deployer wallet private key
- `MONAD_TESTNET_RPC_URL`: `https://testnet-rpc.monad.xyz`

### Indexer (.env)
- `RPC_URL`: `wss://testnet-rpc.monad.xyz` (WebSocket)
- `CONTRACT_ADDRESS`: Deployed MonadPlaysPokemon contract address
- `WINDOW_SIZE`: Blocks per voting window (default: 1)
- `PORT`: Socket.io server port (default: 3001)
- `RELAY_ENABLED`: Enable EIP-7702 gasless relay (default: false)
- `RELAY_PRIVATE_KEY`: Private key for relay wallet (pays gas)
- `DELEGATION_CONTRACT`: Deployed SimpleDelegation contract address

### Frontend (.env)
- `VITE_CONTRACT_ADDRESS`: Deployed contract address
- `VITE_RPC_URL`: `https://testnet-rpc.monad.xyz`
- `VITE_INDEXER_URL`: Indexer WebSocket URL (default: `http://localhost:3001`)
- `VITE_PRIVY_APP_ID`: Optional Privy App ID for embedded wallets. Mera and injected wallets work without it.
- `VITE_RELAY_ENABLED`: Enable EIP-7702 gasless relay (default: false)
- `VITE_DELEGATION_CONTRACT`: Deployed SimpleDelegation contract address
- `VITE_RELAY_API_URL`: Relay API URL (default: `http://localhost:3001`)

## Passkey accounts with Mera

Mera adds passkey accounts alongside Privy and injected wallets. Create a passkey account or choose an existing passkey, unlock it once, then vote through the gas sponsor. The account locks on page exit, account changes, or 15 minutes of inactivity. The passkey provider must support WebAuthn PRF.

Mera is enabled by default. To configure it:

1. Set `VITE_MERA_RP_ID` to the exact stable frontend hostname, and optionally `VITE_MERA_RP_NAME`. Remove any existing `VITE_MERA_ENABLED=false` override or set it to `true`. Use HTTPS in production or `localhost` locally. A changed hostname cannot unlock the old hostname's passkeys.
2. Configure both `VITE_RELAY_ENABLED=true` and backend `RELAY_ENABLED=true`. Frontend and backend must use the same vote contract, delegation contract, and Monad Testnet network. Set a valid `VITE_PRIVY_APP_ID` to also offer Privy login; Mera and injected wallets work without it.
3. Fund the backend relay wallet and configure its spending limits in `indexer/.env`. Set `SAVE_DIR` to a persistent Railway volume. The relay writes `relay.json` there before broadcasting and uses `relay.lock` for exclusive ownership. Run one relay writer per sponsor wallet, including during deployment handover.
4. Build and deploy both applications together. Older relay clients are asked to refresh. New relay requests include their execution nonce and deterministic request ID.

`Back up account` runs a fresh passkey verification before showing a recovery phrase. The words hide after one minute or when the account locks. To recover without the original passkey, import the phrase into an EVM wallet using path `m/44'/60'/0'/0/0` and an empty passphrase. Check the restored address, then use Connect Wallet. Direct voting requires MON. A newly created passkey produces a separate address.

The app retains public pending-vote references across reloads and account switches. `Check pending vote` remains available while an account is locked or passkey voting is disabled. The relay keeps signed submissions and gas reservations in its journal until they are reconciled. Do not delete the journal or force-remove its lock to recover a pending transaction. A lost HTTP response does not establish whether a vote executed.

The sponsor accepts fresh accounts or accounts already delegated to the configured implementation. Other delegated accounts, and accounts with cleared code but previous transactions, need external-wallet recovery. RPC lookup failures never prompt a new delegation. Expired pending votes are cancelled at the sponsor nonce when the fee cap allows; otherwise they remain pending for operator review. The sponsor wallet must be dedicated to this relay.

`VITE_MERA_ENABLED=false` disables enrollment and passkey voting in the rebuilt frontend while retaining unlock and export. To stop gas spending, disable `RELAY_ENABLED` on the server. Keep the RPC, contract settings, and persistent volume configured so status lookup can continue. A frontend flag does not block direct HTTP submissions.

Review the RPC endpoints, proxy allowlist, sponsor allowance, and scripts served on the account origin before public enablement. Mera's signing key is held in page memory while unlocked; all scripts on that page share the application's trust boundary. Buffers are cleared when no longer needed, but JavaScript cannot guarantee complete memory erasure.

### Validation

Run `npm test` in `frontend` for derivation, session lifecycle, and relay-client failure checks. `npm run test:integration` uses Foundry and Anvil to deploy the existing contracts and exercise sponsored EIP-7702 votes, concurrency, persistent recovery, and failed execution. Both tools must be on `PATH`. The integration suite uses a disposable local chain and public fixture keys.

Run `npm run build` in each application, `npm run lint` in `frontend`, and `forge test` in `contracts`. Local tests cannot establish a real authenticator's compatibility or the live Monad deployment's behavior. Before enabling enrollment, verify creation and recovery with the intended desktop/mobile providers and run a sponsored vote on the deployed testnet contracts.

## Network Details

| Property | Value |
|----------|-------|
| RPC URL (HTTP) | `https://testnet-rpc.monad.xyz` |
| RPC URL (WebSocket) | `wss://testnet-rpc.monad.xyz` |
| Block Explorer | `https://testnet.monadvision.com` |

## Game Input Actions

| Action | Description |
|--------|-------------|
| UP     | D-Pad Up    |
| DOWN   | D-Pad Down  |
| LEFT   | D-Pad Left  |
| RIGHT  | D-Pad Right |
| A      | A Button    |
| B      | B Button    |
| START  | Start       |
| SELECT | Select      |

## POC Limitations

- Single indexer instance runs the authoritative emulator (anyone can run their own indexer with a separate game state)
- Window timing based on block numbers

## Tech Stack

- **Contracts**: Solidity, Foundry
- **Indexer**: Node.js, TypeScript, ethers.js, Socket.io
- **Frontend**: React, TypeScript, Vite, ethers.js
