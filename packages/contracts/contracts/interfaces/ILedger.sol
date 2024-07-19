// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.2;

interface ILedger {
    function providePoint(
        address _account,
        uint256 _loyaltyPoint,
        uint256 _loyaltyValue,
        string calldata _currency,
        string calldata _purchaseId,
        bytes32 _shopId,
        address _sender
    ) external;

    function provideUnPayablePoint(
        bytes32 _phone,
        uint256 _loyaltyPoint,
        uint256 _loyaltyValue,
        string calldata _currency,
        string calldata _purchaseId,
        bytes32 _shopId,
        address _sender
    ) external;

    function refund(
        address _account,
        uint256 _amountValue,
        string calldata _currency,
        uint256 amountToken,
        bytes32 _shopId
    ) external;

    function changeToPayablePoint(bytes32 _phone, address _account) external;

    function addPointBalance(address _account, uint256 _amount) external;

    function subPointBalance(address _account, uint256 _amount) external;

    function addTokenBalance(address _account, uint256 _amount) external;

    function subTokenBalance(address _account, uint256 _amount) external;

    function transferToken(address _from, address _to, uint256 _amount) external;

    function unPayablePointBalanceOf(bytes32 _phone) external view returns (uint256);

    function pointBalanceOf(address _account) external view returns (uint256);

    function tokenBalanceOf(address _account) external view returns (uint256);

    function nonceOf(address _account) external view returns (uint256);

    function increaseNonce(address _account) external;

    function setPaymentFee(uint32 _fee) external;

    function getPaymentFee() external view returns (uint32);

    function getSystemAccount() external view returns (address);

    function getPaymentFeeAccount() external view returns (address);

    function getProtocolFeeAccount() external view returns (address);

    function getTokenAddress() external view returns (address);

    function burnUnPayablePoint(bytes32 _phone, uint256 _amount) external;

    function burnPoint(address _account, uint256 _amount) external;

    function isProvider(address _account) external view returns (bool);

    function assistantOf(address _account) external view returns (address);
}
