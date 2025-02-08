import {
  AgentKit,
  CdpWalletProvider,
  wethActionProvider,
  walletActionProvider,
  erc20ActionProvider,
  cdpApiActionProvider,
  cdpWalletActionProvider,
  pythActionProvider,
} from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { ethers } from 'ethers';
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

interface WalletData {
  address: string;
  transactionCount: number;
  lastUpdated: string;
}

class ContractMonitor {
  private provider: ethers.JsonRpcProvider;
  private contractAddress: string;
  private transactionCache: Map<string, WalletData>;
  private readonly dataFile = "transaction_data.json";

  constructor(contractAddress: string, rpcUrl: string) {
    this.contractAddress = contractAddress;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.transactionCache = new Map();
    this.loadTransactionData();
  }

  private loadTransactionData(): void {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
        this.transactionCache = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error("Error loading transaction data:", error);
    }
  }

  private saveTransactionData(): void {
    try {
      const data = Object.fromEntries(this.transactionCache);
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Error saving transaction data:", error);
    }
  }

  async updateTransactionCounts(): Promise<void> {
    try {
      // Get the latest block number
      const latestBlock = await this.provider.getBlockNumber();
      const fromBlock = latestBlock - 1000; // Look back 1000 blocks

      // Get all transactions to/from the contract
      const filter = {
        address: this.contractAddress,
        fromBlock,
        toBlock: latestBlock,
      };

      const events = await this.provider.getLogs(filter);

      for (const event of events) {
        const tx = await this.provider.getTransaction(event.transactionHash);
        if (tx && tx.from) {
          this.updateWalletCount(tx.from);
        }
      }

      this.saveTransactionData();
    } catch (error) {
      console.error("Error updating transaction counts:", error);
    }
  }

  private updateWalletCount(address: string): void {
    const existing = this.transactionCache.get(address) || {
      address,
      transactionCount: 0,
      lastUpdated: new Date().toISOString()
    };

    existing.transactionCount++;
    existing.lastUpdated = new Date().toISOString();
    this.transactionCache.set(address, existing);
  }

  getTopWallets(limit: number = 5): WalletData[] {
    return Array.from(this.transactionCache.values())
      .sort((a, b) => b.transactionCount - a.transactionCount)
      .slice(0, limit);
  }

  displayTopWallets(): void {
    const topWallets = this.getTopWallets();
    console.log("\nTop 5 Wallets by Transaction Count:");
    console.log("==================================");
    if (topWallets.length === 0) {
      console.log("No transactions recorded yet.");
    } else {
      topWallets.forEach((wallet, index) => {
        console.log(`${index + 1}. Address: ${wallet.address}`);
        console.log(`   Transactions: ${wallet.transactionCount}`);
        console.log(`   Last Updated: ${wallet.lastUpdated}`);
        console.log("----------------------------------");
      });
    }
  }
}

async function initializeAgent() {
  try {
    const llm = new ChatOpenAI({
      apiKey: "gaia",
      model: "llam70b",
      configuration: {
        baseURL: "https://llama70b.gaia.domains/v1",
      },
    });

    const config = {
      apiKeyName: process.env.CDP_API_KEY_NAME,
      apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      networkId: "arbitrum-sepolia",
    };

    const walletProvider = await CdpWalletProvider.configureWithWallet(config);
    const monitor = new ContractMonitor(
      process.env.CONTRACT_ADDRESS!,
      process.env.RPC_URL!
    );

    const agentkit = await AgentKit.from({
      walletProvider,
      actionProviders: [
        wethActionProvider(),
        pythActionProvider(),
        walletActionProvider(),
        erc20ActionProvider(),
        cdpApiActionProvider({
          apiKeyName: process.env.CDP_API_KEY_NAME,
          apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
        cdpWalletActionProvider({
          apiKeyName: process.env.CDP_API_KEY_NAME,
          apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
      ],
    });

    return { monitor, agentkit };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

async function runMonitoring(monitor: ContractMonitor, interval = 30) {
  console.log("Starting contract monitoring...");
  
  while (true) {
    try {
      await monitor.updateTransactionCounts();
      monitor.displayTopWallets();
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    } catch (error) {
      console.error("Error in monitoring loop:", error);
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
    }
  }
}

async function main() {
  if (!process.env.CONTRACT_ADDRESS || !process.env.RPC_URL) {
    console.error("Error: CONTRACT_ADDRESS and RPC_URL must be set in .env file");
    process.exit(1);
  }

  try {
    console.log("Initializing contract monitor...");
    const { monitor } = await initializeAgent();
    await runMonitoring(monitor);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  console.log("Starting Transaction Monitor...");
  main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}