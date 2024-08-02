import "@nomiclabs/hardhat-ethers";
import { Wallet } from "ethers";
import * as hre from "hardhat";
import { HardhatAccount } from "../../src/HardhatAccount";
import { Ledger } from "../../typechain-types";

async function getLedgerContract(): Promise<Ledger> {
    const factory = await hre.ethers.getContractFactory("Ledger");
    return factory.attach("0xb72784db105f0E588300827D72359B371bd557df").connect(hre.ethers.provider) as Ledger;
}

async function main() {
    const raws = HardhatAccount.keys.map((m) => new Wallet(m, hre.ethers.provider));
    const [deployer] = raws;
    const contract = await getLedgerContract();
    const provider = new Wallet("0x70438bc3ed02b5e4b76d496625cb7c06d6b7bf4362295b16fdfe91a046d4586c"); // 0x64D111eA9763c93a003cef491941A011B8df5a49
    await contract.connect(deployer).registerProvider(provider.address);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
