import { Buffer } from "buffer";
// Polyfill Buffer for browser compatibility
(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets";
import { WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig, monadTestnet, PRIVY_APP_ID, PRIVY_ENABLED } from "./config/wagmi";
import { usePrivyWallet } from "./hooks/usePrivyWallet";
import "./index.css";
import App from "./App.tsx";

const queryClient = new QueryClient();

function PrivyApp() {
  const privy = usePrivyWallet();
  return <App privy={privy} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {PRIVY_ENABLED ? <PrivyProvider
      appId={PRIVY_APP_ID!}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#7C3AED",
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
        loginMethods: ["email", "google", "twitter", "discord"],
      }}
    >
      <SmartWalletsProvider>
        <QueryClientProvider client={queryClient}>
          <PrivyWagmiProvider config={wagmiConfig}>
            <PrivyApp />
          </PrivyWagmiProvider>
        </QueryClientProvider>
      </SmartWalletsProvider>
    </PrivyProvider> : (
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <App />
        </WagmiProvider>
      </QueryClientProvider>
    )}
  </StrictMode>
);
