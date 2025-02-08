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

interface BlockRange {
  fromBlock: number;
  toBlock: number;
}

class ContractMonitor {
  private provider: ethers.JsonRpcProvider;
  private contractAddress: string;
  private transactionCache: Map<string, WalletData>;

  constructor(contractAddress: string, rpcUrl: string) {
    this.contractAddress = contractAddress;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.transactionCache = new Map();
  }

  private async waitForNetwork(retries: number = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.provider.getNetwork();
        console.log("Successfully connected to network");
        return;
      } catch (error) {
        if (i === retries - 1) throw error;
        console.log(`Waiting for network, attempt ${i + 1}/${retries}...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  private async processBlockRange(range: BlockRange, retryCount: number = 0): Promise<void> {
    try {
      const filter = {
        address: this.contractAddress,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      };

      const events = await this.provider.getLogs(filter);
      
      for (const event of events) {
        const tx = await this.provider.getTransaction(event.transactionHash);
        if (tx && tx.from) {
          this.updateWalletCount(tx.from);
        }
      }

      return;
    } catch (error) {
      if (retryCount >= 2) {
        throw error;
      }
      console.log(`Retrying blocks ${range.fromBlock}-${range.toBlock}, attempt ${retryCount + 1}/3`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return this.processBlockRange(range, retryCount + 1);
    }
  }

  async getLastHourTransactions(): Promise<void> {
    try {
      await this.waitForNetwork();

      const latestBlock = await this.provider.getBlockNumber();
      const blocksPerHour = 120; // Approximate blocks per hour for Arbitrum
      const fromBlock = latestBlock - blocksPerHour;

      console.log(`Fetching transactions from block ${fromBlock} to ${latestBlock}`);

      // Split the range into smaller chunks
      const chunkSize = 20;
      const ranges: BlockRange[] = [];
      
      for (let i = fromBlock; i < latestBlock; i += chunkSize) {
        ranges.push({
          fromBlock: i,
          toBlock: Math.min(i + chunkSize - 1, latestBlock)
        });
      }

      // Process each range
      for (const range of ranges) {
        try {
          await this.processBlockRange(range);
        } catch (error) {
          console.error(`Failed to process blocks ${range.fromBlock}-${range.toBlock} after 3 attempts:`, error);
        }
      }

      this.displayTopWallets();

    } catch (error) {
      console.error("Error fetching last hour transactions:", error);
      throw error;
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
    console.log("\nTop 5 Wallets by Transaction Count (Last Hour):");
    console.log("=============================================");
    if (topWallets.length === 0) {
      console.log("No transactions found in the last hour.");
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
    console.log("Initializing contract monitor...");
    const monitor = new ContractMonitor(
      process.env.CONTRACT_ADDRESS!,
      process.env.RPC_URL!
    );
    return { monitor };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

async function main() {
  if (!process.env.CONTRACT_ADDRESS || !process.env.RPC_URL) {
    console.error("Error: CONTRACT_ADDRESS and RPC_URL must be set in .env file");
    process.exit(1);
  }

  try {
    const { monitor } = await initializeAgent();
    
    console.log("Fetching last hour's transaction data...");
    await monitor.getLastHourTransactions();
    
    // Exit after displaying the data
    process.exit(0);
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  console.log("Starting Transaction Monitor for Last Hour...");
  main().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}