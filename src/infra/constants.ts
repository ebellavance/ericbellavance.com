import { config } from 'dotenv'
import { IStage, IProject } from './model'

// Load environment variables from .env file if it exists
config()

// Helper function to get required environment variable
const getEnv = (key: string): string => {
  const value = process.env[key]
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

// Helper function to get optional environment variable
const getOptionalEnv = (key: string): string | undefined => {
  return process.env[key]
}

// Non-sensitive configuration
export const CONFIG = {
  CLOUDFRONT_CERTIFICATE_REGION: 'us-east-1',
  PRIMARY_REGION: 'ca-central-1',
  DOMAINS: {
    DEV: {
      DOMAIN_NAME: 'dev.ericbellavance.com',
      ALTERNATE_DOMAIN_NAMES: [],
    },
    PROD: {
      DOMAIN_NAME: 'ericbellavance.com',
      ALTERNATE_DOMAIN_NAMES: ['www.ericbellavance.com'],
    },
  },
} as const

// Base project configuration - only common variables that are always needed
export const PROJECT: IProject = {
  DEV_ALLOWED_IP: [], // Will be populated in dev stage only
  CROSS_ACCOUNT_ROLE_ARN: getEnv('CROSS_ACCOUNT_ROLE_ARN'),
  DNS_ACCOUNT: getEnv('DNS_ACCOUNT'),
  PRIMARY_REGION: CONFIG.PRIMARY_REGION,
  CLOUDFRONT_CERTIFICATE_REGION: CONFIG.CLOUDFRONT_CERTIFICATE_REGION,
}

const getStageConfig = (stageName: string): IStage => {
  const prefix = `${stageName.toUpperCase()}_`
  const stageKey = stageName.toUpperCase() as keyof typeof CONFIG.DOMAINS

  const domainConfig = CONFIG.DOMAINS[stageKey] || { DOMAIN_NAME: '', ALTERNATE_DOMAIN_NAMES: [] }

  // Get DEV_ALLOWED_IPS only for dev environment
  const devAllowedIps =
    stageName === 'dev'
      ? getEnv('DEV_ALLOWED_IPS')
          .split(',')
          .map((ip) => ip.trim())
      : []

  return {
    ...PROJECT,
    DEV_ALLOWED_IP: devAllowedIps, // Override with stage-specific value
    ACCOUNT_NUMBER: getEnv(`${prefix}ACCOUNT_NUMBER`),
    ALTERNATE_DOMAIN_NAME: [...(domainConfig.ALTERNATE_DOMAIN_NAMES || [])],
    DOMAIN_NAME: domainConfig.DOMAIN_NAME || '',
    STAGE_NAME: stageName,
  }
}

// Lazy-loaded stage configurations - only create when needed
let _development: IStage | undefined
let _production: IStage | undefined

export const getDevelopment = (): IStage => {
  if (!_development) {
    _development = getStageConfig('dev')
  }
  return _development
}

export const getProduction = (): IStage => {
  if (!_production) {
    _production = getStageConfig('prod')
  }
  return _production
}

// For backward compatibility, export the functions but only call them when the env vars exist
export const DEVELOPMENT = getOptionalEnv('DEV_ACCOUNT_NUMBER') ? getDevelopment() : undefined
export const PRODUCTION = getOptionalEnv('PROD_ACCOUNT_NUMBER') ? getProduction() : undefined

// Updated function to work with lazy loading
export const getStageFromShortName = (stageShortName: string): IStage | undefined => {
  switch (stageShortName) {
    case 'dev':
      return getDevelopment()
    case 'prod':
      return getProduction()
    default:
      return undefined
  }
}
