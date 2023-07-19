// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import { MetaHubbleBase } from "./legos/HubbleBase.sol";
import { IClearingHouse } from "./Interfaces.sol";
import { IOrderBook } from "./orderbooks/OrderBook.sol";

interface IHubbleReferral {
    function traderToReferrer(address trader) external view returns (address referrer);
}

contract HubbleReferral is IHubbleReferral, MetaHubbleBase {

    event ReferralCodeCreated(address indexed referrer, string indexed code, uint timestamp);
    event ReferrerAdded(address indexed trader, address indexed referrer, uint timestamp);

    address immutable public clearingHouse;

    mapping(address => string) public referrerToCode;
    mapping(string => address) public codeToReferrer;
    mapping(address => address) public traderToReferrer;

    // admin things
    uint256 public totalSignupCap; // only valid for invite-only phase
    uint256 public totalSignups;
    bool public restrictedInvites;
    mapping(address => bool) public validTicketAssigner; // account that can update genesisTicketRoot and referralTicketRoot

    // genesis access
    bytes32 public genesisTicketRoot;
    mapping(address => bool) public genesisClaimed;

    // referral access
    bytes32 public referralTicketRoot;
    mapping(address => uint256) public claimed;

    uint256[50] private __gap;

    constructor(address _trustedForwarder, address _clearingHouse) MetaHubbleBase(_trustedForwarder) {
        clearingHouse = _clearingHouse;
    }

    function initialize(address _governance) external initializer {
        restrictedInvites = true;
        _setGovernace(_governance);
    }

    function createReferralCode(string calldata code) external whenNotPaused {
        _createReferralCode(_msgSender(), code);
    }

    function _createReferralCode(address referrer, string memory code) internal {
        require(bytes(code).length >= 4, "HR: referral code too short");
        require(codeToReferrer[code] == address(0), "HR: referral code already exists");
        require(bytes(referrerToCode[referrer]).length == 0, "HR: referral code already exists for this address");

        referrerToCode[referrer] = code;
        codeToReferrer[code] = referrer;
        emit ReferralCodeCreated(referrer, code, block.timestamp);
    }

    function setReferralCode(string calldata code) external whenNotPaused {
        require(restrictedInvites == false, "HR: restricted invites");
        _setReferralCode(_msgSender(), codeToReferrer[code]);
    }

    function _setReferralCode(address trader, address referrer) internal {
        // assertions on trader
        require(trader != referrer, 'HR: self-referral');
        require(traderToReferrer[trader] == address(0), "HR: already has referrer");

        // assertions on referrer
        require(referrer != address(0), "HR: referral code does not exist");
        require(bytes(referrerToCode[referrer]).length != 0, "HR: referrer has no code");

        traderToReferrer[trader] = referrer;
        emit ReferrerAdded(trader, referrer, block.timestamp);
    }

    /* ******************* */
    /*      Airdrops       */
    /* ******************* */

    function claimGenesisTicket(bytes32[] calldata merkleProof, address tradingAuthory) payable external whenNotPaused {
        address trader = _msgSender();
        require(genesisClaimed[trader] == false, "Already claimed");
        require(totalSignups < totalSignupCap, "Total signups exceeded");
        require(
            verifyAirdropProof(keccak256(abi.encode(trader)), genesisTicketRoot, merkleProof),
            "Invalid merkle proof"
        );
        genesisClaimed[trader] = true;
        totalSignups++;
        _setReferralCode(trader, IClearingHouse(clearingHouse).feeSink());
        if (tradingAuthory != address(0)) {
            _whitelistTradingAuthority(trader, tradingAuthory, msg.value);
        }
    }

    function claimReferralTicket(
        address referrer,
        uint256 totalReferralTickets,
        bytes32[] calldata merkleProof,
        address tradingAuthory
    )
        payable
        external
        whenNotPaused
    {
        address trader = _msgSender();
        require(claimed[referrer] < totalReferralTickets, "Already claimed");
        require(totalSignups < totalSignupCap, "Total signups exceeded");
        require(
            verifyAirdropProof(keccak256(abi.encode(referrer, totalReferralTickets)), referralTicketRoot, merkleProof),
            "Invalid merkle proof"
        );

        claimed[referrer]++;
        totalSignups++;
        _setReferralCode(trader, referrer);
        if (tradingAuthory != address(0)) {
            _whitelistTradingAuthority(trader, tradingAuthory, msg.value);
        }
    }

    function _whitelistTradingAuthority(address trader, address authority, uint airdrop) internal {
        IOrderBook(IClearingHouse(clearingHouse).orderBook()).setTradingAuthority{value: airdrop}(trader, authority);
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    function verifyAirdropProof(bytes32 node, bytes32 root, bytes32[] calldata merkleProof) public pure returns (bool) {
        return MerkleProof.verify(merkleProof, root, node);
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function beginSignups(uint _totalSignupCap) external onlyGovernance {
        totalSignupCap = _totalSignupCap;
        _createReferralCode(IClearingHouse(clearingHouse).feeSink(), "hubble-exchange");
    }

    function setValidTicketAssigner(address _ticketAssigner, bool _valid) external onlyGovernance {
        validTicketAssigner[_ticketAssigner] = _valid;
    }

    function concludeRestrictedInvitePhase() external onlyGovernance {
        restrictedInvites = false;
    }

    function setTotalSignupCap(uint256 _totalSignupCap) external onlyGovernance {
        require(_totalSignupCap >= totalSignups, "HR: cap must be greater than current signups");
        totalSignupCap = _totalSignupCap;
    }

    function setGenesisTicketRoot(bytes32 _genesisTicketRoot) external whenNotPaused {
        require(_msgSender() == governance() || validTicketAssigner[_msgSender()], "HR: not a valid ticket assigner");
        genesisTicketRoot = _genesisTicketRoot;
    }

    function setReferralTicketRoot(bytes32 _referralTicketRoot) external whenNotPaused {
        require(_msgSender() == governance() || validTicketAssigner[_msgSender()], "HR: not a valid ticket assigner");
        referralTicketRoot = _referralTicketRoot;
    }
}
