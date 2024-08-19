import { Config } from "../common/Config";
import { logger } from "../common/Logger";
import { ContractManager } from "../contract/ContractManager";
import { Metrics } from "../metrics/Metrics";
import { WebService } from "../service/WebService";
import { GraphStorage } from "../storage/GraphStorage";
import { RelayStorage } from "../storage/RelayStorage";
import { IStorePurchaseData, PHONE_NULL } from "../types";
import { ResponseMessage } from "../utils/Errors";

// tslint:disable-next-line:no-implicit-dependencies
import { BigNumber } from "@ethersproject/bignumber";
// tslint:disable-next-line:no-implicit-dependencies
import { AddressZero } from "@ethersproject/constants";
import express from "express";
import { body, param, validationResult } from "express-validator";

export class StorePurchaseRouter {
    private web_service: WebService;
    private readonly config: Config;
    private readonly contractManager: ContractManager;
    private readonly metrics: Metrics;
    private storage: RelayStorage;
    private graph_sidechain: GraphStorage;
    private graph_mainchain: GraphStorage;

    constructor(
        service: WebService,
        config: Config,
        contractManager: ContractManager,
        metrics: Metrics,
        storage: RelayStorage,
        graph_sidechain: GraphStorage,
        graph_mainchain: GraphStorage
    ) {
        this.web_service = service;
        this.config = config;
        this.contractManager = contractManager;
        this.metrics = metrics;

        this.storage = storage;
        this.graph_sidechain = graph_sidechain;
        this.graph_mainchain = graph_mainchain;
    }

    private get app(): express.Application {
        return this.web_service.app;
    }

    /**
     * Make the response data
     * @param code      The result code
     * @param data      The result data
     * @param error     The error
     * @private
     */
    private makeResponseData(code: number, data: any, error?: any): any {
        return {
            code,
            data,
            error,
        };
    }

    public async registerRoutes() {
        this.app.post(
            "/v1/purchase/save",
            [
                body("purchaseId").exists().not().isEmpty(),
                body("timestamp").exists().isNumeric(),
                body("waiting").exists().isNumeric(),
                body("account").exists().trim().isEthereumAddress(),
                body("phone")
                    .exists()
                    .trim()
                    .matches(/^(0x)[0-9a-f]{64}$/i),
                body("shopId")
                    .exists()
                    .trim()
                    .matches(/^(0x)[0-9a-f]{64}$/i),
                body("loyaltyValue").exists().trim().isNumeric(),
                body("currency").exists().not().isEmpty(),
            ],
            this.purchase_save.bind(this)
        );

        this.app.post(
            "/v1/purchase/cancel",
            [body("purchaseId").exists().not().isEmpty()],
            this.purchase_cancel.bind(this)
        );

        this.app.get(
            "/v1/purchase/user/provide/:account",
            [param("account").exists().trim().isEthereumAddress()],
            this.purchase_user_provide.bind(this)
        );

        this.app.get(
            "/v1/purchase/user/provide/total/:account",
            [param("account").exists().trim().isEthereumAddress()],
            this.purchase_user_provide_total.bind(this)
        );

        this.app.get(
            "/v1/purchase/shop/provide/:shopId",
            [
                param("shopId")
                    .exists()
                    .trim()
                    .matches(/^(0x)[0-9a-f]{64}$/i),
            ],
            this.purchase_shop_provide.bind(this)
        );

        this.app.get(
            "/v1/purchase/shop/provide/total/:shopId",
            [
                param("shopId")
                    .exists()
                    .trim()
                    .matches(/^(0x)[0-9a-f]{64}$/i),
            ],
            this.purchase_shop_provide_total.bind(this)
        );
    }

    /**
     * POST /v1/purchase/save
     * @private
     */
    private async purchase_save(req: express.Request, res: express.Response) {
        logger.http(`POST /v1/purchase/save ${req.ip}:${JSON.stringify(req.body)}`);

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(200).json(ResponseMessage.getErrorMessage("2001", { validation: errors.array() }));
        }

        try {
            let accessKey = req.get("Authorization");
            if (accessKey === undefined) accessKey = String(req.body.accessKey).trim();
            if (accessKey !== this.config.relay.accessKey) {
                return res.json(ResponseMessage.getErrorMessage("2002"));
            }
            const loyaltyValue: BigNumber = BigNumber.from(String(req.body.loyaltyValue).trim());

            if (loyaltyValue.gt(0)) {
                const phone: string = String(req.body.phone).trim();
                const purchaseData: IStorePurchaseData = {
                    purchaseId: String(req.body.purchaseId).trim(),
                    timestamp: BigInt(String(req.body.timestamp).trim()),
                    waiting: BigInt(String(req.body.waiting).trim()),
                    account: String(req.body.account).trim(),
                    currency: String(req.body.currency).trim(),
                    providePoint: BigNumber.from(0),
                    provideValue: BigNumber.from(loyaltyValue),
                    shopId: String(req.body.shopId).trim(),
                    shopCurrency: "",
                    shopProvidedAmount: BigNumber.from(0),
                };

                let loyaltyPoint: BigNumber;
                if (purchaseData.currency === "krw") {
                    loyaltyPoint = loyaltyValue;
                } else {
                    loyaltyPoint = await this.contractManager.sideCurrencyRateContract.convertCurrency(
                        loyaltyValue,
                        purchaseData.currency,
                        "point"
                    );
                }
                if (purchaseData.account === AddressZero && phone.toLowerCase() !== PHONE_NULL) {
                    purchaseData.account = await this.contractManager.sidePhoneLinkerContract.toAddress(phone);
                }

                if (purchaseData.account !== AddressZero) {
                    purchaseData.providePoint = BigNumber.from(loyaltyPoint);
                    purchaseData.provideValue = BigNumber.from(loyaltyValue);
                    const shopInfo = await this.contractManager.sideShopContract.shopOf(purchaseData.shopId);
                    purchaseData.shopCurrency = shopInfo.currency;
                    purchaseData.shopProvidedAmount =
                        await this.contractManager.sideCurrencyRateContract.convertCurrency(
                            loyaltyValue,
                            purchaseData.currency,
                            purchaseData.shopCurrency
                        );
                }
                await this.storage.postStorePurchase(purchaseData);
            }
            this.metrics.add("success", 1);
            return res.status(200).json(this.makeResponseData(0, {}));
        } catch (error: any) {
            const msg = ResponseMessage.getEVMErrorMessage(error);
            logger.error(`POST /v1/purchase/save : ${msg.error.message}`);
            this.metrics.add("failure", 1);
            return res.status(200).json(msg);
        }
    }

    /**
     * POST /v1/purchase/cancel
     * @private
     */
    private async purchase_cancel(req: express.Request, res: express.Response) {
        logger.http(`POST /v1/purchase/cancel ${req.ip}:${JSON.stringify(req.body)}`);

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(200).json(ResponseMessage.getErrorMessage("2001", { validation: errors.array() }));
        }

        try {
            let accessKey = req.get("Authorization");
            if (accessKey === undefined) accessKey = String(req.body.accessKey).trim();
            if (accessKey !== this.config.relay.accessKey) {
                return res.json(ResponseMessage.getErrorMessage("2002"));
            }
            const purchaseId: string = String(req.body.purchaseId).trim();
            await this.storage.cancelStorePurchase(purchaseId);
            this.metrics.add("success", 1);
            return res.status(200).json(this.makeResponseData(0, {}));
        } catch (error: any) {
            const msg = ResponseMessage.getEVMErrorMessage(error);
            logger.error(`POST /v1/purchase/cancel : ${msg.error.message}`);
            this.metrics.add("failure", 1);
            return res.status(200).json(msg);
        }
    }

    /**
     * GET /v1/purchase/user/provide/:account
     * @private
     */
    private async purchase_user_provide(req: express.Request, res: express.Response) {
        logger.http(`GET /v1/purchase/user/provide/:account ${req.ip}:${JSON.stringify(req.params)}`);

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(200).json(ResponseMessage.getErrorMessage("2001", { validation: errors.array() }));
        }

        try {
            const account: string = String(req.params.account).trim();
            const data = await this.storage.getToBeProvideOfUser(account);
            this.metrics.add("success", 1);
            return res.status(200).json(
                this.makeResponseData(
                    0,
                    data.map((m) => {
                        return {
                            account: m.account,
                            timestamp: m.timestamp.toString(),
                            currency: m.currency,
                            providePoint: m.providePoint.toString(),
                            provideValue: m.provideValue.toString(),
                            purchaseId: m.purchaseId,
                            shopId: m.shopId,
                        };
                    })
                )
            );
        } catch (error: any) {
            const msg = ResponseMessage.getEVMErrorMessage(error);
            logger.error(`GET /v1/purchase/user/provide/:account : ${msg.error.message}`);
            this.metrics.add("failure", 1);
            return res.status(200).json(msg);
        }
    }

    /**
     * GET /v1/purchase/user/provide/total/:account
     * @private
     */
    private async purchase_user_provide_total(req: express.Request, res: express.Response) {
        logger.http(`GET /v1/purchase/user/provide/total/:account ${req.ip}:${JSON.stringify(req.params)}`);

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(200).json(ResponseMessage.getErrorMessage("2001", { validation: errors.array() }));
        }

        try {
            const account: string = String(req.params.account).trim();
            const data = await this.storage.getTotalToBeProvideOfUser(account);
            this.metrics.add("success", 1);
            return res.status(200).json(
                this.makeResponseData(0, {
                    account,
                    providePoint: data.providePoint.toString(),
                    provideValue: data.provideValue.toString(),
                })
            );
        } catch (error: any) {
            const msg = ResponseMessage.getEVMErrorMessage(error);
            logger.error(`GET /v1/purchase/user/provide/total/:account : ${msg.error.message}`);
            this.metrics.add("failure", 1);
            return res.status(200).json(msg);
        }
    }

    /**
     * GET /v1/purchase/shop/provide/:shopId
     * @private
     */
    private async purchase_shop_provide(req: express.Request, res: express.Response) {
        logger.http(`GET /v1/purchase/shop/provide/:shopId ${req.ip}:${JSON.stringify(req.params)}`);

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(200).json(ResponseMessage.getErrorMessage("2001", { validation: errors.array() }));
        }

        try {
            const shopId: string = String(req.params.shopId).trim();
            const data = await this.storage.getToBeProvideOfShop(shopId);
            this.metrics.add("success", 1);
            return res.status(200).json(
                this.makeResponseData(
                    0,
                    data.map((m) => {
                        return {
                            shopId: m.shopId,
                            timestamp: m.timestamp.toString(),
                            currency: m.currency,
                            providedAmount: m.providedAmount.toString(),
                            purchaseId: m.purchaseId,
                        };
                    })
                )
            );
        } catch (error: any) {
            const msg = ResponseMessage.getEVMErrorMessage(error);
            logger.error(`GET /v1/purchase/shop/provide/:shopId : ${msg.error.message}`);
            this.metrics.add("failure", 1);
            return res.status(200).json(msg);
        }
    }

    /**
     * GET /v1/purchase/shop/provide/total/:shopId
     * @private
     */
    private async purchase_shop_provide_total(req: express.Request, res: express.Response) {
        logger.http(`GET /v1/purchase/shop/provide/total/:shopId ${req.ip}:${JSON.stringify(req.params)}`);

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(200).json(ResponseMessage.getErrorMessage("2001", { validation: errors.array() }));
        }

        try {
            const shopId: string = String(req.params.shopId).trim();
            const data = await this.storage.getTotalToBeProvideOfShop(shopId);
            this.metrics.add("success", 1);
            return res.status(200).json(
                this.makeResponseData(0, {
                    shopId,
                    providedAmount: data.providedAmount.toString(),
                })
            );
        } catch (error: any) {
            const msg = ResponseMessage.getEVMErrorMessage(error);
            logger.error(`GET /v1/purchase/shop/provide/total/:shopId : ${msg.error.message}`);
            this.metrics.add("failure", 1);
            return res.status(200).json(msg);
        }
    }
}
