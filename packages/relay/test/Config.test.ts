import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-waffle";

import { Config } from "../src/common/Config";
import { ContractUtils } from "../src/utils/ContractUtils";

import * as assert from "assert";
import path from "path";

describe("Test of Config", () => {
    it("Test parsing the settings of a string", async () => {
        const config: Config = new Config();
        config.readFromFile(path.resolve("test", "config.test.yaml"));
        assert.strictEqual(config.server.address, "127.0.0.1");
        assert.strictEqual(config.server.port.toString(), "3000");
        assert.strictEqual(config.logging.level, "debug");
        assert.deepStrictEqual(config.relay.certifiers, [
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        ]);
        assert.strictEqual(config.contracts.sideChain.tokenAddress, "0x898Bf21a9e1fF51d3F1248E0A253f6A58C3a736a");
        assert.strictEqual(config.contracts.sideChain.ledgerAddress, "0xc573eF6FDcaf1461FF2BB75a70B7685ad395AA2d");
        assert.strictEqual(config.contracts.sideChain.phoneLinkerAddress, "0x8CA2D0080a42DB61cbe59611551412D294FC5911");
    });

    it("getTemporaryAccount", async () => {
        const address = ContractUtils.getTemporaryAccount();
        console.log(address);
        console.log(ContractUtils.isTemporaryAccount(address));
    });
});
