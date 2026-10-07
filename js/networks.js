// Networks this page knows. The genesis hash is how the page checks that an
// RPC endpoint really serves the chain the user selected (getBlockHash(0)).
// The testnet is reset from time to time: a mismatch there is reported as a
// warning, never hidden.

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    id: "mainnet",
    hrp: "j",
    rpc: "https://rpc.jetsamchain.com",
    genesis: "6e592c07be6fd1b4259eeacbf4eb7eb2948a77f1d02626a12fdab42c448c5f44",
  }),
  testnet: Object.freeze({
    id: "testnet",
    hrp: "tj",
    rpc: "https://rpc-testnet.jetsamchain.com",
    genesis: "d9d156ee35e725cf6b133216809c1b0f165d1120c9cf42cc2bfeb0ef9031ee85",
  }),
});
