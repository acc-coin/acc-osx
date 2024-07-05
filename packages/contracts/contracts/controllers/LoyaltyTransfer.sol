// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.2;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "../lib/DMS.sol";

import "../interfaces/ILedger.sol";
import "./LoyaltyTransferStorage.sol";

contract LoyaltyTransfer is LoyaltyTransferStorage, Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /// @notice 토큰이 전송될 때 발생되는 이벤트
    event TransferredLoyaltyToken(
        address from,
        address to,
        uint256 amount,
        uint256 fee,
        uint256 balanceOfFrom,
        uint256 balanceOfTo
    );

    function initialize() external initializer {
        __UUPSUpgradeable_init();
        __Ownable_init_unchained();

        protocolFee = DMS.TOKEN_DEFAULT_PROTOCOL_FEE;

        isSetLedger = false;
    }

    /// @notice 원장 컨트랙트를 등록한다.
    function setLedger(address _contractAddress) public {
        require(_msgSender() == owner(), "1050");
        if (!isSetLedger) {
            ledgerContract = ILedger(_contractAddress);
            systemAccount = ledgerContract.getSystemAccount();
            isSetLedger = true;
        }
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(_msgSender() == owner(), "Unauthorized access");
    }

    function transferToken(
        address _from,
        address _to,
        uint256 _amount,
        uint256 _expiry,
        bytes calldata _signature
    ) external {
        require(_from != systemAccount, "1051");
        require(_to != systemAccount, "1052");
        bytes32 dataHash = keccak256(
            abi.encode(block.chainid, address(this), _from, _to, _amount, ledgerContract.nonceOf(_from), _expiry)
        );
        require(ECDSA.recover(ECDSA.toEthSignedMessageHash(dataHash), _signature) == _from, "1501");
        require(_expiry > block.timestamp, "1506");
        require(ledgerContract.tokenBalanceOf(_from) >= _amount + protocolFee, "1511");
        require(_amount % 1 gwei == 0, "1030");

        ledgerContract.transferToken(_from, _to, _amount);
        ledgerContract.transferToken(_from, ledgerContract.getProtocolFeeAccount(), protocolFee);
        ledgerContract.increaseNonce(_from);

        emit TransferredLoyaltyToken(
            _from,
            _to,
            _amount,
            protocolFee,
            ledgerContract.tokenBalanceOf(_from),
            ledgerContract.tokenBalanceOf(_to)
        );
    }

    function getProtocolFee() external view returns (uint256) {
        return protocolFee;
    }

    function changeProtocolFee(uint256 _protocolFee) external {
        require(_msgSender() == owner(), "1050");
        require(_protocolFee <= DMS.TOKEN_MAX_PROTOCOL_FEE, "1714");
        protocolFee = _protocolFee;
    }
}
