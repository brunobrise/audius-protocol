const bunyan = require('bunyan')
const { nanoid } = require('nanoid')

const config = require('./config')

const logLevel = config.get('logLevel') || 'info'
const logger = bunyan.createLogger({
  name: 'audius_creator_node',
  streams: [
    {
      level: logLevel,
      stream: process.stdout
    }
  ]
})
logger.info('Loglevel set to:', logLevel)

/**
 * TODO make this more readable
 */
const excludedRoutes = [
  '/health_check',
  '/ipfs',
  'ipfs_peer_info',
  '/tracks/download_status',
  '/db_check',
  '/version',
  '/disk_check',
  '/sync_status'
]
function requestNotExcludedFromLogging (url) {
  return (excludedRoutes.filter(excludedRoute => url.includes(excludedRoute))).length === 0
}

function getRequestLoggingContext (req, requestID) {
  req.startTime = process.hrtime()
  const urlParts = req.url.split('?')
  return {
    requestID,
    requestMethod: req.method,
    requestHostname: req.hostname,
    requestUrl: urlParts[0],
    requestQueryParams: urlParts.length > 1 ? urlParts[1] : undefined,
    requestWallet: req.get('user-wallet-addr'),
    requestBlockchainUserId: req.get('user-id')
  }
}

function loggingMiddleware (req, res, next) {
  const requestID = req.get('request-ID') || nanoid()
  res.set('CN-Request-ID', requestID)
  console.log(`SIDTEST request header ${requestID}`)

  req.logContext = getRequestLoggingContext(req, requestID)
  req.logger = logger.child(req.logContext)

  if (requestNotExcludedFromLogging(req.originalUrl)) {
    req.logger.info('Begin processing request')
  }
  next()
}

module.exports = { logger, loggingMiddleware, requestNotExcludedFromLogging, getRequestLoggingContext }
