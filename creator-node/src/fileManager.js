const path = require('path')
const fs = require('fs')
const multer = require('multer')
const getUuid = require('uuid/v4')
const axios = require('axios')
const { promisify } = require('util')

const lstat = promisify(fs.lstat)
const readdir = promisify(fs.readdir)
const unlink = promisify(fs.unlink)
const rmdir = promisify(fs.rmdir)
const writeFile = promisify(fs.writeFile)
const mkdir = promisify(fs.mkdir)
const copyFile = promisify(fs.copyFile)

const config = require('./config')
const Utils = require('./utils')
const DiskManager = require('./diskManager')

const MAX_AUDIO_FILE_SIZE = parseInt(config.get('maxAudioFileSizeBytes')) // Default = 250,000,000 bytes = 250MB
const MAX_MEMORY_FILE_SIZE = parseInt(config.get('maxMemoryFileSizeBytes')) // Default = 50,000,000 bytes = 50MB

const ALLOWED_UPLOAD_FILE_EXTENSIONS = config.get('allowedUploadFileExtensions') // default set in config.json
const AUDIO_MIME_TYPE_REGEX = /audio\/(.*)/

/**
 * Adds file to IPFS then saves file to disk under /multihash name
 */
async function saveFileFromBufferToIPFSAndDisk (req, buffer) {
  // make sure user has authenticated before saving file
  if (!req.session.cnodeUserUUID) {
    throw new Error('User must be authenticated to save a file')
  }

  const ipfs = req.app.get('ipfsAPI')

  // Add to IPFS without pinning and retrieve multihash
  const multihash = (await ipfs.add(buffer, { pin: false }))[0].hash

  // Write file to disk by multihash for future retrieval
  const dstPath = DiskManager.computeFilePath(multihash)
  await writeFile(dstPath, buffer)

  return { multihash, dstPath }
}

/**
 * Given file path on disk, adds file to IPFS + re-saves under /multihash name
 *
 * @dev - only call this function when file is already stored to disk, else use saveFileFromBufferToIPFSAndDisk()
 */
async function saveFileToIPFSFromFS (req, srcPath) {
  // make sure user has authenticated before saving file
  if (!req.session.cnodeUserUUID) {
    throw new Error('User must be authenticated to save a file')
  }

  const ipfs = req.app.get('ipfsAPI')

  // Add to IPFS without pinning and retrieve multihash
  const multihash = (await ipfs.addFromFs(srcPath, { pin: false }))[0].hash

  // store file copy by multihash for future retrieval
  const dstPath = DiskManager.computeFilePath(multihash)

  try {
    await copyFile(srcPath, dstPath)
  } catch (e) {
    // if we see a ENOSPC error, log out the disk space and inode details from the system
    if (e.message.includes('ENOSPC')) {
      await Promise.all([
        Utils.runShellCommand(`df`, ['-h'], req.logger),
        Utils.runShellCommand(`df`, ['-ih'], req.logger)
      ])
    }
    throw e
  }

  return { multihash, dstPath }
}

/**
 * Given a CID, saves the file to disk. Steps to achieve that:
 * 1. do the prep work to save the file to the local file system including
 * creating directories, changing IPFS gateway urls before calling _saveFileForMultihash
 * 2. attempt to fetch the CID from a variety of sources
 * 3. throws error if failure, couldn't find the file or file contents don't match CID,
 * returns expectedStoragePath if successful
 * @param {Object} req request object
 * @param {String} multihash IPFS cid
 * @param {String} expectedStoragePath file system path similar to `/file_storage/Qm1`
 *                  for non dir files and `/file_storage/Qmdir/Qm2` for dir files
 * @param {Array} gatewaysToTry List of gateway endpoints to try
 * @param {String?} fileNameForImage file name if the multihash is image in dir.
 *                  eg original.jpg or 150x150.jpg
 */
async function saveFileForMultihash (req, multihash, expectedStoragePath, gatewaysToTry, fileNameForImage = null) {
  try {
    // will be modified to directory compatible route later if directory
    // TODO - don't concat url's by hand like this, use module like urljoin
    let gatewayUrlsMapped = gatewaysToTry.map(endpoint => `${endpoint.replace(/\/$/, '')}/ipfs/${multihash}`)

    const parsedStoragePath = path.parse(expectedStoragePath).dir

    try {
      // calling this on an existing directory doesn't overwrite the existing data or throw an error
      // the mkdir recursive is equivalent to `mkdir -p`
      await mkdir(parsedStoragePath, { recursive: true })
    } catch (e) {
      throw new Error(`Error making directory at ${parsedStoragePath} - ${e.message}`)
    }

    // regex match to check if a directory or just a regular file
    // if directory will have both outer and inner properties in match.groups
    // else will have just outer
    const matchObj = DiskManager.extractCIDsFromFSPath(expectedStoragePath)

    // if this is a directory, make it compatible with our dir cid gateway url
    if (matchObj && matchObj.isDir && matchObj.outer && fileNameForImage) {
      // override gateway urls to make it compatible with directory given an endpoint
      // eg. before running the line below gatewayUrlsMapped looks like [https://endpoint.co/ipfs/Qm111, https://endpoint.co/ipfs/Qm222 ...]
      // in the case of a directory, override the gatewayUrlsMapped array to look like
      // [https://endpoint.co/ipfs/Qm111/150x150.jpg, https://endpoint.co/ipfs/Qm222/150x150.jpg ...]
      gatewayUrlsMapped = gatewaysToTry.map(endpoint => `${endpoint.replace(/\/$/, '')}/ipfs/${matchObj.outer}/${fileNameForImage}`)
    }

    /**
     * Attempts to fetch CID:
     *  - If file already stored on disk, return immediately and store to disk.
     *  - If file not already stored, fetch from IPFS and store to disk. First calls
     *    IPFS cat, then calls IPFS get
     *  - If file is not available via IPFS try other cnode gateways for user's replica set.
     */

    // If file already stored on disk, return immediately.
    if (fs.existsSync(expectedStoragePath)) {
      req.logger.debug(`File already stored at ${expectedStoragePath} for ${multihash}`)
      return expectedStoragePath
    }

    // If file not already stored, fetch and store at storagePath.
    let fileFound = false

    // If multihash already available on local ipfs node, cat file from local ipfs node
    req.logger.debug(`checking if ${multihash} already available on local ipfs node`)
    try {
      // ipfsCat returns a Buffer
      let fileBuffer = await Utils.ipfsCat(multihash, req, 1000)
      fileFound = true
      req.logger.debug(`Retrieved file for ${multihash} from local ipfs node`)
      // Write file to disk.
      await writeFile(expectedStoragePath, fileBuffer)
      req.logger.info(`wrote file to ${expectedStoragePath}, obtained via ipfs cat`)
    } catch (e) {
      req.logger.warn(`Multihash ${multihash} is not available on local ipfs node ${e.message}`)
    }

    // If file not already available on local ipfs node, fetch from IPFS.
    if (!fileFound) {
      req.logger.debug(`Attempting to get ${multihash} from IPFS`)
      try {
        // ipfsGet returns a BufferListStream object which is not a buffer
        // not compatible into writeFile directly, but it can be streamed to a file
        let fileBL = await Utils.ipfsGet(multihash, req, 5000)
        req.logger.debug(`retrieved file for multihash ${multihash} from local ipfs node`)

        // Write file to disk.
        await Utils.writeStreamToFileSystem(fileBL, expectedStoragePath)
        fileFound = true
        req.logger.info(`wrote file to ${expectedStoragePath}, obtained via ipfs get`)
      } catch (e) {
        req.logger.warn(`Failed to retrieve file for multihash ${multihash} from IPFS ${e.message}`)
      }
    }

    // if file is still null, try to fetch from other cnode gateways if user has nodes in replica set
    if (!fileFound && gatewayUrlsMapped.length > 0) {
      try {
        let response
        // ..replace(/\/$/, "") removes trailing slashes
        req.logger.debug(`Attempting to fetch multihash ${multihash} by racing replica set endpoints`)

        // Note - Requests are intentionally not parallel to minimize additional load on gateways
        for (let index = 0; index < gatewayUrlsMapped.length; index++) {
          const url = gatewayUrlsMapped[index]
          try {
            const resp = await axios({
              method: 'get',
              url,
              responseType: 'stream',
              timeout: 20000 /* 20 sec - higher timeout to allow enough time to fetch copy320 */
            })
            if (resp.data) {
              response = resp
              break
            }
          } catch (e) {
            req.logger.error(`Error fetching file from other cnode ${url} ${e.message}`)
            continue
          }
        }

        if (!response || !response.data) {
          throw new Error(`Couldn't find files on other creator nodes, after trying URLs: ${gatewayUrlsMapped.toString()}`)
        }

        // Write file to disk
        await Utils.writeStreamToFileSystem(response.data, expectedStoragePath)
        fileFound = true

        req.logger.info(`wrote file to ${expectedStoragePath}`)
      } catch (e) {
        throw new Error(`Failed to retrieve file for multihash ${multihash} from other creator node gateways: ${e.message}`)
      }
    }

    // file was not found on ipfs or any gateway
    if (!fileFound) {
      throw new Error(`Failed to retrieve file for multihash ${multihash} after trying ipfs & other creator node gateways`)
    }

    // for verification purposes - don't delete. verifies that the contents of the file match the file's cid
    try {
      const ipfs = req.app.get('ipfsLatestAPI')
      const content = fs.createReadStream(expectedStoragePath)
      for await (const result of ipfs.add(content, { onlyHash: true, timeout: 10000 })) {
        if (multihash !== result.cid.toString()) {
          throw new Error(`File contents don't match IPFS hash multihash: ${multihash} result: ${result.cid.toString()}`)
        }
      }
    } catch (e) {
      throw new Error(`Error during content verification for multihash ${multihash} ${e.message}`)
    }

    return expectedStoragePath
  } catch (e) {
    throw new Error(`saveFileForMultihash - ${e}`)
  }
}

/**
 * Removes all upload artifacts for track from filesystem. After successful upload these artifacts
 *    are all redundant since all synced content is replicated outside the upload folder.
 * (1) Remove all files in requested fileDir
 * (2) Confirm the only subdirectory is 'fileDir/segments'
 * (3) Remove all files in 'fileDir/segments' - throw if any subdirectories found
 * (4) Remove 'fileDir/segments' and fileDir
 * @dev - Eventually this function execution should be moved off of main server process
 */
async function removeTrackFolder (req, fileDir) {
  try {
    req.logger.info(`Removing track folder at fileDir ${fileDir}...`)
    if (!fileDir) {
      throw new Error('Cannot remove null fileDir')
    }

    let fileDirInfo = await lstat(fileDir)
    if (!fileDirInfo.isDirectory()) {
      throw new Error('Expected directory input')
    }

    // Remove all contents of track dir (process sequentially to limit cpu load)
    const files = await readdir(fileDir)
    for (const file of files) {
      let curPath = path.join(fileDir, file)

      if ((await lstat(curPath)).isDirectory()) {
        // Only the 'segments' subdirectory is expected
        if (file !== 'segments') {
          throw new Error(`Unexpected subdirectory in ${fileDir} - ${curPath}`)
        }

        // Delete each segment file inside /fileDir/segments/ (process sequentially to limit cpu load)
        const segmentFiles = await readdir(curPath)
        for (const segmentFile of segmentFiles) {
          let curSegmentPath = path.join(curPath, segmentFile)

          // Throw if a subdirectory found in /fileDir/segments/
          if ((await lstat(curSegmentPath)).isDirectory()) {
            throw new Error(`Unexpected subdirectory in segments ${fileDir} - ${curPath}`)
          }

          // Delete segment file
          await unlink(curSegmentPath)
        }

        // Delete /fileDir/segments/ directory after all its contents have been deleted
        await rmdir(curPath)
      } else {
        // Delete file inside /fileDir/
        req.logger.info(`Removing ${curPath}`)
        await unlink(curPath)
      }
    }

    // Delete fileDir after all its contents have been deleted
    await rmdir(fileDir)
    req.logger.info(`Removed track folder at fileDir ${fileDir}`)
    return null
  } catch (err) {
    req.logger.error(`Error removing ${fileDir}. ${err}`)
    return err
  }
}

// Simple in-memory storage for metadata/generic files
const memoryStorage = multer.memoryStorage()
const upload = multer({
  limits: { fileSize: MAX_MEMORY_FILE_SIZE },
  storage: memoryStorage
})

// Simple temp storage for metadata/generic files
const tempDiskStorage = multer.diskStorage({})
const uploadTempDiskStorage = multer({
  limits: { fileSize: MAX_MEMORY_FILE_SIZE },
  storage: tempDiskStorage
})

// Custom on-disk storage for track files to prep for segmentation
const trackDiskStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // save file under randomly named folders to avoid collisions
    const randomFileName = getUuid()
    const fileDir = path.join(DiskManager.getTmpTrackUploadArtifactsPath(), randomFileName)

    // create directories for original file and segments
    fs.mkdirSync(fileDir)
    fs.mkdirSync(fileDir + '/segments')

    req.fileDir = fileDir
    const fileExtension = getFileExtension(file.originalname)
    req.fileName = randomFileName + fileExtension

    req.logger.info(`Created track disk storage: ${req.fileDir}, ${req.fileName}`)
    cb(null, fileDir)
  },
  filename: function (req, file, cb) {
    cb(null, req.fileName)
  }
})

const trackFileUpload = multer({
  storage: trackDiskStorage,
  limits: { fileSize: MAX_AUDIO_FILE_SIZE },
  fileFilter: function (req, file, cb) {
    const fileExtension = getFileExtension(file.originalname).slice(1)
    // the function should call `cb` with a boolean to indicate if the file should be accepted
    if (ALLOWED_UPLOAD_FILE_EXTENSIONS.includes(fileExtension) && AUDIO_MIME_TYPE_REGEX.test(file.mimetype)) {
      req.logger.info(`Filetype: ${fileExtension}`)
      req.logger.info(`Mimetype: ${file.mimetype}`)
      cb(null, true)
    } else {
      req.fileFilterError = `File type not accepted. Must be one of [${ALLOWED_UPLOAD_FILE_EXTENSIONS}] with mime type matching ${AUDIO_MIME_TYPE_REGEX}, got file ${fileExtension} with mime ${file.mimetype}`
      cb(new Error(req.fileFilterError))
    }
  }
})

const handleTrackContentUpload = (req, res, next) => {
  trackFileUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        req.fileSizeError = err
      } else if (err instanceof multer.MulterError) {
        req.logger.error(`Multer error: ${err}`)
      } else {
        req.logger.error(`Content upload error: ${err}`)
      }
    }
    next()
  })
}

function getFileExtension (fileName) {
  return (fileName.lastIndexOf('.') >= 0) ? fileName.substr(fileName.lastIndexOf('.')).toLowerCase() : ''
}

module.exports = {
  saveFileFromBufferToIPFSAndDisk,
  saveFileToIPFSFromFS,
  saveFileForMultihash,
  removeTrackFolder,
  upload,
  uploadTempDiskStorage,
  trackFileUpload,
  handleTrackContentUpload
}
