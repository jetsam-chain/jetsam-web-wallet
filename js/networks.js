// The network this page knows: the Jetsam mainnet. The genesis hash is how
// the page checks that an RPC endpoint really serves it (getBlockHash(0)).
//
// `rpc` is the default endpoint: reads and sending. `reference` is the
// network's public read-only RPC, asked about the fate of a payment (txids
// only) when the endpoint in use is another one (SEC3-01).
//
// wallet-rpc.jetsamchain.com is the wallet RPC (submitTxIntent open); it
// serves the mainnet. rpc.jetsamchain.com is the public explorer proxy.

export const NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    id: "mainnet",
    hrp: "j",
    rpc: "https://wallet-rpc.jetsamchain.com",
    reference: "https://rpc.jetsamchain.com",
    genesis: "6e592c07be6fd1b4259eeacbf4eb7eb2948a77f1d02626a12fdab42c448c5f44",
  }),
});

/**
 * The second source asked about a payment's fate (SEC3-01) when `rpcUrl`
 * (normalized by checkRpcUrl) is the endpoint in use: the network's public
 * RPC, or null when that is the endpoint itself (it would ask itself).
 */
export function secondSource(network, rpcUrl) {
  const reference = NETWORKS[network].reference;
  return rpcUrl === reference ? null : reference;
}
