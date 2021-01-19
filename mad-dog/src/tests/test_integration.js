const {
  OPERATION_TYPE,
  TrackUploadRequest,
  TrackUploadResponse
} = require('../operations.js')

const path = require('path')
const { _ } = require('lodash')
const fs = require('fs-extra')
const axios = require('axios')

const { logger } = require('../logger.js')
const ServiceCommands = require('@audius/service-commands')
const MadDog = require('../madDog.js')
const { EmitterBasedTest, Event } = require('../emitter.js')
const {
  addAndUpgradeUsers,
  getRandomTrackMetadata,
  getRandomTrackFilePath,
  addUsers,
  r6,
  waitForSync,
  upgradeUsersToCreators
} = require('../helpers.js')
const { getContentNodeEndpoints } = require('@audius/service-commands')
const {
  uploadTrack,
  getTrackMetadata,
  getUser,
  getUsers,
  verifyCIDExistsOnCreatorNode,
  getClockValuesFromReplicaSet,
  uploadPhotoAndUpdateMetadata
} = ServiceCommands

// NOTE - # of ticks = (TEST_DURATION_SECONDS / TICK_INTERVAL_SECONDS) - 1
const TICK_INTERVAL_SECONDS = 5
const TEST_DURATION_SECONDS = 10
const TEMP_STORAGE_PATH = path.resolve('./local-storage/tmp/')

const SECOND_USER_PIC_PATH = path.resolve('assets/images/duck.jpg')
const THIRD_USER_PIC_PATH = path.resolve('assets/images/sid.png')
const SYNC_WAIT = 10000
/**
 * Randomly uploads tracks over the duration of the test,
 * testing that the CIDs are on the respective CNodes at the end of the test.
 */
module.exports = coreIntegration = async ({
  numUsers,
  executeAll,
  executeOne,
  numCreatorNodes,
  enableFaultInjection
}) => {
  // Begin: Test Setup

  // create tmp storage dir
  await fs.ensureDir(TEMP_STORAGE_PATH)

  // map of walletId => trackId => metadata
  const walletTrackMap = {}
  // map of walletId => trackId => metadata
  const failedUploads = {}

  // Create the Emitter Based Test
  const emitterTest = new EmitterBasedTest({
    tickIntervalSeconds: TICK_INTERVAL_SECONDS,
    testDurationSeconds: TEST_DURATION_SECONDS
  })

  // Register the request listener. The only request type this test
  // currently handles is to upload tracks.
  emitterTest.registerOnRequestListener(async (request, emit) => {
    const { type, walletIndex, userId } = request
    switch (type) {
      case OPERATION_TYPE.TRACK_UPLOAD: {
        const track = getRandomTrackMetadata(userId)

        const randomTrackFilePath = await getRandomTrackFilePath(TEMP_STORAGE_PATH)

        let res
        try {
          // Execute a track upload request against a single
          // instance of libs.
          const trackId = await executeOne(walletIndex, l =>
            uploadTrack(l, track, randomTrackFilePath)
          )
          res = new TrackUploadResponse(walletIndex, trackId, track)
        } catch (e) {
          logger.warn(`Caught error [${e.message}] uploading track: [${track}]`)
          res = new TrackUploadResponse(
            walletIndex,
            null,
            track,
            false,
            e.message
          )
        }
        // Emit the response event
        emit(Event.RESPONSE, res)
        break
      }
      default:
        logger.error('Unknown request type!')
        break
    }
  })

  // Register the response listener. Currently only handles
  // track upload responses.
  emitterTest.registerOnResponseListener(res => {
    switch (res.type) {
      case OPERATION_TYPE.TRACK_UPLOAD: {
        const { walletIndex, trackId, metadata, success } = res
        // If it failed, log it
        if (!success) {
          if (!failedUploads[walletIndex]) {
            failedUploads[walletIndex] = {}
          }

          failedUploads[walletIndex] = {
            [trackId]: metadata
          }
        } else {
          if (!walletTrackMap[walletIndex]) {
            walletTrackMap[walletIndex] = {}
          }

          walletTrackMap[walletIndex] = {
            [trackId]: metadata
          }
        }
        break
      }
      default:
        logger.error('Unknown response type')
    }
  })

  // Emit one track upload request per tick. This can be adapted to emit other kinds
  // of events.
  emitterTest.registerOnTickListener(emit => {
    const requesterIdx = _.random(0, numUsers - 1)
    const request = new TrackUploadRequest(
      requesterIdx,
      walletIdMap[requesterIdx]
    )
    emit(Event.REQUEST, request)
  })

  // Create users. Upgrade them to creators later
  let walletIdMap
  try {
    walletIdMap = await addUsers(
      numUsers,
      executeAll,
      executeOne
    )
  } catch (e) {
    return { error: `Issue with creating users: ${e}` }
  }

  // Check that users on signup have the proper metadata
  const walletIndexes = Object.keys(walletIdMap)
  const userIds = Object.values(walletIdMap)

  let userMetadatas = await executeOne(walletIndexes[0], libsWrapper => {
    return getUsers(libsWrapper, userIds)
  })

  // 1. Check that certain MD fields in disc prov are what we expected it to be
  userMetadatas.forEach(user => {
    logger.info(`Checking initial metadata on signup for user ${user.user_id}...`)
    if (user.is_creator) {
      return {
        error: `New user ${user.user_id} should not be a creator immediately after sign-up.`
      }
    }

    // make this if case stronger -- like query cn1-3 to make sure that data is there
    if (!user.creator_node_endpoint) {
      return {
        error: `New user ${user.user_id} should have been assigned a replica set.`
      }
    }

    if (!user.profile_picture_sizes) {
      return {
        error: `New user ${user.user_id} should have an updated profile picture.`
      }
    }
  })

  // Check user metadata is proper and that the clock values across the replica set is consistent
  try {
    await checkUserMetadataAndClockValues({
      walletIndexes,
      walletIdMap,
      userMetadatas,
      picturePath: SECOND_USER_PIC_PATH,
      executeOne
    })
  } catch (e) {
    return {
      error: `User pre-track upload -- ${e.message}`
    }
  }

  await upgradeUsersToCreators(executeAll, executeOne)

  if (enableFaultInjection) {
    // Create a MadDog instance, responsible for taking down nodes
    const m = new MadDog(numCreatorNodes)
    m.start()
  }

  // Start the test, wait for it to finish.
  await emitterTest.start()
  logger.info('Emitter test exited')

  // Verify results

  // create array of track upload info to verify
  const trackUploadInfo = []
  for (const walletIndex of Object.keys(walletTrackMap)) {
    const userId = walletIdMap[walletIndex]
    const tracks = walletTrackMap[walletIndex]
    if (!tracks) continue
    for (const trackId of Object.keys(tracks)) {
      trackUploadInfo.push({
        walletIndex,
        trackId,
        userId
      })
    }
  }

  const allCIDsExistOnCNodes = await verifyAllCIDsExistOnCNodes(trackUploadInfo, executeOne)
  if (!allCIDsExistOnCNodes) {
    return { error: 'Not all CIDs exist on creator nodes.' }
  }
  const failedWallets = Object.values(failedUploads)
  if (failedWallets.length) {
    logger.info({ failedWallets, failedUploads })
    const userIds = failedWallets.map(w => walletIdMap[w])
    logger.warn(`Uploads failed for user IDs: [${userIds}]`)
  }

  // Remove temp storage dir
  await fs.remove(TEMP_STORAGE_PATH)

  // 7. do 1-6 again after track upload with certain checks
  userMetadatas = await executeOne(walletIndexes[0], libsWrapper => {
    return getUsers(libsWrapper, userIds)
  })

  await waitForSync()

  // 8. Check that certain MD fields in disc prov are what we expected it to be
  userMetadatas.forEach(user => {
    logger.info(`Checking post track upload metadata for user ${user.user_id}...`)
    if (user.is_creator) {
      return {
        error: `User ${user.user_id} should be a creator after track upload.`
      }
    }

    if (!user.creator_node_endpoint) {
      return {
        error: `User ${user.user_id} should have kept their replica set.`
      }
    }

    if (!user.profile_picture_sizes) {
      return {
        error: `User ${user.user_id} should have an updated profile picture.`
      }
    }
  })

  // Check user metadata is proper and that the clock values across the replica set is consistent
  try {
    await checkUserMetadataAndClockValues({
      walletIndexes,
      walletIdMap,
      userMetadatas,
      picturePath: THIRD_USER_PIC_PATH,
      executeOne
    })
  } catch (e) {
    return {
      error: `User post track upload -- ${e.message}`
    }
  }

  return {}
}

/**
 * Expects trackUploads in the shape of Array<{ userId, walletIndex, trackId }>
 */
const verifyAllCIDsExistOnCNodes = async (trackUploads, executeOne) => {
  // map userId => CID[]
  const userCIDMap = {}
  for (const { trackId, walletIndex, userId } of trackUploads) {
    const trackMetadata = await executeOne(walletIndex, l =>
      getTrackMetadata(l, trackId)
    )
    const segmentCIDs = trackMetadata.track_segments.map(s => s.multihash)
    if (userCIDMap[userId] === undefined) {
      userCIDMap[userId] = []
    }
    userCIDMap[userId] = [...userCIDMap[userId], ...segmentCIDs]
  }

  // Now, find the cnodes for each user

  // make a map of userID => array of cnode endpoints in user replica set
  const userIdRSetMap = {}
  const userIds = trackUploads.map(u => u.userId)
  for (const userId of userIds) {
    const user = await executeOne(0, l => getUser(l, userId))
    userIdRSetMap[userId] = user.creator_node_endpoint.split(',')
  }

  // Now, confirm each of these CIDs are on the file
  // system of the user's primary CNode.
  // TODO - currently only verifies CID on user's primary, need to add verification
  //    against secondaries as well. This is difficult because of sync non-determinism + time lag.
  const failedCIDs = []
  for (const userId of userIds) {
    const userRSet = userIdRSetMap[userId]
    const endpoint = userRSet[0]
    const cids = userCIDMap[userId]

    if (!cids) continue
    for (const cid of cids) {
      logger.info(`Verifying CID ${cid} for userID ${userId} on primary: [${endpoint}]`)

      // TODO: add `fromFS` option when this is merged back into CN.
      const exists = await verifyCIDExistsOnCreatorNode(cid, endpoint)

      logger.info(`Verified CID ${cid} for userID ${userId} on primary: [${endpoint}]!`)
      if (!exists) {
        logger.warn('Found a non-existent cid!')
        failedCIDs.push(cid)
      }
    }
  }
  logger.info('Completed verifying CIDs')
  return !failedCIDs.length
}

async function checkUserMetadataAndClockValues ({
  walletIndexes,
  walletIdMap,
  userMetadatas,
  picturePath,
  executeOne
}) {
  for (let i = 0; i < walletIndexes.length; i++) {
    // 2. Check that the clock values across replica set are equal
    await checkClockValuesAcrossReplicaSet({
      executeOne,
      indexOfLibsInstance: i,
      userId: walletIdMap[i]
    })

    // 3. Check that the metadata object in CN across replica set is what we expect it to be
    const replicaSetEndpoints = await executeOne(i, libsWrapper =>
      getContentNodeEndpoints(libsWrapper, userMetadatas[i].creator_node_endpoint)
    )

    await checkMetadataEquality({
      endpoints: replicaSetEndpoints,
      metadataMultihash: userMetadatas[i].metadata_multihash,
      userId: walletIdMap[i]
    })

    // 4. Update MD (bio + photo) and check that 2 and 3 are correct
    const updatedBio = 'i am so cool ' + r6()
    await executeOne(i, async libsWrapper => {
      // Update bio
      const newMetadata = { ...userMetadatas[i] }
      newMetadata.bio = updatedBio

      // Update profile picture and metadata accordingly
      logger.info(`Updating metadata for user ${userMetadatas[i].user_id}...`)
      await uploadPhotoAndUpdateMetadata({
        libsWrapper,
        metadata: newMetadata,
        userId: userMetadatas[i].user_id,
        picturePath,
        updateCoverPhoto: false
      })
    })

    await waitForSync()

    // 5. Check that clock values are consistent among replica set
    await checkClockValuesAcrossReplicaSet({
      executeOne,
      indexOfLibsInstance: i,
      userId: walletIdMap[i]
    })

    // 6. Check that the updated MD is correct with the updated bio and profile picture
    const updatedUser = await executeOne(i, libsWrapper => getUser(libsWrapper, userMetadatas[i].user_id))
    await checkMetadataEquality({
      endpoints: replicaSetEndpoints,
      metadataMultihash: updatedUser.metadata_multihash,
      userId: walletIdMap[i]
    })
  }
}

async function checkMetadataEquality ({ endpoints, metadataMultihash, userId }) {
  logger.info(`Checking metadata across replica set is consistent for user ${userId}...`)
  const replicaSetMetadatas = (await Promise.all(
    endpoints.map(endpoint => {
      return axios({
        url: `/ipfs/${metadataMultihash}`,
        method: 'get',
        baseURL: endpoint
      })
    })
  )).map(response => response.data)

  const fieldsToCheck = [
    'is_creator',
    'creator_node_endpoint',
    'profile_picture_sizes',
    'bio'
  ]

  // Primary = index 0, secondaries = indexes 1,2
  fieldsToCheck.forEach(field => {
    const primaryValue = replicaSetMetadatas[0][field]
    if (
      replicaSetMetadatas[1][field] !== primaryValue ||
      replicaSetMetadatas[2][field] !== primaryValue
    ) {
      throw new Error(
        `Field ${field} in secondaries does not match what is in primary.\nPrimary: ${primaryValue}\nSecondaries: ${replicaSetMetadatas[1][field]},${replicaSetMetadatas[2][field]}`
      )
    }
  })
}

async function checkClockValuesAcrossReplicaSet ({ executeOne, indexOfLibsInstance, userId }) {
  logger.info(`Checking clock values for user ${userId}...`)
  const replicaSetClockValues = await executeOne(indexOfLibsInstance, libsWrapper => {
    return getClockValuesFromReplicaSet(libsWrapper)
  })

  const primaryClockValue = replicaSetClockValues[0].clockValue
  const secondary1ClockValue = replicaSetClockValues[1].clockValue
  const secondary2ClockValue = replicaSetClockValues[2].clockValue

  if (primaryClockValue !== secondary1ClockValue || primaryClockValue !== secondary2ClockValue) {
    throw new Error(`Clock values are out of sync:\nPrimary: ${primaryClockValue}\nSecondary 1: ${secondary1ClockValue}\nSecondary 2: ${secondary2ClockValue}`)
  }
}
