const ethers = require('ethers')
const BigNum = require('bignumber.js')

import * as _lib from './_lib/lib.js'
const encodeCall = require('../utils/encodeCall')

const Registry = artifacts.require('Registry')
const AudiusToken = artifacts.require('AudiusToken')
const AdminUpgradeabilityProxy = artifacts.require('AdminUpgradeabilityProxy')
const Staking = artifacts.require('Staking')
const Governance = artifacts.require('Governance')
const ServiceTypeManager = artifacts.require('ServiceTypeManager')
const ServiceProviderFactory = artifacts.require('ServiceProviderFactory')
const DelegateManager = artifacts.require('DelegateManager')
const ClaimsManager = artifacts.require('ClaimsManager')
const TestContract = artifacts.require('TestContract')

const stakingProxyKey = web3.utils.utf8ToHex('StakingProxy')
const serviceProviderFactoryKey = web3.utils.utf8ToHex('ServiceProviderFactory')
const serviceTypeManagerProxyKey = web3.utils.utf8ToHex('ServiceTypeManagerProxy')
const claimsManagerProxyKey = web3.utils.utf8ToHex('ClaimsManagerProxy')
const governanceKey = web3.utils.utf8ToHex('Governance')
const delegateManagerKey = web3.utils.utf8ToHex('DelegateManagerKey')

const EMPTY_STRING = ''

const toBN = val => web3.utils.toBN(val)

const fromBN = val => val.toNumber()

const audToWei = val => web3.utils.toWei(val.toString(), 'ether')

const audToWeiBN = aud => toBN(audToWei(aud))

const abiEncode = (types, values) => {
  const abi = new ethers.utils.AbiCoder()
  return abi.encode(types, values)
}

const abiDecode = (types, data) => {
  const abi = new ethers.utils.AbiCoder()
  return abi.decode(types, data)
}

const keccak256 = (values) => {
  return ethers.utils.keccak256(values);
}

const Outcome = Object.freeze({
  InProgress: 0,
  No: 1,
  Yes: 2,
  Invalid: 3,
  TxFailed: 4
})

const Vote = Object.freeze({
  None: 0,
  No: 1,
  Yes: 2
})

contract('Governance.sol', async (accounts) => {
  let token, registry, staking0, staking, proxy, claimsManager0, claimsManagerProxy
  let serviceProviderFactory, claimsManager, delegateManager, governance

  const votingPeriod = 10
  const votingQuorum = 1
  const [treasuryAddress, proxyAdminAddress, proxyDeployerAddress] = accounts
  const protocolOwnerAddress = treasuryAddress
  const testDiscProvType = web3.utils.utf8ToHex('discovery-provider')
  const testEndpoint1 = 'https://localhost:5000'
  const testEndpoint2 = 'https://localhost:5001'

  const registerServiceProvider = async (type, endpoint, amount, account) => {
    // Approve staking transfer
    await token.approve(staking.address, amount, { from: account })

    const tx = await serviceProviderFactory.register(
      type,
      endpoint,
      amount,
      account,
      { from: account }
    )

    const args = tx.logs.find(log => log.event === 'RegisteredServiceProvider').args
    args.stakeAmount = args._stakeAmount
    args.spID = args._spID
    return args
  }

  /**
   * Deploy Registry, AdminUpgradeabilityProxy, AudiusToken, Staking, and Governance contracts.
   */
  beforeEach(async () => {
    token = await AudiusToken.new({ from: treasuryAddress })
    await token.initialize()
    registry = await Registry.new({ from: treasuryAddress })
    await registry.initialize()

    // Create initialization data
    let stakingInitializeData = encodeCall(
      'initialize',
      ['address', 'address', 'address', 'bytes32', 'bytes32', 'bytes32'],
      [
        token.address,
        treasuryAddress,
        registry.address,
        claimsManagerProxyKey,
        delegateManagerKey,
        serviceProviderFactoryKey
      ]
    )
    // Set up staking
    staking0 = await Staking.new({ from: proxyAdminAddress })
    proxy = await AdminUpgradeabilityProxy.new(
      staking0.address,
      proxyAdminAddress,
      stakingInitializeData,
      { from: proxyDeployerAddress }
    )
    staking = await Staking.at(proxy.address)
    await registry.addContract(stakingProxyKey, proxy.address, { from: treasuryAddress })

    // Deploy service type manager
    let controllerAddress = accounts[9]
    let serviceTypeInitializeData = encodeCall(
      'initialize',
      ['address', 'address', 'bytes32'],
      [registry.address, controllerAddress, governanceKey]
    )
    let serviceTypeManager0 = await ServiceTypeManager.new({ from: treasuryAddress })
    let serviceTypeManagerProxy = await AdminUpgradeabilityProxy.new(
      serviceTypeManager0.address,
      proxyAdminAddress,
      serviceTypeInitializeData,
      { from: proxyAdminAddress }
    )
    await registry.addContract(serviceTypeManagerProxyKey, serviceTypeManagerProxy.address, { from: treasuryAddress })
    let serviceTypeManager = await ServiceTypeManager.at(serviceTypeManagerProxy.address)
    // Register discovery provider
    await serviceTypeManager.addServiceType(
      testDiscProvType,
      audToWeiBN(5),
      audToWeiBN(10000000),
      { from: controllerAddress })

    // Deploy + Register ServiceProviderFactory contract
    let serviceProviderFactory0 = await ServiceProviderFactory.new({ from: treasuryAddress })
    const serviceProviderFactoryCalldata = encodeCall(
      'initialize',
      ['address', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [registry.address, stakingProxyKey, delegateManagerKey, governanceKey, serviceTypeManagerProxyKey]
    )
    let serviceProviderFactoryProxy = await AdminUpgradeabilityProxy.new(
      serviceProviderFactory0.address,
      proxyAdminAddress,
      serviceProviderFactoryCalldata,
      { from: proxyAdminAddress }
    )
    serviceProviderFactory = await ServiceProviderFactory.at(serviceProviderFactoryProxy.address)
    await registry.addContract(serviceProviderFactoryKey, serviceProviderFactoryProxy.address, { from: treasuryAddress })

    // Deploy + register claimsManagerProxy
    claimsManager0 = await ClaimsManager.new({ from: proxyDeployerAddress })
    const claimsInitializeCallData = encodeCall(
      'initialize',
      ['address', 'address', 'bytes32', 'bytes32', 'bytes32'],
      [token.address, registry.address, stakingProxyKey, serviceProviderFactoryKey, delegateManagerKey]
    )
    claimsManagerProxy = await AdminUpgradeabilityProxy.new(
      claimsManager0.address,
      proxyAdminAddress,
      claimsInitializeCallData,
      { from: proxyDeployerAddress }
    )
    claimsManager = await ClaimsManager.at(claimsManagerProxy.address)
    await registry.addContract(
      claimsManagerProxyKey,
      claimsManagerProxy.address,
      { from: protocolOwnerAddress }
    )

    // Register new contract as a minter, from the same address that deployed the contract
    await token.addMinter(claimsManager.address, { from: protocolOwnerAddress })

    // Deploy Governance contract
    governance = await Governance.new()
    await governance.initialize(
      registry.address,
      stakingProxyKey,
      votingPeriod,
      votingQuorum
    )
    await registry.addContract(governanceKey, governance.address, { from: protocolOwnerAddress })

    // Deploy DelegateManager contract
    const delegateManagerInitializeData = encodeCall(
      'initialize',
      ['address', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [token.address, registry.address, governanceKey, stakingProxyKey, serviceProviderFactoryKey, claimsManagerProxyKey]
    )
    let delegateManager0 = await DelegateManager.new({ from: proxyDeployerAddress })
    let delegateManagerProxy = await AdminUpgradeabilityProxy.new(
      delegateManager0.address,
      proxyAdminAddress,
      delegateManagerInitializeData,
      { from: proxyDeployerAddress }
    )
    delegateManager = await DelegateManager.at(delegateManagerProxy.address)
    await registry.addContract(delegateManagerKey, delegateManagerProxy.address, { from: protocolOwnerAddress })
  })

  describe('Slash proposal', async () => {
    const defaultStakeAmount = audToWeiBN(1000)
    const proposalDescription = "TestDescription"
    const stakerAccount1 = accounts[10]
    const stakerAccount2 = accounts[11]
    const delegatorAccount1 = accounts[12]
    
    beforeEach(async () => {
      // Transfer 1000 tokens to stakerAccount1, stakerAccount2, and delegatorAccount1
      await token.transfer(stakerAccount1, defaultStakeAmount, { from: treasuryAddress })
      await token.transfer(stakerAccount2, defaultStakeAmount, { from: treasuryAddress })
      await token.transfer(delegatorAccount1, defaultStakeAmount, { from: treasuryAddress })

      // Record initial staker account token balance
      const initialBalance = await token.balanceOf(stakerAccount1)

      // Register two SPs with stake
      const tx1 = await registerServiceProvider(
        testDiscProvType,
        testEndpoint1,
        defaultStakeAmount,
        stakerAccount1
      )
      await registerServiceProvider(
        testDiscProvType,
        testEndpoint2,
        defaultStakeAmount,
        stakerAccount2
      )

      // Confirm event has correct amount
      assert.isTrue(tx1.stakeAmount.eq(defaultStakeAmount))

      // Confirm new token balances
      const finalBalance = await token.balanceOf(stakerAccount1)
      assert.isTrue(
        initialBalance.eq(
          finalBalance.add(defaultStakeAmount)
        ),
        "Expected initialBalance == finalBalance + defaultStakeAmount"
      )
    })

    it('Initial state - Ensure no Proposals exist yet', async () => {
      await _lib.assertRevert(governance.getProposalById(0), 'Must provide valid non-zero _proposalId')
      await _lib.assertRevert(governance.getProposalById(1), 'Must provide valid non-zero _proposalId')
    })

    it('Should fail to Submit Proposal for unregistered target contract', async () => {
      const proposerAddress = accounts[10]
      const slashAmount = toBN(1)
      const targetAddress = accounts[11]
      const targetContractRegistryKey = web3.utils.utf8ToHex("blahblah")
      const callValue = toBN(0)
      const signature = 'slash(uint256,address)'
      const callData = abiEncode(['uint256', 'address'], [fromBN(slashAmount), targetAddress])

      await _lib.assertRevert(
        governance.submitProposal(
          targetContractRegistryKey,
          callValue,
          signature,
          callData,
          proposalDescription,
          { from: proposerAddress }
        ),
        "_targetContractRegistryKey must point to valid registered contract"
      )
    })

    it('Submit Proposal for Slash', async () => {
      const proposalId = 1
      const proposerAddress = accounts[10]
      const slashAmount = toBN(1)
      const targetAddress = accounts[11]
      const lastBlock = (await _lib.getLatestBlock(web3)).number
      const targetContractRegistryKey = delegateManagerKey
      const targetContractAddress = delegateManager.address
      const callValue = toBN(0)
      const signature = 'slash(uint256,address)'
      const callData = abiEncode(['uint256', 'address'], [slashAmount.toNumber(), targetAddress])

      // Call submitProposal
      const txReceipt = await governance.submitProposal(
        targetContractRegistryKey,
        callValue,
        signature,
        callData,
        proposalDescription,
        { from: proposerAddress }
      )

      // Confirm event log
      const txParsed = _lib.parseTx(txReceipt)
      assert.equal(txParsed.event.name, 'ProposalSubmitted', 'Expected same event name')
      assert.equal(parseInt(txParsed.event.args.proposalId), proposalId, 'Expected same event.args.proposalId')
      assert.equal(txParsed.event.args.proposer, proposerAddress, 'Expected same event.args.proposer')
      assert.isTrue(parseInt(txParsed.event.args.startBlockNumber) > lastBlock, 'Expected event.args.startBlockNumber > lastBlock')
      assert.equal(txParsed.event.args.description, proposalDescription, "Expected same event.args.description")

      // Call getProposalById() and confirm same values
      const proposal = await governance.getProposalById.call(proposalId)
      assert.equal(parseInt(proposal.proposalId), proposalId, 'Expected same proposalId')
      assert.equal(proposal.proposer, proposerAddress, 'Expected same proposer')
      assert.isTrue(parseInt(proposal.startBlockNumber) > lastBlock, 'Expected startBlockNumber > lastBlock')
      assert.equal(_lib.toStr(proposal.targetContractRegistryKey), _lib.toStr(targetContractRegistryKey), 'Expected same proposal.targetContractRegistryKey')
      assert.equal(proposal.targetContractAddress, targetContractAddress, 'Expected same proposal.targetContractAddress')
      assert.equal(proposal.callValue.toNumber(), callValue, 'Expected same proposal.callValue')
      assert.equal(proposal.signature, signature, 'Expected same proposal.signature')
      assert.equal(proposal.callData, callData, 'Expected same proposal.callData')
      assert.equal(proposal.outcome, Outcome.InProgress, 'Expected same outcome')
      assert.equal(parseInt(proposal.voteMagnitudeYes), 0, 'Expected same voteMagnitudeYes')
      assert.equal(parseInt(proposal.voteMagnitudeNo), 0, 'Expected same voteMagnitudeNo')
      assert.equal(parseInt(proposal.numVotes), 0, 'Expected same numVotes')

      // Confirm all vote states - all Vote.None
      for (const account of accounts) {
        const vote = await governance.getVoteByProposalAndVoter.call(proposalId, account)
        assert.equal(vote, Vote.None)
      }
    })

    it('Vote on Proposal for Slash', async () => {
      const proposalId = 1
      const proposerAddress = stakerAccount1
      const slashAmount = toBN(1)
      const targetAddress = stakerAccount2
      const voterAddress = stakerAccount1
      const vote = Vote.No
      const defaultVote = Vote.None
      const lastBlock = (await _lib.getLatestBlock(web3)).number
      const targetContractRegistryKey = delegateManagerKey
      const targetContractAddress = delegateManager.address
      const callValue = toBN(0)
      const signature = 'slash(uint256,address)'
      const callData = abiEncode(['uint256', 'address'], [fromBN(slashAmount), targetAddress])

      // Call submitProposal
      await governance.submitProposal(
        targetContractRegistryKey,
        callValue,
        signature,
        callData,
        proposalDescription,
        { from: proposerAddress }
      )

      // Call submitProposalVote()
      const txReceipt = await governance.submitProposalVote(proposalId, vote, { from: voterAddress })

      // Confirm event log
      const txParsed = _lib.parseTx(txReceipt)
      assert.equal(txParsed.event.name, 'ProposalVoteSubmitted', 'Expected same event name')
      assert.equal(parseInt(txParsed.event.args.proposalId), proposalId, 'Expected same event.args.proposalId')
      assert.equal(txParsed.event.args.voter, voterAddress, 'Expected same event.args.voter')
      assert.equal(parseInt(txParsed.event.args.vote), vote, 'Expected same event.args.vote')
      assert.isTrue(txParsed.event.args.voterStake.eq(defaultStakeAmount), 'Expected same event.args.voterStake')
      assert.equal(parseInt(txParsed.event.args.previousVote), defaultVote, 'Expected same event.args.previousVote')

      // Call getProposalById() and confirm same values
      const proposal = await governance.getProposalById.call(proposalId)
      assert.equal(parseInt(proposal.proposalId), proposalId, 'Expected same proposalId')
      assert.equal(proposal.proposer, proposerAddress, 'Expected same proposer')
      assert.isTrue(proposal.startBlockNumber > lastBlock, 'Expected startBlockNumber > lastBlock')
      assert.equal(_lib.toStr(proposal.targetContractRegistryKey), _lib.toStr(targetContractRegistryKey), 'Expected same proposal.targetContractRegistryKey')
      assert.equal(proposal.targetContractAddress, targetContractAddress, 'Expected same proposal.targetContractAddress')
      assert.isTrue(proposal.callValue.eq(callValue), 'Expected same proposal.callValue')
      assert.equal(proposal.signature, signature, 'Expected same proposal.signature')
      assert.equal(proposal.callData, callData, 'Expected same proposal.callData')
      assert.equal(proposal.outcome, Outcome.InProgress, 'Expected same outcome')
      assert.isTrue(proposal.voteMagnitudeYes.isZero(), 'Expected same voteMagnitudeYes')
      assert.isTrue(proposal.voteMagnitudeNo.eq(defaultStakeAmount), 'Expected same voteMagnitudeNo')
      assert.equal(parseInt(proposal.numVotes), 1, 'Expected same numVotes')

      // Confirm all vote states - Vote.No for Voter, Vote.None for all others
      for (const account of accounts) {
        const voterVote = await governance.getVoteByProposalAndVoter.call(proposalId, account)
        if (account == voterAddress) {
          assert.equal(voterVote, vote)
        } else {
          assert.equal(voterVote, defaultVote)
        }
      }
    })

    describe('Proposal evaluation', async () => {
      let proposalId, proposerAddress, slashAmountNum, slashAmount, targetAddress, voterAddress, vote, defaultVote
      let lastBlock, targetContractRegistryKey, targetContractAddress, callValue, signature, callData
      let outcome, txHash, returnData, initialTotalStake, initialStakeAcct2, initialTokenSupply
      let submitProposalTxReceipt, proposalStartBlockNumber, evaluateTxReceipt

      /** Define vars, submit proposal, submit votes, advance blocks */
      beforeEach(async () => {
        // Define vars
        proposalId = 1
        proposerAddress = stakerAccount1
        slashAmountNum = audToWei(500)
        slashAmount = toBN(slashAmountNum)
        targetAddress = stakerAccount2
        voterAddress = stakerAccount1
        vote = Vote.Yes
        defaultVote = Vote.None
        lastBlock = (await _lib.getLatestBlock(web3)).number
        targetContractRegistryKey = delegateManagerKey
        targetContractAddress = delegateManager.address
        callValue = audToWei(0)
        signature = 'slash(uint256,address)'
        callData = abiEncode(['uint256', 'address'], [slashAmountNum, targetAddress])
        outcome = Outcome.Yes 
        txHash = keccak256(
          abiEncode(
            ['address', 'uint256', 'string', 'bytes'],
            [targetContractAddress, callValue, signature, callData]
          )
        )
        returnData = null
  
        // Confirm initial Stake state
        initialTotalStake = await staking.totalStaked()
        assert.isTrue(initialTotalStake.eq(defaultStakeAmount.mul(toBN(2))))
        initialStakeAcct2 = await staking.totalStakedFor(targetAddress)
        assert.isTrue(initialStakeAcct2.eq(defaultStakeAmount))
        initialTokenSupply = await token.totalSupply()
  
        // Call submitProposal + submitProposalVote
        submitProposalTxReceipt = await governance.submitProposal(
          targetContractRegistryKey,
          callValue,
          signature,
          callData,
          proposalDescription,
          { from: proposerAddress }
        )
        await governance.submitProposalVote(proposalId, vote, { from: voterAddress })
  
        // Advance blocks to the next valid claim
        proposalStartBlockNumber = parseInt(_lib.parseTx(submitProposalTxReceipt).event.args.startBlockNumber)
        await _lib.advanceToTargetBlock(proposalStartBlockNumber + votingPeriod, web3)
      })

      it('Confirm proposal evaluated correctly + transaction executed', async () => {
        // Call evaluateProposalOutcome()
        evaluateTxReceipt = await governance.evaluateProposalOutcome(proposalId, { from: proposerAddress })
        
        // Confirm event logs (2 events)
        const [txParsedEvent0, txParsedEvent1] = _lib.parseTx(evaluateTxReceipt, true)
        assert.equal(txParsedEvent0.event.name, 'TransactionExecuted', 'Expected same event name')
        assert.equal(txParsedEvent0.event.args.proposalId, proposalId, 'Expected same txParsedEvent0.event.args.txHash')
        assert.equal(txParsedEvent0.event.args.txHash, txHash, 'Expected same txParsedEvent0.event.args.txHash')
        assert.equal(txParsedEvent0.event.args.success, true, 'Expected same txParsedEvent0.event.args.returnData')
        assert.equal(txParsedEvent0.event.args.returnData, returnData, 'Expected same txParsedEvent0.event.args.returnData')
        assert.equal(txParsedEvent1.event.name, 'ProposalOutcomeEvaluated', 'Expected same event name')
        assert.equal(parseInt(txParsedEvent1.event.args.proposalId), proposalId, 'Expected same event.args.proposalId')
        assert.equal(txParsedEvent1.event.args.outcome, outcome, 'Expected same event.args.outcome')
        assert.isTrue(txParsedEvent1.event.args.voteMagnitudeYes.eq(defaultStakeAmount), 'Expected same event.args.voteMagnitudeYes')
        assert.isTrue(txParsedEvent1.event.args.voteMagnitudeNo.isZero(), 'Expected same event.args.voteMagnitudeNo')
        assert.equal(parseInt(txParsedEvent1.event.args.numVotes), 1, 'Expected same event.args.numVotes')
  
        // Call getProposalById() and confirm same values
        const proposal = await governance.getProposalById.call(proposalId)
        assert.equal(parseInt(proposal.proposalId), proposalId, 'Expected same proposalId')
        assert.equal(proposal.proposer, proposerAddress, 'Expected same proposer')
        assert.isTrue(parseInt(proposal.startBlockNumber) > lastBlock, 'Expected startBlockNumber > lastBlock')
        assert.equal(_lib.toStr(proposal.targetContractRegistryKey), _lib.toStr(targetContractRegistryKey), 'Expected same proposal.targetContractRegistryKey')
        assert.equal(proposal.targetContractAddress, targetContractAddress, 'Expected same proposal.targetContractAddress')
        assert.equal(fromBN(proposal.callValue), callValue, 'Expected same proposal.callValue')
        assert.equal(proposal.signature, signature, 'Expected same proposal.signature')
        assert.equal(proposal.callData, callData, 'Expected same proposal.callData')
        assert.equal(proposal.outcome, outcome, 'Expected same outcome')
        assert.equal(parseInt(proposal.voteMagnitudeYes), defaultStakeAmount, 'Expected same voteMagnitudeYes')
        assert.equal(parseInt(proposal.voteMagnitudeNo), 0, 'Expected same voteMagnitudeNo')
        assert.equal(parseInt(proposal.numVotes), 1, 'Expected same numVotes')
  
        // Confirm all vote states - Vote.No for Voter, Vote.None for all others
        for (const account of accounts) {
          const voterVote = await governance.getVoteByProposalAndVoter.call(proposalId, account)
          if (account == voterAddress) {
            assert.equal(voterVote, vote)
          } else {
            assert.equal(voterVote, defaultVote)
          }
        }
  
        // Confirm Slash action succeeded by checking new Stake + Token values
        const finalStakeAcct2 = await staking.totalStakedFor(targetAddress)
        assert.isTrue(
          finalStakeAcct2.eq(defaultStakeAmount.sub(web3.utils.toBN(slashAmount)))
        )
        assert.isTrue(
          (web3.utils.toBN(initialTotalStake)).sub(web3.utils.toBN(slashAmount)).eq(await staking.totalStaked()),
          'Expected same total stake amount'
        )
        assert.equal(
          await token.totalSupply(),
          initialTokenSupply - slashAmount,
          "Expected same token total supply"
        )
      })
  
      it('Confirm Repeated evaluateProposal call fails', async () => {
        // Call evaluateProposalOutcome()
        evaluateTxReceipt = await governance.evaluateProposalOutcome(proposalId, { from: proposerAddress })
        
        await _lib.assertRevert(
          governance.evaluateProposalOutcome(proposalId, { from: proposerAddress }),
          "Governance::evaluateProposalOutcome:Proposal has already been evaluated."
        )
      })

      it('evaluateProposal fails after targetContract has been upgraded', async () => {
        const testContract = await TestContract.new()
        await testContract.initialize(registry.address)

        // Upgrade contract registered at targetContractRegistryKey
        await registry.upgradeContract(targetContractRegistryKey, testContract.address)
        
        await _lib.assertRevert(
          // Call evaluateProposalOutcome()
          governance.evaluateProposalOutcome(proposalId, { from: proposerAddress }),
          "Registered contract address for targetContractRegistryKey has changed"
        )
      })

      it('Call evaluateProposal where transaction execution fails', async () => {
        initialStakeAcct2 = await staking.totalStakedFor(targetAddress)
        assert.isTrue(initialStakeAcct2.eq(defaultStakeAmount))

        // Reduce stake amount below proposed slash amount
        const decreaseStakeAmount = audToWeiBN(700)
        await serviceProviderFactory.decreaseStake(
          decreaseStakeAmount,
          { from: stakerAccount2 }
        )
        const decreasedStakeAcct2 = await staking.totalStakedFor.call(stakerAccount2)
        assert.isTrue(decreasedStakeAcct2.eq(initialStakeAcct2.sub(decreaseStakeAmount)))

        // Call evaluateProposalOutcome and confirm that transaction execution failed and proposal outcome is No.
        evaluateTxReceipt = await governance.evaluateProposalOutcome(proposalId, { from: proposerAddress })
        
        // Confirm event logs (2 events)
        const [txParsedEvent0, txParsedEvent1] = _lib.parseTx(evaluateTxReceipt, true)
        assert.equal(txParsedEvent0.event.name, 'TransactionExecuted', 'Expected same event name')
        assert.equal(txParsedEvent0.event.args.proposalId, proposalId, 'Expected same txParsedEvent0.event.args.txHash')
        assert.equal(txParsedEvent0.event.args.txHash, txHash, 'Expected same txParsedEvent0.event.args.txHash')
        assert.equal(txParsedEvent0.event.args.success, false, 'Expected same txParsedEvent0.event.args.returnData')

        // TODO - confirm that returnData = "Cannot slash more than total currently staked"
        // assert.equal(txParsedEvent0.event.args.returnData, returnData, 'Expected same txParsedEvent0.event.args.returnData')

        assert.equal(txParsedEvent1.event.name, 'ProposalOutcomeEvaluated', 'Expected same event name')
        assert.equal(parseInt(txParsedEvent1.event.args.proposalId), proposalId, 'Expected same event.args.proposalId')
        assert.equal(txParsedEvent1.event.args.outcome, Outcome.TxFailed, 'Expected same event.args.outcome')
        assert.isTrue(txParsedEvent1.event.args.voteMagnitudeYes.eq(defaultStakeAmount), 'Expected same event.args.voteMagnitudeYes')
        assert.isTrue(txParsedEvent1.event.args.voteMagnitudeNo.isZero(), 'Expected same event.args.voteMagnitudeNo')
        assert.equal(parseInt(txParsedEvent1.event.args.numVotes), 1, 'Expected same event.args.numVotes')
  
        // Call getProposalById() and confirm same values
        const proposal = await governance.getProposalById.call(proposalId)
        assert.equal(parseInt(proposal.proposalId), proposalId, 'Expected same proposalId')
        assert.equal(proposal.proposer, proposerAddress, 'Expected same proposer')
        assert.isTrue(parseInt(proposal.startBlockNumber) > lastBlock, 'Expected startBlockNumber > lastBlock')
        assert.equal(_lib.toStr(proposal.targetContractRegistryKey), _lib.toStr(targetContractRegistryKey), 'Expected same proposal.targetContractRegistryKey')
        assert.equal(proposal.targetContractAddress, targetContractAddress, 'Expected same proposal.targetContractAddress')
        assert.equal(fromBN(proposal.callValue), callValue, 'Expected same proposal.callValue')
        assert.equal(proposal.signature, signature, 'Expected same proposal.signature')
        assert.equal(proposal.callData, callData, 'Expected same proposal.callData')
        assert.equal(proposal.outcome, Outcome.TxFailed, 'Expected same outcome')
        assert.equal(parseInt(proposal.voteMagnitudeYes), defaultStakeAmount, 'Expected same voteMagnitudeYes')
        assert.equal(parseInt(proposal.voteMagnitudeNo), 0, 'Expected same voteMagnitudeNo')
        assert.equal(parseInt(proposal.numVotes), 1, 'Expected same numVotes')
  
        // Confirm all vote states - Vote.No for Voter, Vote.None for all others
        for (const account of accounts) {
          const voterVote = await governance.getVoteByProposalAndVoter.call(proposalId, account)
          if (account == voterAddress) {
            assert.equal(voterVote, vote)
          } else {
            assert.equal(voterVote, defaultVote)
          }
        }
  
        // Confirm Slash action failed by checking new Stake + Token values
        const finalStakeAcct2 = await staking.totalStakedFor(targetAddress)
        assert.isTrue(finalStakeAcct2.eq(decreasedStakeAcct2), 'ye')
        assert.isTrue(
          (await staking.totalStaked()).eq(initialTotalStake.sub(decreaseStakeAmount)),
          'Expected total stake amount to be unchanged'
        )
        assert.isTrue((await token.totalSupply()).eq(initialTokenSupply), "Expected total token supply to be unchanged")
      })
    })
  })

  describe.skip('Submit proposal to upgrade contract', async () => {
    // example upgradeProxy.test.js:63
  })

  describe.skip('Submit proposal to upgrade governance contract', async () => {

  })
})
