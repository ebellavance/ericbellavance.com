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

// All environment variables are now required
export const PROJECT: IProject = {
  DEV_ALLOWED_IP: getEnv('DEV_ALLOWED_IPS')
    .split(',')
    .map((ip) => ip.trim()),
  CROSS_ACCOUNT_ROLE_ARN: getEnv('CROSS_ACCOUNT_ROLE_ARN'),
  DNS_ACCOUNT: getEnv('DNS_ACCOUNT'),
  PRIMARY_REGION: CONFIG.PRIMARY_REGION,
  CLOUDFRONT_CERTIFICATE_REGION: CONFIG.CLOUDFRONT_CERTIFICATE_REGION,
}

const getStageConfig = (stageName: string): IStage => {
  const prefix = `${stageName.toUpperCase()}_`
  const stageKey = stageName.toUpperCase() as keyof typeof CONFIG.DOMAINS

  const domainConfig = CONFIG.DOMAINS[stageKey] || { DOMAIN_NAME: '', ALTERNATE_DOMAIN_NAMES: [] }

  return {
    ...PROJECT,
    ACCOUNT_NUMBER: getEnv(`${prefix}ACCOUNT_NUMBER`),
    ALTERNATE_DOMAIN_NAME: [...(domainConfig.ALTERNATE_DOMAIN_NAMES || [])],
    DOMAIN_NAME: domainConfig.DOMAIN_NAME || '',
    STAGE_NAME: stageName,
  }
}

export const DEVELOPMENT = getStageConfig('dev')
export const PRODUCTION = getStageConfig('prod')

export const STAGES = [DEVELOPMENT, PRODUCTION]

//In summary, this function searches through an array of IStage objects ( STAGES) and
//returns the first object whose STAGE_NAME property matches the provided stageShortName.
//If no match is found, it returns undefined.
export const getStageFromShortName = (stageShortName: string): IStage | undefined => {
  return STAGES.find((stage) => stage.STAGE_NAME === stageShortName)
}
