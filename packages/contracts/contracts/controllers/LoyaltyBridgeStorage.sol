// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.2;

import "loyalty-tokens/contracts/BIP20/BIP20DelegatedTransfer.sol";

import "acc-bridge-contracts-v2/contracts/interfaces/IBridge.sol";
import "acc-bridge-contracts-v2/contracts/interfaces/IBridgeValidator.sol";

import "../interfaces/ILedger.sol";

contract LoyaltyBridgeStorage {
    mapping(bytes32 => IBridge.DepositData) internal deposits;
    mapping(bytes32 => IBridge.WithdrawData) internal withdraws;
    mapping(bytes32 => mapping(address => bool)) internal confirmations;

    address internal foundationAccount;

    uint256 internal fee;

    bool internal isSetLedger;
    ILedger internal ledgerContract;
    IBridgeValidator internal validatorContract;
    BIP20DelegatedTransfer internal tokenContract;
    bytes32 internal tokenId;
}
