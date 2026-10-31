// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MemberDirectory
/// @notice Public phone book for the community. Each member Safe sets its own display name
///         and announces which passkeys control it.
///
///         WebAuthn returns a passkey's public key only when the passkey is created; a later
///         login returns just a credential ID. CredentialLinked events let any browser go from
///         keccak256(credentialId) to the passkey's public key, its signer contract and its
///         Safe. Entries are self-asserted by msg.sender, so clients must verify a candidate
///         before trusting it: the signer must be an owner of the Safe and must match (x, y).
contract MemberDirectory {
    uint256 public constant MAX_NAME_LENGTH = 32;

    mapping(address safe => string) public names;

    event NameSet(address indexed safe, string name);
    event CredentialLinked(
        bytes32 indexed credentialHash, address indexed safe, address signer, uint256 x, uint256 y
    );

    error NameTooLong();

    function setName(string calldata name) external {
        if (bytes(name).length > MAX_NAME_LENGTH) revert NameTooLong();
        names[msg.sender] = name;
        emit NameSet(msg.sender, name);
    }

    function linkCredential(bytes32 credentialHash, address signer, uint256 x, uint256 y) external {
        emit CredentialLinked(credentialHash, msg.sender, signer, x, y);
    }
}
