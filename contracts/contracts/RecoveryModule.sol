// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISafe {
    function isModuleEnabled(address module) external view returns (bool);
    function isOwner(address owner) external view returns (bool);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);
}

/// @title RecoveryModule
/// @notice One shared Safe module that makes the central bank the recovery guardian of every
///         member Safe that enables it. The guardian can add a new owner (a new passkey signer)
///         to a member Safe, optionally removing every other owner (lost or stolen devices).
///
///         With recoveryDelay == 0 (testing), a recovery executes immediately. With a delay
///         (production), it is queued; any existing owner of the Safe can cancel it during the
///         delay by having the Safe call cancelRecovery(), and anyone can execute it afterwards.
///         Raising the delay is a setting change, not a redeployment.
///
///         takeControl() is the guardian's coercive path: it replaces every owner at once,
///         ignoring the delay, and cannot be cancelled. It requires a public reason.
contract RecoveryModule {
    address internal constant SENTINEL = address(0x1);

    struct Recovery {
        address newOwner;
        bool removeOthers;
        uint64 executeAfter;
    }

    address public guardian; // the central bank Safe
    uint64 public recoveryDelay; // seconds; 0 while testing
    mapping(address safe => Recovery) public pending;

    event GuardianChanged(address indexed guardian);
    event RecoveryDelayChanged(uint64 delay);
    event RecoveryInitiated(address indexed safe, address indexed newOwner, bool removeOthers, uint64 executeAfter);
    event RecoveryExecuted(address indexed safe, address indexed newOwner, bool removeOthers);
    event RecoveryCancelled(address indexed safe);
    event ControlTaken(address indexed safe, address indexed newOwner, string reason);

    error OnlyGuardian();
    error ModuleNotEnabled();
    error InvalidOwner();
    error NoPendingRecovery();
    error RecoveryNotReady();
    error SafeCallFailed();
    error ReasonRequired();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert OnlyGuardian();
        _;
    }

    constructor(address guardian_, uint64 recoveryDelay_) {
        guardian = guardian_;
        recoveryDelay = recoveryDelay_;
        emit GuardianChanged(guardian_);
        emit RecoveryDelayChanged(recoveryDelay_);
    }

    function setGuardian(address newGuardian) external onlyGuardian {
        guardian = newGuardian;
        emit GuardianChanged(newGuardian);
    }

    function setRecoveryDelay(uint64 delay) external onlyGuardian {
        recoveryDelay = delay;
        emit RecoveryDelayChanged(delay);
    }

    /// @notice Start a recovery. Executes at once when the delay is zero.
    /// @param safe The member Safe to recover.
    /// @param newOwner The new owner, normally a SafeWebAuthnSignerProxy for the member's new passkey.
    /// @param removeOthers Remove every other owner, e.g. when a phone was stolen.
    function initiateRecovery(address safe, address newOwner, bool removeOthers) external onlyGuardian {
        if (!ISafe(safe).isModuleEnabled(address(this))) revert ModuleNotEnabled();
        if (newOwner == address(0) || newOwner == SENTINEL || newOwner == safe) revert InvalidOwner();

        if (recoveryDelay == 0) {
            delete pending[safe];
            _execute(safe, newOwner, removeOthers);
            emit RecoveryExecuted(safe, newOwner, removeOthers);
            return;
        }
        uint64 executeAfter = uint64(block.timestamp) + recoveryDelay;
        pending[safe] = Recovery(newOwner, removeOthers, executeAfter);
        emit RecoveryInitiated(safe, newOwner, removeOthers, executeAfter);
    }

    /// @notice Execute a queued recovery once its delay has passed. Callable by anyone.
    function executeRecovery(address safe) external {
        Recovery memory r = pending[safe];
        if (r.newOwner == address(0)) revert NoPendingRecovery();
        if (block.timestamp < r.executeAfter) revert RecoveryNotReady();
        delete pending[safe];
        _execute(safe, r.newOwner, r.removeOthers);
        emit RecoveryExecuted(safe, r.newOwner, r.removeOthers);
    }

    /// @notice Make `newOwner` the only owner of a member Safe, now. Unlike a recovery this
    ///         ignores the delay and the member cannot cancel it; a pending recovery is dropped.
    /// @param newOwner The bank itself (to hold the account) or a signer it chooses.
    function takeControl(address safe, address newOwner, string calldata reason) external onlyGuardian {
        if (bytes(reason).length == 0) revert ReasonRequired();
        if (!ISafe(safe).isModuleEnabled(address(this))) revert ModuleNotEnabled();
        if (newOwner == address(0) || newOwner == SENTINEL || newOwner == safe) revert InvalidOwner();
        delete pending[safe];
        _execute(safe, newOwner, true);
        emit ControlTaken(safe, newOwner, reason);
    }

    /// @notice Called by the member Safe itself (signed by any current owner) to cancel.
    function cancelRecovery() external {
        if (pending[msg.sender].newOwner == address(0)) revert NoPendingRecovery();
        delete pending[msg.sender];
        emit RecoveryCancelled(msg.sender);
    }

    function _execute(address safe, address newOwner, bool removeOthers) internal {
        ISafe s = ISafe(safe);
        if (!s.isOwner(newOwner)) {
            _call(s, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", newOwner, 1));
        } else if (s.getThreshold() != 1) {
            _call(s, abi.encodeWithSignature("changeThreshold(uint256)", 1));
        }

        if (removeOthers) {
            // Walk the owner list; removing an owner keeps `prev` pointing at the right node.
            address[] memory owners = s.getOwners();
            address prev = SENTINEL;
            for (uint256 i; i < owners.length; ++i) {
                if (owners[i] == newOwner) {
                    prev = owners[i];
                    continue;
                }
                _call(s, abi.encodeWithSignature("removeOwner(address,address,uint256)", prev, owners[i], 1));
            }
        }
    }

    function _call(ISafe s, bytes memory data) private {
        if (!s.execTransactionFromModule(address(s), 0, data, 0)) revert SafeCallFailed();
    }
}
