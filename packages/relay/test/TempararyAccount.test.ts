import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-waffle";

import { Amount } from "../src/common/Amount";
import { Config } from "../src/common/Config";
import { ContractManager } from "../src/contract/ContractManager";
import { Scheduler } from "../src/scheduler/Scheduler";
import { WatchScheduler } from "../src/scheduler/WatchScheduler";
import { GraphStorage } from "../src/storage/GraphStorage";
import { RelayStorage } from "../src/storage/RelayStorage";
import { LoyaltyPaymentTaskStatus } from "../src/types";
import { ContractUtils, LoyaltyNetworkID } from "../src/utils/ContractUtils";
import { Ledger, LoyaltyProvider } from "../typechain-types";
import { Deployments } from "./helper/Deployments";
import { FakerCallbackServer } from "./helper/FakerCallbackServer";
import { getPurchaseId, TestClient, TestServer } from "./helper/Utility";

import chai, { expect } from "chai";
import { solidity } from "ethereum-waffle";

import * as path from "path";
import URI from "urijs";
import { URL } from "url";

import * as assert from "assert";

import { AddressZero } from "@ethersproject/constants";
import { Wallet } from "@ethersproject/wallet";

chai.use(solidity);

describe("Test of Server", function () {
    this.timeout(1000 * 60 * 5);

    const config = new Config();
    config.readFromFile(path.resolve(process.cwd(), "config", "config_test.yaml"));
    const contractManager = new ContractManager(config);
    const deployments = new Deployments(config);

    const users = deployments.accounts.users;
    const shops = deployments.accounts.shops;

    let providerContract: LoyaltyProvider;
    let ledgerContract: Ledger;

    const expression = "*/1 * * * * *";

    let client: TestClient;
    let storage: RelayStorage;
    let server: TestServer;
    let serverURL: URL;

    let temporaryAccount: string;

    let fakerCallbackServer: FakerCallbackServer;

    interface IShopData {
        shopId: string;
        name: string;
        currency: string;
        wallet: Wallet;
    }

    const shopData: IShopData[] = [
        {
            shopId: "F000100",
            name: "Shop1",
            currency: "krw",
            wallet: shops[0],
        },
        {
            shopId: "F000200",
            name: "Shop2",
            currency: "krw",
            wallet: shops[1],
        },
        {
            shopId: "F000300",
            name: "Shop3",
            currency: "krw",
            wallet: shops[2],
        },
        {
            shopId: "F000400",
            name: "Shop4",
            currency: "krw",
            wallet: shops[3],
        },
        {
            shopId: "F000500",
            name: "Shop5",
            currency: "krw",
            wallet: shops[4],
        },
    ];

    interface IUserData {
        phone: string;
        wallet: Wallet;
        address: string;
        privateKey: string;
    }

    const userData: IUserData[] = [
        {
            phone: "08201012341001",
            wallet: users[0],
            address: users[0].address,
            privateKey: users[0].privateKey,
        },
        {
            phone: "08201012341002",
            wallet: users[1],
            address: users[1].address,
            privateKey: users[1].privateKey,
        },
        {
            phone: "08201012341003",
            wallet: users[2],
            address: users[2].address,
            privateKey: users[2].privateKey,
        },
    ];

    interface IPurchaseData {
        purchaseId: string;
        amount: number;
        providePercent: number;
        currency: string;
        userIndex: number;
        shopIndex: number;
    }

    context("Test point relay endpoints", () => {
        before("Set Shop ID", async () => {
            for (const elem of shopData) {
                elem.shopId = ContractUtils.getShopId(elem.wallet.address, LoyaltyNetworkID.ACC_TESTNET);
            }
        });

        before("Deploy", async () => {
            deployments.setShopData(shopData);
            await deployments.doDeploy();

            ledgerContract = deployments.getContract("Ledger") as Ledger;
            providerContract = deployments.getContract("LoyaltyProvider") as LoyaltyProvider;
        });

        before("Create Config", async () => {
            config.contracts.sideChain.tokenAddress = deployments.getContractAddress("TestLYT") || "";
            config.contracts.sideChain.currencyRateAddress = deployments.getContractAddress("CurrencyRate") || "";
            config.contracts.sideChain.phoneLinkerAddress = deployments.getContractAddress("PhoneLinkCollection") || "";
            config.contracts.sideChain.ledgerAddress = deployments.getContractAddress("Ledger") || "";
            config.contracts.sideChain.shopAddress = deployments.getContractAddress("Shop") || "";
            config.contracts.sideChain.loyaltyProviderAddress = deployments.getContractAddress("LoyaltyProvider") || "";
            config.contracts.sideChain.loyaltyConsumerAddress = deployments.getContractAddress("LoyaltyConsumer") || "";
            config.contracts.sideChain.loyaltyExchangerAddress =
                deployments.getContractAddress("LoyaltyExchanger") || "";
            config.contracts.sideChain.loyaltyTransferAddress = deployments.getContractAddress("LoyaltyTransfer") || "";
            config.contracts.sideChain.loyaltyBridgeAddress = deployments.getContractAddress("LoyaltyBridge") || "";
            config.contracts.sideChain.chainBridgeAddress = deployments.getContractAddress("SideChainBridge") || "";

            config.contracts.mainChain.tokenAddress = deployments.getContractAddress("MainChainKIOS") || "";
            config.contracts.mainChain.loyaltyBridgeAddress =
                deployments.getContractAddress("MainChainLoyaltyBridge") || "";
            config.contracts.mainChain.chainBridgeAddress = deployments.getContractAddress("MainChainBridge") || "";

            config.relay.certifiers = deployments.accounts.certifiers.map((m) => m.privateKey);
            config.relay.callbackEndpoint = "http://127.0.0.1:3400/callback";
            config.relay.relayEndpoint = `http://127.0.0.1:${config.server.port}`;

            client = new TestClient({
                headers: {
                    Authorization: config.relay.accessKey,
                },
            });
        });

        before("Create TestServer", async () => {
            serverURL = new URL(`http://127.0.0.1:${config.server.port}`);
            storage = await RelayStorage.make(config.database);

            const schedulers: Scheduler[] = [];
            schedulers.push(new WatchScheduler(expression));
            const graph_sidechain = await GraphStorage.make(config.graph_sidechain);
            const graph_mainchain = await GraphStorage.make(config.graph_mainchain);
            await contractManager.attach();
            server = new TestServer(config, contractManager, storage, graph_sidechain, graph_mainchain, schedulers);
        });

        before("Start TestServer", async () => {
            await server.start();
        });

        after("Stop TestServer", async () => {
            await server.stop();
            await storage.dropTestDB();
        });

        before("Start CallbackServer", async () => {
            fakerCallbackServer = new FakerCallbackServer(3400);
            await fakerCallbackServer.start();
        });

        after("Stop CallbackServer", async () => {
            await fakerCallbackServer.stop();
        });

        context("Test of Loyalty Point", () => {
            const purchase: IPurchaseData = {
                purchaseId: getPurchaseId(),
                amount: 10000,
                providePercent: 10,
                currency: "krw",
                shopIndex: 1,
                userIndex: 0,
            };

            const purchaseAmount = Amount.make(purchase.amount, 18).value;
            const shop = shopData[purchase.shopIndex];
            const pointAmount = ContractUtils.zeroGWEI(purchaseAmount.mul(purchase.providePercent).div(100));

            const purchaseOfLoyalty: IPurchaseData = {
                purchaseId: getPurchaseId(),
                amount: 10,
                providePercent: 10,
                currency: "krw",
                shopIndex: 1,
                userIndex: purchase.userIndex,
            };
            const amountOfLoyalty = Amount.make(purchaseOfLoyalty.amount, 18).value;

            it("Save Purchase Data", async () => {
                const phoneHash = ContractUtils.getPhoneHash(userData[purchase.userIndex].phone);
                const userAccount =
                    userData[purchase.userIndex].address.trim() !== ""
                        ? userData[purchase.userIndex].address.trim()
                        : AddressZero;
                const purchaseParam = {
                    purchaseId: purchase.purchaseId,
                    amount: purchaseAmount,
                    loyalty: pointAmount,
                    currency: purchase.currency.toLowerCase(),
                    shopId: shop.shopId,
                    account: userAccount,
                    phone: phoneHash,
                    sender: deployments.accounts.system.address,
                    signature: "",
                };
                purchaseParam.signature = await ContractUtils.getPurchaseSignature(
                    deployments.accounts.system,
                    purchaseParam,
                    contractManager.sideChainId
                );
                const purchaseMessage = ContractUtils.getPurchasesMessage(
                    0,
                    [purchaseParam],
                    contractManager.sideChainId
                );
                const signatures = await Promise.all(
                    deployments.accounts.validators.map((m) => ContractUtils.signMessage(m, purchaseMessage))
                );
                const proposeMessage = ContractUtils.getPurchasesProposeMessage(
                    0,
                    [purchaseParam],
                    signatures,
                    contractManager.sideChainId
                );
                const proposerSignature = await ContractUtils.signMessage(
                    deployments.accounts.validators[0],
                    proposeMessage
                );
                await expect(
                    providerContract
                        .connect(deployments.accounts.certifiers[0])
                        .savePurchase(0, [purchaseParam], signatures, proposerSignature)
                )
                    .to.emit(providerContract, "SavedPurchase")
                    .withNamedArgs({
                        purchaseId: purchase.purchaseId,
                        amount: purchaseAmount,
                        loyalty: pointAmount,
                        currency: purchase.currency.toLowerCase(),
                        shopId: shop.shopId,
                        account: userAccount,
                        phone: phoneHash,
                    })
                    .emit(ledgerContract, "ProvidedPoint")
                    .withNamedArgs({
                        account: userAccount,
                        providedPoint: pointAmount,
                        providedValue: pointAmount,
                        purchaseId: purchase.purchaseId,
                        shopId: shop.shopId,
                    });
            });

            it("Get Temporary Account", async () => {
                const nonce = await ledgerContract.nonceOf(users[purchase.userIndex].address);
                const message = ContractUtils.getAccountMessage(
                    users[purchase.userIndex].address,
                    nonce,
                    contractManager.sideChainId
                );
                const signature = await ContractUtils.signMessage(users[purchase.userIndex], message);

                const url = URI(serverURL).directory("/v1/payment/account").filename("temporary").toString();
                const response = await client.post(url, {
                    account: users[purchase.userIndex].address,
                    signature,
                });

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);
                console.log(response.data.data.temporaryAccount);
                assert.ok(response.data.data.temporaryAccount !== undefined);
                temporaryAccount = response.data.data.temporaryAccount;
            });

            it("Get user's balance", async () => {
                const url = URI(serverURL)
                    .directory("/v1/ledger/balance/account")
                    .filename(temporaryAccount)
                    .toString();
                const response = await client.get(url);

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);
                assert.deepStrictEqual(response.data.data.point.balance, pointAmount.toString());
            });

            it("Endpoint POST /v1/payment/info", async () => {
                const amount2 = Amount.make(1, 18).value;
                const url = URI(serverURL)
                    .directory("/v1/payment/info")
                    .addQuery("account", temporaryAccount)
                    .addQuery("amount", amount2.toString())
                    .addQuery("currency", "USD")
                    .toString();
                const response = await client.get(url);

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);

                assert.deepStrictEqual(response.data.data.account, users[purchase.userIndex].address);
                assert.deepStrictEqual(response.data.data.paidPoint, Amount.make(1000).toString());
                assert.deepStrictEqual(response.data.data.feePoint, Amount.make(50).toString());
                assert.deepStrictEqual(response.data.data.totalPoint, Amount.make(1050).toString());
                assert.deepStrictEqual(response.data.data.amount, Amount.make(1).toString());
                assert.deepStrictEqual(response.data.data.currency, "usd");
                assert.deepStrictEqual(response.data.data.feeRate, 0.05);
            });

            let paymentId: string;
            it("Endpoint POST /v1/payment/new/open", async () => {
                const url = URI(serverURL).directory("/v1/payment/new").filename("open").toString();

                const params = {
                    purchaseId: purchaseOfLoyalty.purchaseId,
                    amount: amountOfLoyalty.toString(),
                    currency: "krw",
                    shopId: shopData[purchaseOfLoyalty.shopIndex].shopId,
                    account: temporaryAccount,
                };
                const response = await client.post(url, params);

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);

                assert.deepStrictEqual(response.data.data.account, users[purchase.userIndex].address);

                paymentId = response.data.data.paymentId;
            });

            it("Endpoint POST /v1/payment/item", async () => {
                const url = URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString();
                const response = await client.get(url);

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);

                assert.deepStrictEqual(response.data.data.paymentId, paymentId);
                assert.deepStrictEqual(response.data.data.account, users[purchase.userIndex].address);
                assert.deepStrictEqual(response.data.data.amount, amountOfLoyalty.toString());
            });

            it("Endpoint POST /v1/payment/new/approval - deny", async () => {
                const responseItem = await client.get(
                    URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                );

                const nonce = await ledgerContract.nonceOf(users[purchaseOfLoyalty.userIndex].address);
                const signature = await ContractUtils.signLoyaltyNewPayment(
                    users[purchaseOfLoyalty.userIndex],
                    paymentId,
                    responseItem.data.data.purchaseId,
                    responseItem.data.data.amount,
                    responseItem.data.data.currency,
                    responseItem.data.data.shopId,
                    nonce,
                    contractManager.sideChainId
                );

                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("approval").toString(),
                    {
                        paymentId,
                        approval: false,
                        signature,
                    }
                );

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);
                assert.deepStrictEqual(response.data.data.paymentStatus, LoyaltyPaymentTaskStatus.DENIED_NEW);
            });

            it("Waiting", async () => {
                await ContractUtils.delay(2000);
                assert.deepStrictEqual(fakerCallbackServer.responseData.length, 1);
                assert.deepStrictEqual(fakerCallbackServer.responseData[0].code, 4000);
            });

            it("Endpoint POST /v1/payment/new/approval", async () => {
                const responseItem = await client.get(
                    URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                );
                const nonce = await ledgerContract.nonceOf(users[purchaseOfLoyalty.userIndex].address);
                const signature = await ContractUtils.signLoyaltyNewPayment(
                    users[purchaseOfLoyalty.userIndex],
                    paymentId,
                    responseItem.data.data.purchaseId,
                    responseItem.data.data.amount,
                    responseItem.data.data.currency,
                    responseItem.data.data.shopId,
                    nonce,
                    contractManager.sideChainId
                );

                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("approval").toString(),
                    {
                        paymentId,
                        approval: true,
                        signature,
                    }
                );

                assert.deepStrictEqual(response.data.code, 2020);
                assert.ok(response.data.data === undefined);
                assert.ok(response.data.error !== undefined);
                assert.ok(response.data.error.message === "The status code for this payment cannot be approved");
            });

            it("Get Temporary Account", async () => {
                const nonce = await ledgerContract.nonceOf(users[purchase.userIndex].address);
                const message = ContractUtils.getAccountMessage(
                    users[purchase.userIndex].address,
                    nonce,
                    contractManager.sideChainId
                );
                const signature = await ContractUtils.signMessage(users[purchase.userIndex], message);

                const url = URI(serverURL).directory("/v1/payment/account").filename("temporary").toString();
                const response = await client.post(url, {
                    account: users[purchase.userIndex].address,
                    signature,
                });

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);
                console.log(response.data.data.temporaryAccount);
                assert.ok(response.data.data.temporaryAccount !== undefined);
                temporaryAccount = response.data.data.temporaryAccount;
            });

            it("Endpoint POST /v1/payment/new/open", async () => {
                const url = URI(serverURL).directory("/v1/payment/new").filename("open").toString();

                const params = {
                    purchaseId: purchaseOfLoyalty.purchaseId,
                    amount: amountOfLoyalty.toString(),
                    currency: "krw",
                    shopId: shopData[purchaseOfLoyalty.shopIndex].shopId,
                    account: temporaryAccount,
                };
                const response = await client.post(url, params);

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);

                assert.deepStrictEqual(response.data.data.account, users[purchase.userIndex].address);

                paymentId = response.data.data.paymentId;
            });

            it("Endpoint POST /v1/payment/new/approval - wrong ID", async () => {
                const responseItem = await client.get(
                    URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                );
                const nonce = await ledgerContract.nonceOf(users[purchaseOfLoyalty.userIndex].address);
                const wrongPaymentId = ContractUtils.getPaymentId(users[purchaseOfLoyalty.userIndex].address, nonce);
                const signature = await ContractUtils.signLoyaltyNewPayment(
                    users[purchaseOfLoyalty.userIndex],
                    wrongPaymentId,
                    responseItem.data.data.purchaseId,
                    responseItem.data.data.amount,
                    responseItem.data.data.currency,
                    responseItem.data.data.shopId,
                    nonce,
                    contractManager.sideChainId
                );

                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("approval").toString(),
                    {
                        paymentId: wrongPaymentId,
                        approval: true,
                        signature,
                    }
                );

                assert.deepStrictEqual(response.data.code, 2003);
                assert.ok(response.data.data === undefined);
                assert.ok(response.data.error !== undefined);
                assert.ok(response.data.error.message === "The payment ID is not exist");
            });

            it("Endpoint POST /v1/payment/new/approval - Wrong signature", async () => {
                const responseItem = await client.get(
                    URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                );
                const nonce = await ledgerContract.nonceOf(users[purchaseOfLoyalty.userIndex].address);
                const signature = await ContractUtils.signLoyaltyNewPayment(
                    users[purchaseOfLoyalty.userIndex + 1],
                    paymentId,
                    responseItem.data.data.purchaseId,
                    responseItem.data.data.amount,
                    responseItem.data.data.currency,
                    responseItem.data.data.shopId,
                    nonce,
                    contractManager.sideChainId
                );

                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("approval").toString(),
                    {
                        paymentId,
                        approval: true,
                        signature,
                    }
                );

                assert.deepStrictEqual(response.data.code, 1501);
                assert.ok(response.data.data === undefined);
                assert.ok(response.data.error !== undefined);
                assert.ok(response.data.error.message === "Invalid signature");
            });

            it("Endpoint POST /v1/payment/new/approval", async () => {
                const responseItem = await client.get(
                    URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                );
                const nonce = await ledgerContract.nonceOf(users[purchaseOfLoyalty.userIndex].address);
                const signature = await ContractUtils.signLoyaltyNewPayment(
                    users[purchaseOfLoyalty.userIndex],
                    paymentId,
                    responseItem.data.data.purchaseId,
                    responseItem.data.data.amount,
                    responseItem.data.data.currency,
                    responseItem.data.data.shopId,
                    nonce,
                    contractManager.sideChainId
                );

                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("approval").toString(),
                    {
                        paymentId,
                        approval: true,
                        signature,
                    }
                );

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);
                assert.ok(response.data.data.txHash !== undefined);
                assert.deepStrictEqual(response.data.data.paymentStatus, LoyaltyPaymentTaskStatus.APPROVED_NEW_SENT_TX);
            });

            it("...Waiting", async () => {
                const t1 = ContractUtils.getTimeStamp();
                while (true) {
                    const responseItem = await client.get(
                        URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                    );
                    if (responseItem.data.data.paymentStatus === LoyaltyPaymentTaskStatus.REPLY_COMPLETED_NEW) break;
                    else if (ContractUtils.getTimeStamp() - t1 > 60) break;
                    await ContractUtils.delay(1000);
                }
            });

            it("Check Response", async () => {
                assert.deepStrictEqual(fakerCallbackServer.responseData.length, 2);
                assert.deepStrictEqual(fakerCallbackServer.responseData[1].code, 0);
            });

            it("Endpoint POST /v1/payment/new/approval", async () => {
                const responseItem = await client.get(
                    URI(serverURL).directory("/v1/payment/item").addQuery("paymentId", paymentId).toString()
                );
                const nonce = await ledgerContract.nonceOf(users[purchaseOfLoyalty.userIndex].address);
                const signature = await ContractUtils.signLoyaltyNewPayment(
                    users[purchaseOfLoyalty.userIndex],
                    paymentId,
                    responseItem.data.data.purchaseId,
                    responseItem.data.data.amount,
                    responseItem.data.data.currency,
                    responseItem.data.data.shopId,
                    nonce,
                    contractManager.sideChainId
                );
                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("approval").toString(),
                    {
                        paymentId,
                        approval: false,
                        signature,
                    }
                );

                assert.deepStrictEqual(response.data.code, 2020);
                assert.ok(response.data.data === undefined);
                assert.ok(response.data.error !== undefined);
                assert.ok(response.data.error.message === "The status code for this payment cannot be approved");
            });

            it("Endpoint POST /v1/payment/new/close", async () => {
                const response = await client.post(
                    URI(serverURL).directory("/v1/payment/new").filename("close").toString(),
                    {
                        confirm: true,
                        paymentId,
                    }
                );

                assert.deepStrictEqual(response.data.code, 0);
                assert.ok(response.data.data !== undefined);
                assert.deepStrictEqual(response.data.data.paymentStatus, LoyaltyPaymentTaskStatus.CLOSED_NEW);
            });
        });
    });
});
