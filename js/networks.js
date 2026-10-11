// Networks this page knows. The genesis hash is how the page checks that an
// RPC endpoint really serves the chain the user selected (getBlockHash(0)).
// The testnet is reset from time to time: a mismatch there is reported as a
// warning, never hidden.
//
// `rpc` is the default endpoint: reads and sending. `reference` is the
// network's public read-only RPC, asked about the fate of a payment (txids
// only) when the endpoint in use is another one (SEC3-01).
//
// wallet-rpc.jetsamchain.com is the wallet RPC (submitTxIntent open). It
// serves the testnet today. Mainnet switch, once that host serves the
// mainnet: set mainnet's `rpc` to "https://wallet-rpc.jetsamchain.com" (that
// line only; the CSP already allows it, and `reference` stays the public RPC).

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    id: "mainnet",
    hrp: "j",
    rpc: "https://rpc.jetsamchain.com",
    reference: "https://rpc.jetsamchain.com",
    genesis: "6e592c07be6fd1b4259eeacbf4eb7eb2948a77f1d02626a12fdab42c448c5f44",
  }),
  testnet: Object.freeze({
    id: "testnet",
    hrp: "tj",
    rpc: "https://wallet-rpc.jetsamchain.com",
    reference: "https://rpc-testnet.jetsamchain.com",
    genesis: "d9d156ee35e725cf6b133216809c1b0f165d1120c9cf42cc2bfeb0ef9031ee85",
  }),
});
