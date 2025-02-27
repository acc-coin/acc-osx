// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.2;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "loyalty-tokens/contracts/BIP20/BIP20DelegatedTransfer.sol";
import "acc-bridge-contracts-v2/contracts/interfaces/IBridgeLiquidity.sol";
import "acc-bridge-contracts-v2/contracts/lib/BridgeLib.sol";

import "../interfaces/ICurrencyRate.sol";
import "../interfaces/ILedger.sol";
import "./LedgerStorage.sol";

import "../lib/DMS.sol";

/// @notice 포인트와 토큰의 원장
contract Ledger is LedgerStorage, Initializable, OwnableUpgradeable, UUPSUpgradeable, ILedger, IBridgeLiquidity {
    /// @notice 포인트가 지급될 때 발생되는 이벤트
    event ProvidedPoint(
        address account,
        uint256 providedPoint,
        uint256 providedValue,
        string currency,
        uint256 balancePoint,
        string purchaseId,
        bytes32 shopId,
        address provider,
        uint256 consumedToken,
        uint256 providerBalanceToken,
        uint256 tag
    );

    /// @notice 포인트가 지급될 때 발생되는 이벤트
    event ProvidedUnPayablePoint(
        bytes32 phone,
        uint256 providedPoint,
        uint256 providedValue,
        string currency,
        uint256 balancePoint,
        string purchaseId,
        bytes32 shopId,
        address provider,
        uint256 consumedToken,
        uint256 providerBalanceToken,
        uint256 tag
    );

    event Refunded(
        address account,
        uint256 amountValue,
        string currency,
        uint256 amountToken,
        uint256 balanceToken,
        bytes32 shopId
    );

    /// @notice 토큰을 예치했을 때 발생하는 이벤트
    event Deposited(address account, uint256 depositedToken, uint256 depositedValue, uint256 balanceToken);
    /// @notice 토큰을 인출했을 때 발생하는 이벤트
    event Withdrawn(address account, uint256 withdrawnToken, uint256 withdrawnValue, uint256 balanceToken);

    event RemovedPhoneInfo(bytes32 phone, address account);

    event RegisteredProvider(address provider);
    event UnregisteredProvider(address provider);

    event RegisteredProvisionAgent(address account, address agent);
    event RegisteredRefundAgent(address account, address agent);
    event RegisteredWithdrawalAgent(address account, address agent);

    struct ManagementAddresses {
        address system;
        address paymentFee;
        address protocolFee;
    }

    struct ContractAddresses {
        address token;
        address phoneLink;
        address currencyRate;
        address provider;
        address consumer;
        address exchanger;
        address burner;
        address transfer;
        address bridge;
        address shop;
    }

    /// @notice 생성자
    function initialize(
        ManagementAddresses memory managements,
        ContractAddresses memory contracts
    ) external initializer {
        __UUPSUpgradeable_init();
        __Ownable_init_unchained();

        systemAccount = managements.system;
        providers[systemAccount] = true;
        paymentFeeAccount = managements.paymentFee;
        protocolFeeAccount = managements.protocolFee;

        providerAddress = contracts.provider;
        consumerAddress = contracts.consumer;
        exchangerAddress = contracts.exchanger;
        burnerAddress = contracts.burner;
        transferAddress = contracts.transfer;
        tokenAddress = contracts.token;
        bridgeAddress = contracts.bridge;
        shopAddress = contracts.shop;

        tokenContract = IBIP20DelegatedTransfer(contracts.token);
        linkContract = IPhoneLinkCollection(contracts.phoneLink);
        currencyRateContract = ICurrencyRate(contracts.currencyRate);
        paymentFee = MAX_PAYMENT_FEE;
        BIP20DelegatedTransfer token = BIP20DelegatedTransfer(contracts.token);
        tokenId = BridgeLib.getTokenId(token.name(), token.symbol());

        temporaryAddress = address(0x0);
    }

    function _authorizeUpgrade(address newImplementation) internal virtual override {
        require(_msgSender() == owner(), "Unauthorized access");
    }

    modifier onlyProvider() {
        require(_msgSender() == providerAddress, "1005");
        _;
    }

    modifier onlyConsumer() {
        require(_msgSender() == consumerAddress, "1006");
        _;
    }

    modifier onlyExchanger() {
        require(_msgSender() == exchangerAddress, "1007");
        _;
    }

    modifier onlyAccessNonce() {
        require(
            _msgSender() == providerAddress ||
                _msgSender() == consumerAddress ||
                _msgSender() == exchangerAddress ||
                _msgSender() == transferAddress ||
                _msgSender() == bridgeAddress,
            "1007"
        );
        _;
    }

    modifier onlyAccessLedger() {
        require(
            _msgSender() == consumerAddress ||
                _msgSender() == exchangerAddress ||
                _msgSender() == transferAddress ||
                _msgSender() == bridgeAddress,
            "1007"
        );
        _;
    }

    modifier onlyShop() {
        require(_msgSender() == shopAddress, "1007");
        _;
    }

    modifier onlyAccessBurner() {
        require(_msgSender() == burnerAddress, "1007");
        _;
    }

    /// @notice 토큰을 예치합니다.
    /// @param _amount 금액
    function deposit(uint256 _amount) external virtual {
        require(_amount % 1 gwei == 0, "1030");
        require(_amount <= tokenContract.allowance(_msgSender(), address(this)), "1512");
        tokenContract.transferFrom(_msgSender(), address(this), _amount);

        tokenBalances[_msgSender()] += _amount;

        emit Deposited(
            _msgSender(),
            _amount,
            currencyRateContract.convertTokenToPoint(_amount),
            tokenBalances[_msgSender()]
        );
    }

    /// @notice 토큰을 인출합니다.
    /// @param _amount 금액
    function withdraw(uint256 _amount) external virtual {
        require(_msgSender() != systemAccount, "1053");
        require(_amount % 1 gwei == 0, "1030");
        require(_amount <= tokenBalances[_msgSender()], "1511");
        tokenContract.transfer(_msgSender(), _amount);

        tokenBalances[_msgSender()] -= _amount;

        emit Withdrawn(
            _msgSender(),
            _amount,
            currencyRateContract.convertTokenToPoint(_amount),
            tokenBalances[_msgSender()]
        );
    }

    /// @notice 포인트를 지급합니다.
    /// @dev 구매 데이터를 확인한 후 호출됩니다.
    /// @param _phone 전화번호 해시
    /// @param _loyaltyPoint 지급할 포인트(단위:포인트)
    /// @param _loyaltyValue 지급할 포인트가치(단위:구매한 화폐의 통화)
    /// @param _purchaseId 구매 아이디
    /// @param _shopId 구매한 가맹점 아이디
    function provideUnPayablePoint(
        bytes32 _phone,
        uint256 _loyaltyPoint,
        uint256 _loyaltyValue,
        string calldata _currency,
        string calldata _purchaseId,
        bytes32 _shopId,
        address _sender,
        uint256 _tag
    ) external override onlyProvider {
        _provideUnPayablePoint(_phone, _loyaltyPoint, _loyaltyValue, _currency, _purchaseId, _shopId, _sender, _tag);
    }

    function _provideUnPayablePoint(
        bytes32 _phone,
        uint256 _loyaltyPoint,
        uint256 _loyaltyValue,
        string calldata _currency,
        string calldata _purchaseId,
        bytes32 _shopId,
        address _sender,
        uint256 _tag
    ) internal {
        uint256 consumedToken = 0;
        if (_sender == systemAccount) {
            unPayablePointBalances[_phone] += _loyaltyPoint;
        } else {
            consumedToken = currencyRateContract.convertPointToToken(_loyaltyPoint);
            require(tokenBalances[_sender] >= consumedToken, "1511");

            unPayablePointBalances[_phone] += _loyaltyPoint;
            tokenBalances[_sender] -= consumedToken;
        }
        uint256 balance = unPayablePointBalances[_phone];
        uint256 providerTokenBalance = tokenBalances[_sender];
        uint256 tag = _tag;
        emit ProvidedUnPayablePoint(
            _phone,
            _loyaltyPoint,
            _loyaltyValue,
            _currency,
            balance,
            _purchaseId,
            _shopId,
            _sender,
            consumedToken,
            providerTokenBalance,
            tag
        );
    }

    /// @notice 포인트를 지급합니다.
    /// @dev 구매 데이터를 확인한 후 호출됩니다.
    /// @param _account 사용자의 지갑주소
    /// @param _loyaltyPoint 지급할 포인트(단위:포인트)
    /// @param _loyaltyValue 지급할 포인트가치(단위:구매한 화폐의 통화)
    /// @param _purchaseId 구매 아이디
    /// @param _shopId 구매한 가맹점 아이디
    function providePoint(
        address _account,
        uint256 _loyaltyPoint,
        uint256 _loyaltyValue,
        string calldata _currency,
        string calldata _purchaseId,
        bytes32 _shopId,
        address _sender,
        uint256 _tag
    ) external override onlyProvider {
        _providePoint(_account, _loyaltyPoint, _loyaltyValue, _currency, _purchaseId, _shopId, _sender, _tag);
    }

    function _providePoint(
        address _account,
        uint256 _loyaltyPoint,
        uint256 _loyaltyValue,
        string calldata _currency,
        string calldata _purchaseId,
        bytes32 _shopId,
        address _sender,
        uint256 _tag
    ) internal {
        uint256 consumedToken = 0;
        if (_sender == systemAccount) {
            pointBalances[_account] += _loyaltyPoint;
        } else {
            consumedToken = currencyRateContract.convertPointToToken(_loyaltyPoint);
            require(tokenBalances[_sender] >= consumedToken, "1511");

            pointBalances[_account] += _loyaltyPoint;
            tokenBalances[_sender] -= consumedToken;
            tokenBalances[systemAccount] += consumedToken;
        }
        uint256 balance = pointBalances[_account];
        uint256 providerTokenBalance = tokenBalances[_sender];
        uint256 tag = _tag;
        emit ProvidedPoint(
            _account,
            _loyaltyPoint,
            _loyaltyValue,
            _currency,
            balance,
            _purchaseId,
            _shopId,
            _sender,
            consumedToken,
            providerTokenBalance,
            tag
        );
    }

    function refund(
        address _account,
        uint256 _amountValue,
        string calldata _currency,
        uint256 amountToken,
        bytes32 _shopId
    ) external override onlyShop {
        require(tokenBalances[systemAccount] >= amountToken, "1511");

        tokenBalances[_account] += amountToken;
        tokenBalances[systemAccount] -= amountToken;
        uint256 balanceToken = tokenBalances[_account];
        emit Refunded(_account, _amountValue, _currency, amountToken, balanceToken, _shopId);
    }

    /// @notice 포인트의 잔고에 더한다. Consumer 컨트랙트만 호출할 수 있다.
    function addPointBalance(address _account, uint256 _amount) external override onlyAccessLedger {
        pointBalances[_account] += _amount;
    }

    /// @notice 포인트의 잔고에서 뺀다. Consumer 컨트랙트만 호출할 수 있다.
    function subPointBalance(address _account, uint256 _amount) external override onlyAccessLedger {
        if (pointBalances[_account] >= _amount) pointBalances[_account] -= _amount;
    }

    /// @notice 토큰의 잔고에 더한다. Consumer 컨트랙트만 호출할 수 있다.
    function addTokenBalance(address _account, uint256 _amount) external override onlyAccessLedger {
        tokenBalances[_account] += _amount;
    }

    /// @notice 토큰의 잔고에서 뺀다. Consumer 컨트랙트만 호출할 수 있다.
    function subTokenBalance(address _account, uint256 _amount) external override onlyAccessLedger {
        uint256 balance = tokenBalances[_account];
        require(balance >= _amount, "1511");
        tokenBalances[_account] = balance - _amount;
    }

    /// @notice 토큰을 전달한다. Consumer 컨트랙트만 호출할 수 있다.
    function transferToken(address _from, address _to, uint256 _amount) external override onlyAccessLedger {
        uint256 fromBalance = tokenBalances[_from];
        require(fromBalance >= _amount, "1511");
        tokenBalances[_from] = fromBalance - _amount;
        tokenBalances[_to] += _amount;
    }

    /// @notice 포인트의 잔고를 리턴한다
    /// @param _phone 전화번호의 해시
    function unPayablePointBalanceOf(bytes32 _phone) external view override returns (uint256) {
        return unPayablePointBalances[_phone];
    }

    /// @notice 포인트의 잔고를 리턴한다
    /// @param _account 지갑주소
    function pointBalanceOf(address _account) external view override returns (uint256) {
        return pointBalances[_account];
    }

    /// @notice 토큰의 잔고를 리턴한다
    /// @param _account 지갑주소
    function tokenBalanceOf(address _account) external view override returns (uint256) {
        return tokenBalances[_account];
    }

    /// @notice nonce를 리턴한다
    /// @param _account 지갑주소
    function nonceOf(address _account) external view override returns (uint256) {
        return nonce[_account];
    }

    /// @notice nonce를 증가한다
    /// @param _account 지갑주소
    function increaseNonce(address _account) external override onlyAccessNonce {
        nonce[_account]++;
    }

    /// @notice 포인트와 토큰의 사용수수료률을 설정합니다. 5%를 초과한 값은 설정할 수 없습니다.
    /// @param _fee % 단위 입니다.
    function setPaymentFee(uint32 _fee) external override {
        require(_fee <= MAX_PAYMENT_FEE, "1521");
        require(_msgSender() == owner(), "1050");
        paymentFee = _fee;
    }

    /// @notice 포인트와 토큰의 사용수수료률을 리턴합니다.
    function getPaymentFee() external view override returns (uint32) {
        return paymentFee;
    }

    /// @notice 사용가능한 포인트로 전환합니다.
    function changeToPayablePoint(bytes32 _phone, address _account) external override onlyExchanger {
        uint256 amount = unPayablePointBalances[_phone];
        require(amount > 0, "1511");
        unPayablePointBalances[_phone] = 0;
        pointBalances[_account] += amount;
    }

    function getSystemAccount() external view override returns (address) {
        return systemAccount;
    }

    function getPaymentFeeAccount() external view override returns (address) {
        return paymentFeeAccount;
    }

    function getProtocolFeeAccount() external view override returns (address) {
        return protocolFeeAccount;
    }

    function getTokenAddress() external view override returns (address) {
        return tokenAddress;
    }

    function burnUnPayablePoint(bytes32 _phone, uint256 _amount) external override onlyAccessBurner {
        uint256 balance = unPayablePointBalances[_phone];
        require(balance >= _amount, "1511");
        unPayablePointBalances[_phone] = balance - _amount;
    }

    function burnPoint(address _account, uint256 _amount) external override onlyAccessBurner {
        if (pointBalances[_account] >= _amount) pointBalances[_account] -= _amount;
    }

    function removePhoneInfo(address _account, bytes calldata _signature) external {
        bytes32 dataHash = keccak256(abi.encode(_account, block.chainid, nonce[_account]));
        require(ECDSA.recover(ECDSA.toEthSignedMessageHash(dataHash), _signature) == _account, "1501");

        nonce[_account]++;

        bytes32 phone = linkContract.toPhone(_account);
        if (phone != 0) {
            delete unPayablePointBalances[phone];
            emit RemovedPhoneInfo(phone, _account);
        }
    }

    /// @notice 브리지를 위한 유동성 자금을 예치합니다.
    function depositLiquidity(
        bytes32 _tokenId,
        uint256 _amount,
        uint256 _expiry,
        bytes calldata _signature
    ) external payable override {
        require(_tokenId == tokenId, "1713");
        require(tokenContract.balanceOf(_msgSender()) >= _amount, "1511");
        require(_amount % 1 gwei == 0, "1030");

        if (tokenContract.delegatedTransfer(_msgSender(), address(this), _amount, _expiry, _signature)) {
            tokenBalances[bridgeAddress] += _amount;
            liquidity[_msgSender()] += _amount;
            emit DepositedLiquidity(_tokenId, _msgSender(), _amount, liquidity[_msgSender()]);
        }
    }

    /// @notice 브리지를 위한 유동성 자금을 인출합니다.
    function withdrawLiquidity(bytes32 _tokenId, uint256 _amount) external override {
        require(_msgSender() != systemAccount, "1053");
        require(_tokenId == tokenId, "1713");
        require(liquidity[_msgSender()] >= _amount, "1514");
        require(tokenBalances[bridgeAddress] >= _amount, "1511");
        require(tokenContract.balanceOf(address(this)) >= _amount, "1511");
        require(_amount % 1 gwei == 0, "1030");

        tokenContract.transfer(_msgSender(), _amount);
        liquidity[_msgSender()] -= _amount;
        tokenBalances[bridgeAddress] -= _amount;
        emit WithdrawnLiquidity(_tokenId, _msgSender(), _amount, liquidity[_msgSender()]);
    }

    /// @notice 브리지를 위한 유동성 자금을 조회합니다.
    function getLiquidity(bytes32 _tokenId, address _account) external view override returns (uint256) {
        require(_tokenId != tokenId, "1713");
        return liquidity[_account];
    }

    function changeFeeAccount(address _account) external {
        require(_msgSender() == owner(), "1050");

        paymentFeeAccount = _account;
    }

    function changeProtocolFeeAccount(address _account) external {
        require(_msgSender() == owner(), "1050");

        protocolFeeAccount = _account;
    }

    function registerProvider(address _account) external {
        require(_msgSender() == owner(), "1050");
        providers[_account] = true;
        emit RegisteredProvider(_account);
    }

    function unregisterProvider(address _account) external {
        require(_msgSender() == owner(), "1050");
        providers[_account] = false;
        emit UnregisteredProvider(_account);
    }

    function isProvider(address _account) external view override returns (bool) {
        return providers[_account];
    }

    function registerProvisionAgent(address _account, address _agent, bytes calldata _signature) external {
        bytes32 dataHash = keccak256(abi.encode(_account, _agent, block.chainid, nonce[_account]));
        require(ECDSA.recover(ECDSA.toEthSignedMessageHash(dataHash), _signature) == _account, "1501");
        provisionAgents[_account] = _agent;
        nonce[_account]++;

        emit RegisteredProvisionAgent(_account, _agent);
    }

    function provisionAgentOf(address _account) external view override returns (address) {
        return provisionAgents[_account];
    }

    function registerRefundAgent(address _account, address _agent, bytes calldata _signature) external {
        bytes32 dataHash = keccak256(abi.encode(_account, _agent, block.chainid, nonce[_account]));
        require(ECDSA.recover(ECDSA.toEthSignedMessageHash(dataHash), _signature) == _account, "1501");
        refundAgents[_account] = _agent;
        nonce[_account]++;

        emit RegisteredRefundAgent(_account, _agent);
    }

    function refundAgentOf(address _account) external view override returns (address) {
        return refundAgents[_account];
    }

    function registerWithdrawalAgent(address _account, address _agent, bytes calldata _signature) external {
        bytes32 dataHash = keccak256(abi.encode(_account, _agent, block.chainid, nonce[_account]));
        require(ECDSA.recover(ECDSA.toEthSignedMessageHash(dataHash), _signature) == _account, "1501");
        withdrawalAgents[_account] = _agent;
        nonce[_account]++;

        emit RegisteredWithdrawalAgent(_account, _agent);
    }

    function withdrawalAgentOf(address _account) external view override returns (address) {
        return withdrawalAgents[_account];
    }
}
