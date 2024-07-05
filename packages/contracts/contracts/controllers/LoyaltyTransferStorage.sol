// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.2;

import "../interfaces/ILedger.sol";

contract LoyaltyTransferStorage {
    address internal foundationAccount;
    uint256 internal protocolFee;

    ILedger internal ledgerContract;

    bool internal isSetLedger;
}
