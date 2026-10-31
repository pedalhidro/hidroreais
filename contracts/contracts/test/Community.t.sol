// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/common/Enum.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {CommunityToken} from "../CommunityToken.sol";
import {AllowanceMinter, IMintable} from "../AllowanceMinter.sol";
import {RecoveryModule} from "../RecoveryModule.sol";
import {MemberDirectory} from "../MemberDirectory.sol";
import {Invites, IMintableToken} from "../Invites.sol";

contract CommunityTokenTest is Test {
    CommunityToken token;
    address bank = makeAddr("bank");
    uint256 aliceKey = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");
    address relayer = makeAddr("relayer");

    function setUp() public {
        alice = vm.addr(aliceKey);
        token = new CommunityToken("Community Coin", "COIN", bank);
        vm.prank(bank);
        token.mint(alice, 100 ether);
    }

    function test_typehashes() public view {
        assertEq(
            token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(
            token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            keccak256(
                "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(token.CANCEL_AUTHORIZATION_TYPEHASH(), keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"));
    }

    function test_onlyMinterMints() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, token.MINTER_ROLE())
        );
        vm.prank(bob);
        token.mint(bob, 1);

        bytes32 role = token.MINTER_ROLE();
        vm.prank(bank);
        token.grantRole(role, bob);
        vm.prank(bob);
        token.mint(bob, 5);
        assertEq(token.balanceOf(bob), 5);
    }

    function test_confiscateBurnsWithReason() public {
        vm.expectEmit(address(token));
        emit CommunityToken.Confiscated(alice, 40 ether, "assembly 12/10");
        vm.prank(bank);
        token.confiscate(alice, 40 ether, "assembly 12/10");
        assertEq(token.balanceOf(alice), 60 ether);
        assertEq(token.totalSupply(), 60 ether);
    }

    function test_forceTransfer() public {
        vm.expectEmit(address(token));
        emit CommunityToken.ForcedTransfer(alice, bob, 30 ether, "refund of a disputed sale");
        vm.prank(bank);
        token.forceTransfer(alice, bob, 30 ether, "refund of a disputed sale");
        assertEq(token.balanceOf(alice), 70 ether);
        assertEq(token.balanceOf(bob), 30 ether);
        assertEq(token.totalSupply(), 100 ether);
    }

    function test_enforcementNeedsRoleAndReason() public {
        bytes32 role = token.ENFORCER_ROLE();
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role));
        token.confiscate(alice, 1, "x");
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bob, role));
        token.forceTransfer(alice, bob, 1, "x");
        vm.stopPrank();

        vm.startPrank(bank);
        vm.expectRevert(CommunityToken.ReasonRequired.selector);
        token.confiscate(alice, 1, "");
        vm.expectRevert(CommunityToken.ReasonRequired.selector);
        token.forceTransfer(alice, bob, 1, "");
        vm.stopPrank();
    }

    function _sign(bytes32 typehash, address to, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, alice, to, value, 0, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_transferWithAuthorization() public {
        vm.warp(1000);
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 10 ether, 2000, nonce);

        vm.prank(relayer); // anyone can submit; the relayer pays the gas
        token.transferWithAuthorization(alice, bob, 10 ether, 0, 2000, nonce, sig);
        assertEq(token.balanceOf(bob), 10 ether);
        assertTrue(token.authorizationState(alice, nonce));

        vm.expectRevert(CommunityToken.AuthorizationAlreadyUsed.selector);
        token.transferWithAuthorization(alice, bob, 10 ether, 0, 2000, nonce, sig);
    }

    function test_transferWithAuthorization_rejectsTampering() public {
        vm.warp(1000);
        bytes32 nonce = keccak256("n2");
        bytes memory sig = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 10 ether, 2000, nonce);

        vm.expectRevert(CommunityToken.InvalidSignature.selector);
        token.transferWithAuthorization(alice, bob, 11 ether, 0, 2000, nonce, sig);

        vm.expectRevert(CommunityToken.InvalidSignature.selector);
        token.transferWithAuthorization(alice, relayer, 10 ether, 0, 2000, nonce, sig);

        vm.warp(2000);
        vm.expectRevert(CommunityToken.AuthorizationExpired.selector);
        token.transferWithAuthorization(alice, bob, 10 ether, 0, 2000, nonce, sig);
    }

    function test_receiveWithAuthorization_onlyPayee() public {
        vm.warp(1000);
        bytes32 nonce = keccak256("n3");
        bytes memory sig = _sign(token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), bob, 1 ether, 2000, nonce);

        vm.prank(relayer);
        vm.expectRevert(CommunityToken.CallerMustBePayee.selector);
        token.receiveWithAuthorization(alice, bob, 1 ether, 0, 2000, nonce, sig);

        vm.prank(bob);
        token.receiveWithAuthorization(alice, bob, 1 ether, 0, 2000, nonce, sig);
        assertEq(token.balanceOf(bob), 1 ether);
    }

    function test_cancelAuthorization() public {
        vm.warp(1000);
        bytes32 nonce = keccak256("n4");
        bytes memory transferSig = _sign(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1 ether, 2000, nonce);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(token.CANCEL_AUTHORIZATION_TYPEHASH(), alice, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        token.cancelAuthorization(alice, nonce, abi.encodePacked(r, s, v));

        vm.expectRevert(CommunityToken.AuthorizationAlreadyUsed.selector);
        token.transferWithAuthorization(alice, bob, 1 ether, 0, 2000, nonce, transferSig);
    }
}

contract AllowanceMinterTest is Test {
    CommunityToken token;
    AllowanceMinter minter;
    address bank = makeAddr("bank");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_000_000);
        token = new CommunityToken("Community Coin", "COIN", bank);
        minter = new AllowanceMinter(IMintable(address(token)), bank, 10 ether, 7 days, 20 ether);
        bytes32 role = token.MINTER_ROLE();
        vm.startPrank(bank);
        token.grantRole(role, address(minter));
        address[] memory members = new address[](3);
        (members[0], members[1], members[2]) = (alice, bob, carol);
        minter.setMembers(members, true);
        vm.stopPrank();
    }

    function test_oneClaimPerEpoch() public {
        minter.claim(alice);
        assertEq(token.balanceOf(alice), 10 ether);

        vm.expectRevert(AllowanceMinter.AlreadyClaimed.selector);
        minter.claim(alice);

        vm.warp(block.timestamp + 7 days);
        minter.claim(alice);
        assertEq(token.balanceOf(alice), 20 ether);
    }

    function test_epochCap() public {
        minter.claim(alice);
        minter.claim(bob);
        vm.expectRevert(AllowanceMinter.EpochCapReached.selector);
        minter.claim(carol);
    }

    function test_claimManySkipsIneligible() public {
        address[] memory list = new address[](4);
        (list[0], list[1], list[2], list[3]) = (alice, makeAddr("stranger"), bob, carol);
        minter.claimMany(list);
        assertEq(token.balanceOf(alice), 10 ether);
        assertEq(token.balanceOf(bob), 10 ether);
        assertEq(token.balanceOf(carol), 0); // cap reached
    }

    function test_policyChangeNeverMovesEpochBackwards() public {
        minter.claim(alice);
        vm.warp(block.timestamp + 3 days);
        uint256 before = minter.currentEpoch();

        vm.prank(bank);
        minter.setPolicy(10 ether, 30 days, 20 ether); // longer epochs
        assertEq(minter.currentEpoch(), before);
        vm.expectRevert(AllowanceMinter.AlreadyClaimed.selector);
        minter.claim(alice); // no double issuance in the same epoch

        vm.warp(block.timestamp + 30 days);
        assertEq(minter.currentEpoch(), before + 1);
        minter.claim(alice);
        assertEq(token.balanceOf(alice), 20 ether);
    }

    function test_onlyBankManages() public {
        address[] memory list = new address[](1);
        list[0] = makeAddr("x");
        vm.expectRevert(AllowanceMinter.OnlyCentralBank.selector);
        minter.setMembers(list, true);

        vm.expectRevert(AllowanceMinter.NotMember.selector);
        minter.claim(list[0]);
    }
}

contract RecoveryModuleTest is Test {
    Safe singleton;
    SafeProxyFactory factory;
    RecoveryModule module;

    address guardian = makeAddr("centralBank");
    uint256 ownerKey = 0xB0B;
    address owner;
    Safe memberSafe;

    function setUp() public {
        owner = vm.addr(ownerKey);
        singleton = new Safe();
        factory = new SafeProxyFactory();
        module = new RecoveryModule(guardian, 0);
        memberSafe = _deploySafe(owner, 1);
        _execAsOwner(memberSafe, address(memberSafe), abi.encodeCall(memberSafe.enableModule, (address(module))));
    }

    function _deploySafe(address firstOwner, uint256 salt) internal returns (Safe) {
        address[] memory owners = new address[](1);
        owners[0] = firstOwner;
        bytes memory init = abi.encodeCall(
            Safe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        return Safe(payable(address(factory.createProxyWithNonce(address(singleton), init, salt))));
    }

    function _ownerSignature(Safe safe, address to, bytes memory data) internal view returns (bytes memory) {
        bytes32 txHash = safe.getTransactionHash(
            to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, txHash);
        return abi.encodePacked(r, s, v);
    }

    function _execAsOwner(Safe safe, address to, bytes memory data) internal {
        bytes memory sig = _ownerSignature(safe, to, data);
        assertTrue(safe.execTransaction(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig));
    }

    function test_instantRecoveryWhileTesting() public {
        address newPasskey = makeAddr("newPasskeySigner");
        vm.expectEmit(address(module));
        emit RecoveryModule.RecoveryExecuted(address(memberSafe), newPasskey, false);
        vm.prank(guardian);
        module.initiateRecovery(address(memberSafe), newPasskey, false);

        assertTrue(memberSafe.isOwner(newPasskey));
        assertTrue(memberSafe.isOwner(owner));
        assertEq(memberSafe.getThreshold(), 1);
    }

    function test_recoveryRemovesOtherOwners() public {
        address extra1 = makeAddr("laptop");
        address extra2 = makeAddr("tablet");
        _execAsOwner(memberSafe, address(memberSafe), abi.encodeCall(memberSafe.addOwnerWithThreshold, (extra1, 1)));
        _execAsOwner(memberSafe, address(memberSafe), abi.encodeCall(memberSafe.addOwnerWithThreshold, (extra2, 1)));
        assertEq(memberSafe.getOwners().length, 3);

        address newPasskey = makeAddr("newPasskeySigner");
        vm.prank(guardian);
        module.initiateRecovery(address(memberSafe), newPasskey, true);

        address[] memory owners = memberSafe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], newPasskey);
        assertEq(memberSafe.getThreshold(), 1);
    }

    function test_recoveryKeepingExistingOwnerAsOnlyOwner() public {
        address extra = makeAddr("laptop");
        _execAsOwner(memberSafe, address(memberSafe), abi.encodeCall(memberSafe.addOwnerWithThreshold, (extra, 1)));
        // Re-use an owner that is not at the head of the list; everyone else is removed.
        vm.prank(guardian);
        module.initiateRecovery(address(memberSafe), owner, true);
        address[] memory owners = memberSafe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], owner);
    }

    function test_onlyGuardian() public {
        vm.expectRevert(RecoveryModule.OnlyGuardian.selector);
        module.initiateRecovery(address(memberSafe), makeAddr("x"), false);

        vm.expectRevert(RecoveryModule.OnlyGuardian.selector);
        module.setRecoveryDelay(1 days);
    }

    function test_requiresModuleEnabled() public {
        Safe other = _deploySafe(owner, 2);
        vm.prank(guardian);
        vm.expectRevert(RecoveryModule.ModuleNotEnabled.selector);
        module.initiateRecovery(address(other), makeAddr("x"), false);
    }

    function test_rejectsInvalidOwner() public {
        vm.startPrank(guardian);
        vm.expectRevert(RecoveryModule.InvalidOwner.selector);
        module.initiateRecovery(address(memberSafe), address(0), false);
        vm.expectRevert(RecoveryModule.InvalidOwner.selector);
        module.initiateRecovery(address(memberSafe), address(memberSafe), false);
        vm.stopPrank();
    }

    function test_delayedRecoveryQueuesThenExecutes() public {
        vm.prank(guardian);
        module.setRecoveryDelay(2 days);

        address newPasskey = makeAddr("newPasskeySigner");
        vm.prank(guardian);
        module.initiateRecovery(address(memberSafe), newPasskey, true);
        assertFalse(memberSafe.isOwner(newPasskey));

        vm.expectRevert(RecoveryModule.RecoveryNotReady.selector);
        module.executeRecovery(address(memberSafe));

        vm.warp(block.timestamp + 2 days);
        module.executeRecovery(address(memberSafe)); // anyone can execute
        assertTrue(memberSafe.isOwner(newPasskey));
        assertFalse(memberSafe.isOwner(owner));
    }

    function test_takeControlIgnoresDelayAndCannotBeCancelled() public {
        vm.prank(guardian);
        module.setRecoveryDelay(2 days);
        address laptop = makeAddr("laptop");
        _execAsOwner(memberSafe, address(memberSafe), abi.encodeCall(memberSafe.addOwnerWithThreshold, (laptop, 1)));
        // A pending recovery is dropped by the takeover.
        vm.prank(guardian);
        module.initiateRecovery(address(memberSafe), makeAddr("newPasskeySigner"), false);

        vm.expectEmit(address(module));
        emit RecoveryModule.ControlTaken(address(memberSafe), guardian, "stolen phone reported");
        vm.prank(guardian);
        module.takeControl(address(memberSafe), guardian, "stolen phone reported");

        address[] memory owners = memberSafe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], guardian);
        assertEq(memberSafe.getThreshold(), 1);

        // Nothing left for the old devices to cancel, and nothing queued to execute later.
        vm.expectRevert(RecoveryModule.NoPendingRecovery.selector);
        vm.prank(address(memberSafe));
        module.cancelRecovery();
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(RecoveryModule.NoPendingRecovery.selector);
        module.executeRecovery(address(memberSafe));
    }

    function test_takeControlNeedsGuardianAndReason() public {
        vm.expectRevert(RecoveryModule.OnlyGuardian.selector);
        module.takeControl(address(memberSafe), makeAddr("x"), "reason");

        vm.prank(guardian);
        vm.expectRevert(RecoveryModule.ReasonRequired.selector);
        module.takeControl(address(memberSafe), guardian, "");
    }

    function test_ownerCancelsDuringDelay() public {
        vm.prank(guardian);
        module.setRecoveryDelay(2 days);
        address attacker = makeAddr("attackerSigner");
        vm.prank(guardian);
        module.initiateRecovery(address(memberSafe), attacker, true);

        // The real owner signs a Safe transaction that calls cancelRecovery().
        _execAsOwner(memberSafe, address(module), abi.encodeCall(module.cancelRecovery, ()));

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(RecoveryModule.NoPendingRecovery.selector);
        module.executeRecovery(address(memberSafe));
        assertTrue(memberSafe.isOwner(owner));
        assertFalse(memberSafe.isOwner(attacker));
    }
}

contract MemberDirectoryTest is Test {
    MemberDirectory dir;

    function setUp() public {
        dir = new MemberDirectory();
    }

    function test_setName() public {
        address safe = makeAddr("safe");
        vm.prank(safe);
        dir.setName("Joana");
        assertEq(dir.names(safe), "Joana");

        vm.prank(safe);
        vm.expectRevert(MemberDirectory.NameTooLong.selector);
        dir.setName("a name that is much longer than thirty-two bytes");
    }

    function test_linkCredentialEmits() public {
        address safe = makeAddr("safe");
        bytes32 h = keccak256("credential-id");
        vm.expectEmit(address(dir));
        emit MemberDirectory.CredentialLinked(h, safe, address(0xBEEF), 1, 2);
        vm.prank(safe);
        dir.linkCredential(h, address(0xBEEF), 1, 2);
    }
}

contract InvitesTest is Test {
    CommunityToken token;
    Invites invites;
    address bank = makeAddr("bank");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        token = new CommunityToken("Hidroreais", "PHR", bank);
        invites = new Invites(IMintableToken(address(token)), bank, 2);
        bytes32 minter = token.MINTER_ROLE();
        vm.prank(bank);
        token.grantRole(minter, address(invites));
        vm.warp(1_000_000);
    }

    function _sig(uint256 keyPk, address account) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyPk, invites.claimDigest(account));
        return abi.encodePacked(r, s, v);
    }

    function _bankInvite(string memory label, uint256 amount, uint32 maxUses) internal returns (address key, uint256 pk) {
        return _bankLink(label, amount, maxUses, false);
    }

    function _bankLink(string memory label, uint256 amount, uint32 maxUses, bool openToMembers)
        internal
        returns (address key, uint256 pk)
    {
        (key, pk) = makeAddrAndKey(label);
        vm.prank(bank);
        invites.createMinting(key, amount, maxUses, uint64(block.timestamp + 1 days), openToMembers);
    }

    /// Alice joins with a bank invite that mints 10.
    function _aliceJoins() internal {
        (address key, uint256 pk) = _bankInvite("aliceInvite", 10 ether, 1);
        bytes memory sig = _sig(pk, alice); // before the prank: _sig makes a call of its own
        vm.prank(alice);
        invites.claim(key, sig);
    }

    function _memberInvite(string memory label, uint256 amount, uint64 duration) internal returns (address key, uint256 pk) {
        (key, pk) = makeAddrAndKey(label);
        vm.startPrank(alice);
        token.approve(address(invites), amount);
        invites.create(key, amount, uint64(block.timestamp) + duration);
        vm.stopPrank();
    }

    function test_bankInviteMintsUpToMaxUses() public {
        (address key, uint256 pk) = _bankInvite("event", 10 ether, 2);
        bytes memory forAlice = _sig(pk, alice);
        bytes memory forBob = _sig(pk, bob);
        vm.expectEmit(address(invites));
        emit Invites.InviteClaimed(key, alice, 10 ether);
        vm.prank(alice);
        invites.claim(key, forAlice);
        vm.prank(bob);
        invites.claim(key, forBob);
        assertEq(token.balanceOf(alice), 10 ether);
        assertEq(token.balanceOf(bob), 10 ether);
        assertTrue(invites.joined(bob));

        bytes memory sig = _sig(pk, carol);
        vm.prank(carol);
        vm.expectRevert(Invites.InviteClosedAlready.selector);
        invites.claim(key, sig);
    }

    function test_memberInviteLocksAndHandsOver() public {
        _aliceJoins();
        (address key, uint256 pk) = _memberInvite("gift", 4 ether, 1 hours);
        assertEq(token.balanceOf(alice), 6 ether);
        assertEq(invites.openInvites(alice), 1);

        bytes memory sig = _sig(pk, bob);
        vm.prank(bob);
        invites.claim(key, sig);
        assertEq(token.balanceOf(bob), 4 ether);
        assertEq(token.balanceOf(address(invites)), 0);
        assertEq(invites.openInvites(alice), 0);
    }

    function test_signatureIsForOneAccount() public {
        (address key, uint256 pk) = _bankInvite("event", 10 ether, 5);
        bytes memory forBob = _sig(pk, bob);
        assertTrue(invites.claimable(key, bob, forBob));
        assertFalse(invites.claimable(key, carol, forBob));

        // Carol copies Bob's signature: it does not work for her account.
        vm.prank(carol);
        vm.expectRevert(Invites.InvalidSignature.selector);
        invites.claim(key, forBob);

        (, uint256 otherPk) = makeAddrAndKey("someoneElse");
        bytes memory wrongKey = _sig(otherPk, carol);
        vm.prank(carol);
        vm.expectRevert(Invites.InvalidSignature.selector);
        invites.claim(key, wrongKey);
    }

    function test_membersCannotJoinAgain() public {
        _aliceJoins();
        (address key, uint256 pk) = _bankInvite("event", 10 ether, 5);
        bytes memory sig = _sig(pk, alice);
        assertFalse(invites.claimable(key, alice, sig));
        vm.prank(alice);
        vm.expectRevert(Invites.AlreadyJoined.selector);
        invites.claim(key, sig);
    }

    function test_expiredInviteRefundsTheCreator() public {
        _aliceJoins();
        (address key, uint256 pk) = _memberInvite("gift", 4 ether, 6 hours);

        vm.expectRevert(Invites.InviteNotExpired.selector);
        invites.refund(key);

        vm.warp(block.timestamp + 6 hours);
        bytes memory sig = _sig(pk, bob);
        vm.prank(bob);
        vm.expectRevert(Invites.InviteExpired.selector);
        invites.claim(key, sig);

        vm.expectEmit(address(invites));
        emit Invites.InviteClosed(key, 4 ether);
        vm.prank(carol); // anyone, e.g. the server's keeper
        invites.refund(key);
        assertEq(token.balanceOf(alice), 10 ether);
        assertEq(invites.openInvites(alice), 0);

        vm.expectRevert(Invites.InviteClosedAlready.selector);
        invites.refund(key);
    }

    function test_onlyTheCreatorCancels() public {
        _aliceJoins();
        (address key, uint256 pk) = _memberInvite("gift", 4 ether, 1 days);
        vm.prank(bob);
        vm.expectRevert(Invites.OnlyCreator.selector);
        invites.cancel(key);

        vm.prank(alice);
        invites.cancel(key);
        assertEq(token.balanceOf(alice), 10 ether);

        bytes memory sig = _sig(pk, bob);
        vm.prank(bob);
        vm.expectRevert(Invites.InviteClosedAlready.selector);
        invites.claim(key, sig);
    }

    function test_onlyMembersInviteAndOpenInvitesAreCapped() public {
        vm.prank(bob);
        vm.expectRevert(Invites.OnlyMembers.selector);
        invites.create(makeAddr("k0"), 0, uint64(block.timestamp + 1 hours));

        _aliceJoins();
        (address first,) = _memberInvite("free1", 0, 1 hours); // a gift is optional
        _memberInvite("free2", 0, 1 hours);
        vm.prank(alice);
        vm.expectRevert(Invites.TooManyOpenInvites.selector);
        invites.create(makeAddr("free3"), 0, uint64(block.timestamp + 1 hours));

        vm.prank(alice);
        invites.cancel(first);
        _memberInvite("free3", 0, 1 hours);
    }

    function test_durationAndKeyChecks() public {
        vm.startPrank(bank);
        vm.expectRevert(Invites.InvalidDuration.selector);
        invites.createMinting(makeAddr("k1"), 1, 1, uint64(block.timestamp), false);
        vm.expectRevert(Invites.InvalidDuration.selector);
        invites.createMinting(makeAddr("k1"), 1, 1, uint64(block.timestamp + 7 days + 1), false);
        vm.expectRevert(Invites.InvalidKey.selector);
        invites.createMinting(address(0), 1, 1, uint64(block.timestamp + 1 hours), false);
        vm.expectRevert(Invites.InvalidUses.selector);
        invites.createMinting(makeAddr("k1"), 1, 0, uint64(block.timestamp + 1 hours), false);
        invites.createMinting(makeAddr("k1"), 1, 1, uint64(block.timestamp + 7 days), false);
        vm.expectRevert(Invites.InvalidKey.selector);
        invites.createMinting(makeAddr("k1"), 1, 1, uint64(block.timestamp + 1 hours), false);
        vm.stopPrank();
    }

    function test_onlyBankMakesMintingInvites() public {
        _aliceJoins();
        vm.prank(alice);
        vm.expectRevert(Invites.OnlyBank.selector);
        invites.createMinting(makeAddr("k"), 1, 1, uint64(block.timestamp + 1 hours), false);
        vm.prank(alice);
        vm.expectRevert(Invites.OnlyBank.selector);
        invites.setMaxOpenPerMember(100);
    }

    function test_openLinkPaysMembersAndNewcomersOnceEach() public {
        _aliceJoins(); // 10
        (address key, uint256 pk) = _bankLink("drop", 5 ether, 10, true);
        bytes memory forAlice = _sig(pk, alice);
        bytes memory forBob = _sig(pk, bob);
        assertTrue(invites.claimable(key, alice, forAlice));

        vm.prank(alice); // an existing member
        invites.claim(key, forAlice);
        vm.prank(bob); // a newcomer, who joins with it
        invites.claim(key, forBob);
        assertEq(token.balanceOf(alice), 15 ether);
        assertEq(token.balanceOf(bob), 5 ether);
        assertTrue(invites.joined(bob));

        assertFalse(invites.claimable(key, alice, forAlice));
        vm.prank(alice);
        vm.expectRevert(Invites.AlreadyClaimed.selector);
        invites.claim(key, forAlice);
    }

    function test_importedMembersCanInviteAndAreKeptOutOfNewOnlyLinks() public {
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = carol;
        vm.prank(alice);
        vm.expectRevert(Invites.OnlyBank.selector);
        invites.importMembers(accounts);

        vm.expectEmit(address(invites));
        emit Invites.MemberImported(alice);
        vm.prank(bank);
        invites.importMembers(accounts);
        assertTrue(invites.joined(alice) && invites.joined(carol));

        // Imported members can invite...
        vm.prank(alice);
        invites.create(makeAddr("gift"), 0, uint64(block.timestamp + 1 hours));
        // ...and new-only links refuse them.
        (address key, uint256 pk) = _bankInvite("newOnly", 5 ether, 10);
        bytes memory sig = _sig(pk, carol);
        vm.prank(carol);
        vm.expectRevert(Invites.AlreadyJoined.selector);
        invites.claim(key, sig);
    }
}
