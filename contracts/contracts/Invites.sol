// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IMintableToken is IERC20 {
    function mint(address to, uint256 amount) external;
}

/// @title Invites
/// @notice The way into the community: a new account claims an invite in the same transaction
///         that deploys it, so an invite is spent only if the account really gets created.
///         - Member invites lock coins (zero is fine) from the creator; the new account gets
///           them. Single use. The creator can cancel at any time, and once the invite has
///           expired anyone can return the coins to the creator.
///         - Bank invites mint a fixed amount to each new account, up to `maxUses` accounts.
///         An invite is a throwaway key pair whose private key travels in the link. Claiming
///         needs the key's signature over (chain, this contract, claiming account), so a copied
///         transaction cannot redirect the coins. An account can join only once.
contract Invites {
    struct Invite {
        address creator;
        uint64 expiresAt;
        bool minting; // bank invite: mint `amount` per claim instead of handing over locked coins
        uint32 maxUses;
        uint32 uses; // == maxUses once the invite is used up, cancelled or refunded
        uint256 amount;
    }

    uint64 public constant MAX_DURATION = 7 days;

    IMintableToken public immutable token;
    address public bank;
    uint32 public maxOpenPerMember; // bounds spam: every claim is an account the bank pays gas for

    mapping(address key => Invite) public invites;
    mapping(address creator => uint32) public openInvites;
    mapping(address account => bool) public joined;

    event InviteCreated(
        address indexed key, address indexed creator, uint256 amount, uint32 maxUses, bool minting, uint64 expiresAt
    );
    event InviteClaimed(address indexed key, address indexed account, uint256 amount);
    /// @notice Cancelled by its creator, or closed after expiry; `refunded` went back to the creator.
    event InviteClosed(address indexed key, uint256 refunded);
    event BankChanged(address indexed bank);
    event MaxOpenPerMemberChanged(uint32 maxOpen);

    error OnlyBank();
    error OnlyMembers();
    error OnlyCreator();
    error InvalidKey();
    error InvalidDuration();
    error InvalidUses();
    error TooManyOpenInvites();
    error NoInvite();
    error InviteExpired();
    error InviteNotExpired();
    error InviteClosedAlready();
    error AlreadyJoined();
    error InvalidSignature();

    modifier onlyBank() {
        if (msg.sender != bank) revert OnlyBank();
        _;
    }

    constructor(IMintableToken token_, address bank_, uint32 maxOpenPerMember_) {
        token = token_;
        bank = bank_;
        maxOpenPerMember = maxOpenPerMember_;
        emit BankChanged(bank_);
        emit MaxOpenPerMemberChanged(maxOpenPerMember_);
    }

    function setBank(address newBank) external onlyBank {
        bank = newBank;
        emit BankChanged(newBank);
    }

    function setMaxOpenPerMember(uint32 maxOpen) external onlyBank {
        maxOpenPerMember = maxOpen;
        emit MaxOpenPerMemberChanged(maxOpen);
    }

    /// @notice A member invites one person, locking `amount` (pulled with transferFrom, so approve first).
    function create(address key, uint256 amount, uint64 expiresAt) external {
        if (!joined[msg.sender]) revert OnlyMembers();
        if (openInvites[msg.sender] >= maxOpenPerMember) revert TooManyOpenInvites();
        _store(key, Invite(msg.sender, expiresAt, false, 1, 0, amount));
        openInvites[msg.sender] += 1;
        if (amount > 0) token.transferFrom(msg.sender, address(this), amount);
    }

    /// @notice The bank invites up to `maxUses` people, minting `amount` to each when they join.
    function createMinting(address key, uint256 amount, uint32 maxUses, uint64 expiresAt) external onlyBank {
        if (maxUses == 0) revert InvalidUses();
        _store(key, Invite(msg.sender, expiresAt, true, maxUses, 0, amount));
    }

    /// @notice Called by the new account itself, in the batch that deploys it.
    function claim(address key, bytes calldata signature) external {
        Invite storage inv = invites[key];
        _checkClaim(inv, key, msg.sender, signature);
        joined[msg.sender] = true;
        inv.uses += 1;
        if (inv.minting) {
            token.mint(msg.sender, inv.amount);
        } else {
            openInvites[inv.creator] -= 1;
            if (inv.amount > 0) token.transfer(msg.sender, inv.amount);
        }
        emit InviteClaimed(key, msg.sender, inv.amount);
    }

    /// @notice Whether `account` could claim with this signature right now (for the server and the app).
    function claimable(address key, address account, bytes calldata signature) external view returns (bool) {
        try this.checkClaim(key, account, signature) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Reverts with the reason a claim would fail. External only so `claimable` can try it.
    function checkClaim(address key, address account, bytes calldata signature) external view {
        _checkClaim(invites[key], key, account, signature);
    }

    /// @notice The creator closes an open invite at any time; locked coins go back to them.
    function cancel(address key) external {
        if (invites[key].creator != msg.sender) revert OnlyCreator();
        _close(key);
    }

    /// @notice Anyone closes an expired invite, returning the locked coins to the creator.
    function refund(address key) external {
        if (invites[key].creator == address(0)) revert NoInvite();
        if (block.timestamp < invites[key].expiresAt) revert InviteNotExpired();
        _close(key);
    }

    /// @notice The digest the invite key signs for `account`.
    function claimDigest(address account) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(block.chainid, address(this), account)));
    }

    function _store(address key, Invite memory inv) private {
        if (key == address(0) || invites[key].creator != address(0)) revert InvalidKey();
        if (inv.expiresAt <= block.timestamp || inv.expiresAt > block.timestamp + MAX_DURATION) {
            revert InvalidDuration();
        }
        invites[key] = inv;
        emit InviteCreated(key, inv.creator, inv.amount, inv.maxUses, inv.minting, inv.expiresAt);
    }

    function _checkClaim(Invite storage inv, address key, address account, bytes calldata signature) private view {
        if (inv.creator == address(0)) revert NoInvite();
        if (inv.uses >= inv.maxUses) revert InviteClosedAlready();
        if (block.timestamp >= inv.expiresAt) revert InviteExpired();
        if (joined[account]) revert AlreadyJoined();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(claimDigest(account), signature);
        if (err != ECDSA.RecoverError.NoError || signer != key) revert InvalidSignature();
    }

    function _close(address key) private {
        Invite storage inv = invites[key];
        if (inv.uses >= inv.maxUses) revert InviteClosedAlready();
        inv.uses = inv.maxUses;
        uint256 refunded;
        if (!inv.minting) {
            openInvites[inv.creator] -= 1;
            refunded = inv.amount;
            if (refunded > 0) token.transfer(inv.creator, refunded);
        }
        emit InviteClosed(key, refunded);
    }
}
