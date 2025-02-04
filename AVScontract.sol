// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.26;

import "@eigenlayer/contracts/libraries/BytesLib.sol";
import "@eigenlayer/contracts/core/DelegationManager.sol";
import "@eigenlayer/contracts/permissions/Pausable.sol";
import "@eigenlayer-middleware/src/unaudited/ECDSAServiceManagerBase.sol";
import "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import {IRegistryCoordinator} from "@eigenlayer-middleware/src/interfaces/IRegistryCoordinator.sol";
import {ECDSAUpgradeable} from "@openzeppelin-upgrades/contracts/utils/cryptography/ECDSAUpgradeable.sol";
import {OperatorAllowlist} from "./OperatorAllowlist.sol";

/**
 * @title Decentralized Proof-of-Existence (PoE) Service
 * @author Your Name
 * @notice A decentralized service for timestamping and proving the existence of documents/data.
 */
contract ProofOfExistence is ECDSAServiceManagerBase, OperatorAllowlist {
    using BytesLib for bytes;
    using ECDSAUpgradeable for bytes32;

    // EVENTS
    event DocumentTimestamped(uint32 indexed taskIndex, bytes32 documentHash, uint32 timestamp);
    event DocumentVerified(uint32 indexed taskIndex, bytes32 documentHash, address operator);

    // STRUCTS
    struct Task {
        bytes32 documentHash; // Hash of the document/data
        uint32 timestamp;     // Block number when the document was timestamped
    }

    /* STORAGE */
    uint32 public latestTaskNum; // Tracks the latest task index
    mapping(uint32 => bytes32) public allTaskHashes; // Maps task indices to task hashes
    mapping(address => mapping(uint32 => bytes)) public allTaskResponses; // Stores operator responses

    /* MODIFIERS */
    modifier onlyOperator() {
        require(ECDSAStakeRegistry(stakeRegistry).operatorRegistered(msg.sender), "Operator must be the caller");
        _;
    }

    constructor(address __avsDirectory, address __stakeRegistry, address __delegationManager)
        ECDSAServiceManagerBase(
            __avsDirectory,
            __stakeRegistry,
            address(0), // No payment handling needed
            __delegationManager
        )
    {}

    function initialize(address initialOwner_, address rewardsInitiator_, address allowlistManager_)
        external
        initializer
    {
        __ServiceManagerBase_init(initialOwner_, rewardsInitiator_);
        __OperatorAllowlist_init(allowlistManager_, true);
    }

    /* FUNCTIONS */
    /**
     * @notice Submit a document hash for timestamping.
     * @param documentHash The hash of the document/data to be timestamped.
     */
    function submitDocument(bytes32 documentHash) external {
        // Create a new task
        Task memory newTask;
        newTask.documentHash = documentHash;
        newTask.timestamp = uint32(block.number);

        // Store the task hash and emit an event
        allTaskHashes[latestTaskNum] = keccak256(abi.encode(newTask));
        emit DocumentTimestamped(latestTaskNum, documentHash, newTask.timestamp);
        latestTaskNum++;
    }

    /**
     * @notice Operators validate and respond to document submissions.
     * @param task The task containing the document hash and timestamp.
     * @param referenceTaskIndex The index of the task being responded to.
     * @param signature The operator's signature to prove authenticity.
     */
    function validateDocument(Task calldata task, uint32 referenceTaskIndex, bytes calldata signature)
        external
        onlyOperator
    {
        require(operatorHasMinimumWeight(msg.sender), "Operator does not meet the weight requirements");

        // Verify the task matches the stored hash
        require(
            keccak256(abi.encode(task)) == allTaskHashes[referenceTaskIndex],
            "Supplied task does not match the one recorded in the contract"
        );

        // Ensure the operator hasn't already responded
        require(
            allTaskResponses[msg.sender][referenceTaskIndex].length == 0,
            "Operator has already responded to the task"
        );

        // Verify the operator's signature
        bytes32 messageHash = keccak256(abi.encodePacked("Validate: ", task.documentHash));
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();
        address signer = ethSignedMessageHash.recover(signature);
        require(signer == msg.sender, "Message signer is not the operator");

        // Store the response and emit an event
        allTaskResponses[msg.sender][referenceTaskIndex] = signature;
        emit DocumentVerified(referenceTaskIndex, task.documentHash, msg.sender);
    }

    /**
     * @notice Check if an operator meets the minimum staking requirements.
     * @param operator The address of the operator.
     */
    function operatorHasMinimumWeight(address operator) public view returns (bool) {
        return ECDSAStakeRegistry(stakeRegistry).getOperatorWeight(operator)
            >= ECDSAStakeRegistry(stakeRegistry).minimumWeight();
    }
}