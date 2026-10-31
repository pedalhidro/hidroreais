// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @title AllowanceMinter
/// @notice Example policy minter. The central bank grants this contract MINTER_ROLE on the
///         token, registers members, and sets a fixed allowance per epoch. Anyone can then
///         trigger claims (a member, the PWA, or a keeper), and each member receives at most
///         one allowance per epoch. A global cap per epoch bounds total issuance, so the
///         monetary rule is visible and enforced on-chain. Revoke MINTER_ROLE to end it.
contract AllowanceMinter {
    IMintable public immutable token;
    address public centralBank;

    uint256 public allowance; // tokens per member per epoch
    uint64 public epochLength; // seconds
    // Epochs are counted from an anchor that moves when the policy changes, so the epoch
    // number never goes backwards: epoch = epochBase + (now - anchorTime) / epochLength.
    uint64 public anchorTime;
    uint256 public epochBase;
    uint256 public epochCap; // max tokens minted by this contract per epoch

    mapping(address member => bool) public isMember;
    mapping(address member => uint256 epoch) public lastClaimedEpoch; // stored as epoch + 1
    mapping(uint256 epoch => uint256 minted) public mintedInEpoch;

    event MemberSet(address indexed member, bool enabled);
    event PolicySet(uint256 allowance, uint64 epochLength, uint256 epochCap);
    event Claimed(address indexed member, uint256 indexed epoch, uint256 amount);
    event CentralBankChanged(address indexed newCentralBank);

    error OnlyCentralBank();
    error NotMember();
    error AlreadyClaimed();
    error EpochCapReached();
    error InvalidPolicy();

    modifier onlyCentralBank() {
        if (msg.sender != centralBank) revert OnlyCentralBank();
        _;
    }

    constructor(IMintable token_, address centralBank_, uint256 allowance_, uint64 epochLength_, uint256 epochCap_) {
        if (epochLength_ == 0) revert InvalidPolicy();
        token = token_;
        centralBank = centralBank_;
        allowance = allowance_;
        epochLength = epochLength_;
        epochCap = epochCap_;
        anchorTime = uint64(block.timestamp);
        emit PolicySet(allowance_, epochLength_, epochCap_);
    }

    function currentEpoch() public view returns (uint256) {
        return epochBase + (block.timestamp - anchorTime) / epochLength;
    }

    function setMembers(address[] calldata members, bool enabled) external onlyCentralBank {
        for (uint256 i; i < members.length; ++i) {
            isMember[members[i]] = enabled;
            emit MemberSet(members[i], enabled);
        }
    }

    /// @dev The current epoch keeps its number and its claims; it ends `epochLength_` seconds
    ///      after this call, and later epochs use the new length.
    function setPolicy(uint256 allowance_, uint64 epochLength_, uint256 epochCap_) external onlyCentralBank {
        if (epochLength_ == 0) revert InvalidPolicy();
        epochBase = currentEpoch();
        anchorTime = uint64(block.timestamp);
        allowance = allowance_;
        epochLength = epochLength_;
        epochCap = epochCap_;
        emit PolicySet(allowance_, epochLength_, epochCap_);
    }

    function setCentralBank(address newCentralBank) external onlyCentralBank {
        centralBank = newCentralBank;
        emit CentralBankChanged(newCentralBank);
    }

    function canClaim(address member) public view returns (bool) {
        uint256 epoch = currentEpoch();
        return isMember[member] && lastClaimedEpoch[member] != epoch + 1
            && mintedInEpoch[epoch] + allowance <= epochCap;
    }

    function claim(address member) public {
        if (!isMember[member]) revert NotMember();
        uint256 epoch = currentEpoch();
        if (lastClaimedEpoch[member] == epoch + 1) revert AlreadyClaimed();
        uint256 minted = mintedInEpoch[epoch] + allowance;
        if (minted > epochCap) revert EpochCapReached();

        lastClaimedEpoch[member] = epoch + 1;
        mintedInEpoch[epoch] = minted;
        token.mint(member, allowance);
        emit Claimed(member, epoch, allowance);
    }

    /// @notice Claim for many members at once; skips anyone who cannot claim right now.
    function claimMany(address[] calldata members) external {
        for (uint256 i; i < members.length; ++i) {
            if (canClaim(members[i])) claim(members[i]);
        }
    }
}
