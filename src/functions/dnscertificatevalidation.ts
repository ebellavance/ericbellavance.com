import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  DeleteCertificateCommand,
  type ValidationMethod,
  type RequestCertificateCommandInput,
  type DomainValidation,
} from '@aws-sdk/client-acm'
import {
  Route53Client,
  ListHostedZonesCommand,
  ChangeResourceRecordSetsCommand,
  type ChangeResourceRecordSetsCommandInput,
  type HostedZone,
} from '@aws-sdk/client-route-53'
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts'

// Define types for event and resource properties
interface ResourceProperties {
  CloudfrontCertificateRegion: string
  CrossAccountRoleArn: string
  DomainName: string
  SubjectAlternativeNames?: string[]
}

interface Event {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResourceProperties: ResourceProperties
  OldResourceProperties?: ResourceProperties
  PhysicalResourceId?: string
}

// Initialize ACM and STS clients
let acmClient: ACMClient
let stsClient: STSClient

const CERTIFICATE_POLLING_INTERVAL = 5000
const CERTIFICATE_TIMEOUT = 50000

// Sleep function
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Requests a new SSL/TLS certificate from ACM
const requestCertificate = async (
  domainName: string,
  validationMethod: ValidationMethod,
  subjectAlternativeNames: string[],
): Promise<string> => {
  const requestCertificateParams: RequestCertificateCommandInput = {
    DomainName: domainName,
    ValidationMethod: validationMethod,
    SubjectAlternativeNames: subjectAlternativeNames.length > 0 ? subjectAlternativeNames : undefined,
  }

  const requestCertificateCommand = new RequestCertificateCommand(requestCertificateParams)
  const certificateResponse = await acmClient.send(requestCertificateCommand)

  if (!certificateResponse.CertificateArn) {
    throw new Error('Failed to get certificate ARN')
  }

  return certificateResponse.CertificateArn
}

// Polls the ACM service to check if a certificate has been issued
const waitForCertificateValidation = async (
  certificateArn: string,
  timeoutDuration = CERTIFICATE_TIMEOUT,
): Promise<string> => {
  let certificateStatus = 'PENDING_VALIDATION'
  const startTime = Date.now()

  while (certificateStatus !== 'ISSUED' && Date.now() - startTime < timeoutDuration) {
    const describeCertificateCommand = new DescribeCertificateCommand({ CertificateArn: certificateArn })
    const certificateDetails = await acmClient.send(describeCertificateCommand)

    if (!certificateDetails.Certificate?.Status) {
      throw new Error('Failed to get certificate status')
    }

    certificateStatus = certificateDetails.Certificate.Status

    if (certificateStatus === 'ISSUED') {
      console.log('Certificate has been issued.')
      break
    }

    console.log(`Certificate status: ${certificateStatus}. Waiting for 5 seconds before checking again.`)
    await sleep(CERTIFICATE_POLLING_INTERVAL)
  }

  return certificateStatus
}

// Function to assume the cross-account role in Route53 Account
const assumeCrossAccountRole = async (roleArn: string): Promise<Route53Client> => {
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'LambdaRoute53Session',
  })

  const assumedRole = await stsClient.send(command)

  if (
    !assumedRole.Credentials?.AccessKeyId ||
    !assumedRole.Credentials.SecretAccessKey ||
    !assumedRole.Credentials.SessionToken
  ) {
    throw new Error('Failed to assume role - missing credentials')
  }

  return new Route53Client({
    credentials: {
      accessKeyId: assumedRole.Credentials.AccessKeyId,
      secretAccessKey: assumedRole.Credentials.SecretAccessKey,
      sessionToken: assumedRole.Credentials.SessionToken,
    },
  })
}

// Handle the update of an existing certificate
const handleCertificateUpdate = async (
  event: Event,
  domainName: string,
  subjectAlternativeNames: string[],
  validationMethod: ValidationMethod,
): Promise<string> => {
  const oldCertificateArn = event.PhysicalResourceId
  const oldProps = event.OldResourceProperties

  if (!oldProps) {
    throw new Error('OldResourceProperties is required for Update operation')
  }

  const domainChanged = oldProps.DomainName !== domainName
  const subjectAlternativeNamesChanged =
    JSON.stringify(oldProps.SubjectAlternativeNames || []) !== JSON.stringify(subjectAlternativeNames)

  if (!domainChanged && !subjectAlternativeNamesChanged) {
    console.log('No changes to domain or SubjectAlternativeNames. Keeping the existing certificate.')
    return oldCertificateArn!
  }

  console.log('Domain or SubjectAlternativeNames changed. Requesting a new certificate.')
  const certificateArn = await requestCertificate(domainName, validationMethod, subjectAlternativeNames)

  // Delete old certificate if it exists
  if (oldCertificateArn) {
    try {
      const deleteCertificateCommand = new DeleteCertificateCommand({
        CertificateArn: oldCertificateArn,
      })
      await acmClient.send(deleteCertificateCommand)
      console.log(`Old certificate ${oldCertificateArn} has been deleted.`)
    } catch (error) {
      console.error(`Error deleting old certificate ${oldCertificateArn}:`, error)
      // Continue with new certificate even if deletion fails
    }
  }

  return certificateArn
}

// Get certificate validation options with retry
const getCertificateValidationOptions = async (certificateArn: string): Promise<DomainValidation[]> => {
  let validationOptions: DomainValidation[] = []

  while (validationOptions.length === 0 || !validationOptions[0]?.ResourceRecord?.Value) {
    const describeCertificateCommand = new DescribeCertificateCommand({
      CertificateArn: certificateArn,
    })
    const describeCertificateResponse = await acmClient.send(describeCertificateCommand)

    if (!describeCertificateResponse.Certificate?.DomainValidationOptions) {
      throw new Error('No domain validation options found for certificate')
    }

    validationOptions = describeCertificateResponse.Certificate.DomainValidationOptions

    if (!validationOptions[0]?.ResourceRecord?.Value) {
      console.log('Waiting for validation options to be available...')
      await sleep(CERTIFICATE_POLLING_INTERVAL)
    }
  }

  return validationOptions
}

// Find hosted zone ID for a domain
const findHostedZoneId = (hostedZones: HostedZone[], domain: string): string | null => {
  const domainWithDot = `${domain}.`
  const hostedZone = hostedZones.find((zone) => zone.Name && domainWithDot.endsWith(zone.Name))
  return hostedZone?.Id?.replace('/hostedzone/', '') || null
}

// Create or update DNS validation records
const updateDnsValidationRecords = async (
  route53Client: Route53Client,
  validationOptions: DomainValidation[],
  hostedZones: HostedZone[],
): Promise<void> => {
  for (const validation of validationOptions) {
    if (!validation.ResourceRecord) {
      console.warn('No resource record found for validation:', validation.DomainName)
      continue
    }

    const validationRecord = validation.ResourceRecord
    const domainNameToCheck = validation.DomainName
    const hostedZoneId = findHostedZoneId(hostedZones, domainNameToCheck)

    if (!hostedZoneId) {
      console.warn(`Hosted zone not found for domain: ${domainNameToCheck}. Please update DNS manually.`)
      continue
    }

    console.log(`Updating DNS validation record for ${domainNameToCheck} in hosted zone ${hostedZoneId}`)

    const changeResourceRecordSetsParams: ChangeResourceRecordSetsCommandInput = {
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: validationRecord.Name,
              Type: validationRecord.Type,
              TTL: 300,
              ResourceRecords: [{ Value: validationRecord.Value }],
            },
          },
        ],
      },
    }

    const command = new ChangeResourceRecordSetsCommand(changeResourceRecordSetsParams)
    await route53Client.send(command)
    console.log(`DNS validation record created/updated for ${validation.DomainName}`)
  }
}

// Handle the certificate validation process
const handleCertificateValidation = async (
  event: Event,
  domainName: string,
  subjectAlternativeNames: string[],
  crossAccountRoleArn: string,
) => {
  // Handle certificate creation/update
  const validationMethod: ValidationMethod = 'DNS'
  let certificateArn: string

  if (event.RequestType === 'Update') {
    certificateArn = await handleCertificateUpdate(event, domainName, subjectAlternativeNames, validationMethod)
  } else {
    // Create new certificate
    certificateArn = await requestCertificate(domainName, validationMethod, subjectAlternativeNames)
  }

  console.log(`Certificate ARN: ${certificateArn}`)

  // Get certificate validation options
  const validationOptions = await getCertificateValidationOptions(certificateArn)

  // Assume cross-account role for Route53
  const route53Client = await assumeCrossAccountRole(crossAccountRoleArn)

  // Get hosted zones
  const { HostedZones: hostedZones = [] } = await route53Client.send(new ListHostedZonesCommand({}))

  // Update DNS validation records
  await updateDnsValidationRecords(route53Client, validationOptions, hostedZones)

  // Wait for certificate validation to complete
  const finalStatus = await waitForCertificateValidation(certificateArn)

  if (finalStatus !== 'ISSUED') {
    throw new Error(`Certificate validation failed with status: ${finalStatus}`)
  }

  return {
    PhysicalResourceId: certificateArn,
    Data: {
      CertificateArn: certificateArn,
    },
  }
}

exports.handler = async (event: Event) => {
  try {
    const { RequestType: requestType } = event
    const {
      DomainName: domainName,
      SubjectAlternativeNames: subjectAlternativeNames = [],
      CrossAccountRoleArn: crossAccountRoleArn,
      CloudfrontCertificateRegion: cloudfrontCertificateRegion,
    } = event.ResourceProperties

    // Initialize the clients with the provided cloudfrontCertificateRegion
    acmClient = new ACMClient({ region: cloudfrontCertificateRegion })
    stsClient = new STSClient({ region: cloudfrontCertificateRegion })

    if (requestType !== 'Create' && requestType !== 'Update' && requestType !== 'Delete') {
      throw new Error(`Unsupported request type: ${requestType}`)
    }

    if (requestType === 'Delete') {
      console.log('Delete request received. No action taken on DNS records.')
      return { PhysicalResourceId: event.PhysicalResourceId }
    }

    // Handle certificate validation for Create/Update requests
    return handleCertificateValidation(event, domainName, subjectAlternativeNames, crossAccountRoleArn)
  } catch (error) {
    console.error('Error managing certificate or DNS record: ', error)
    throw error
  }
}
