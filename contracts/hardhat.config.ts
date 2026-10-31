import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        // Offline-friendly: use the solc build from npm instead of downloading one.
        path: new URL("./node_modules/solc/soljson.js", import.meta.url).pathname,
        settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
      },
    },
    // Compile Safe 1.4.1 so the Solidity tests can run real Safes.
    npmFilesToBuild: [
      "@safe-global/safe-contracts/contracts/Safe.sol",
      "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol",
    ],
  },
  networks: {
    chiado: {
      type: "http",
      chainType: "l1",
      chainId: 10200,
      url: configVariable("CHIADO_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    gnosis: {
      type: "http",
      chainType: "l1",
      chainId: 100,
      url: configVariable("GNOSIS_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
