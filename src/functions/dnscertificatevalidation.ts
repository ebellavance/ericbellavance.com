import { ACMClient, RequestCertificateCommand, DescribeCertificateCommand, DeleteCertificateCommand } from '@aws-sdk/client-acm';
import { Route53Client, ListHostedZonesCommand, ChangeResourceRecordSetsCommand, ChangeResourceRecordSetsCommandInput, RRType } from '@aws-sdk/client-route-53';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

// Define types for event and resource properties
interface ResourceProperties {
  CloudfrontCertificateRegion: string;
  CrossAccountRoleArn: string;
  DomainName: string;
  SubjectAlternativeNames?: string[];
}

interface Event {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: ResourceProperties;
  OldResourceProperties?: ResourceProperties;
  PhysicalResourceId?: string;
}

// Initialize ACM and STS clients
let acmClient: ACMClient;
let stsClient: STSClient;

// Requests a new SSL/TLS certificate from ACM
const requestCertificate = async (domainName: string, validationMethod: string, subjectAlternativeNames: string[]) => {
  const requestCertificateParams: any = {
    DomainName: domainName,
    ValidationMethod: validationMethod,
  };

  if (subjectAlternativeNames && subjectAlternativeNames.length > 0) {
    requestCertificateParams.SubjectAlternativeNames = subjectAlternativeNames;
  }

  const requestCertificateCommand = new RequestCertificateCommand(requestCertificateParams);
  const certificateResponse = await acmClient.send(requestCertificateCommand);
  return certificateResponse.CertificateArn!;
};

// Polls the ACM service to check if a certificate has been issued
const waitForCertificateValidation = async (certificateArn: string, timeoutDuration: number = 50000) => {
  let certificateStatus = 'PENDING_VALIDATION';
  const startTime = Date.now();

  while (certificateStatus !== 'ISSUED' && Date.now() - startTime < timeoutDuration) {
    const describeCertificateCommand = new DescribeCertificateCommand({ CertificateArn: certificateArn });
    const certificateDetails = await acmClient.send(describeCertificateCommand);
    certificateStatus = certificateDetails.Certificate?.Status!;

    if (certificateStatus === 'ISSUED') {
      console.log('Certificate has been issued.');
      break;
    } else {
      console.log(`Certificate status: ${certificateStatus}. Waiting for 5 seconds before checking again.`);
      await sleep(5000);
    }
  }

  return certificateStatus;
};

// Sleep function
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Function to assume the cross-account role in Route53 Account
const assumeCrossAccountRole = async (roleArn: string): Promise<Route53Client> => {
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'LambdaRoute53Session',
  });

  const assumedRole = await stsClient.send(command);
  const credentials = assumedRole.Credentials;

  return new Route53Client({
    credentials: {
      accessKeyId: credentials!.AccessKeyId!,
      secretAccessKey: credentials!.SecretAccessKey!,
      sessionToken: credentials!.SessionToken!,
    },
  });
};

exports.handler = async (event: Event) => {
  try {
    const requestType = event.RequestType;
    const { 
      DomainName: domainName, 
      SubjectAlternativeNames: subjectAlternativeNames = [], 
      CrossAccountRoleArn: crossAccountRoleArn,
      CloudfrontCertificateRegion: cloudfrontCertificateRegion
    } = event.ResourceProperties;

    // Initialize the clients with the provided cloudfrontCertificateRegion
    acmClient = new ACMClient({ region: cloudfrontCertificateRegion });
    stsClient = new STSClient({ region: cloudfrontCertificateRegion });

    if (requestType === 'Create' || requestType === 'Update') {
      let certificateArn: string;
      let oldCertificateArn: string | undefined;
      const validationMethod = 'DNS';
      
      if (requestType === 'Update') {
        oldCertificateArn = event.PhysicalResourceId;
        const oldProps = event.OldResourceProperties!;
        const domainChanged = oldProps.DomainName !== domainName;
        const subjectAlternativeNamesChanged = 
          JSON.stringify(oldProps.SubjectAlternativeNames || []) !== JSON.stringify(subjectAlternativeNames);

        if (domainChanged || subjectAlternativeNamesChanged) {
          console.log('Domain or SubjectAlternativeNames changed. Requesting a new certificate.');
          certificateArn = await requestCertificate(domainName, validationMethod, subjectAlternativeNames);
          
          // Initiate the deletion of the old certificate
          if (oldCertificateArn) {
            try {
              const deleteCertificateCommand = new DeleteCertificateCommand({ CertificateArn: oldCertificateArn });
              await acmClient.send(deleteCertificateCommand);
              console.log(`Old certificate ${oldCertificateArn} has been deleted.`);
            } catch (error) {
              console.error(`Error deleting old certificate ${oldCertificateArn}:`, error);
              // We don't throw here as we want to continue with the new certificate
            }
          }
        } else {
          console.log('No changes to domain or SubjectAlternativeNames. Keeping the existing certificate.');
          certificateArn = oldCertificateArn;
        }
      } else {
        // Requests a new certificate
        certificateArn = await requestCertificate(domainName, validationMethod, subjectAlternativeNames);
      }

      console.log(`Certificate ARN: ${certificateArn}`);

      // Fetch details about the certificate to get the validation record details
      let validationOptions: Array<{ ResourceRecord?: { Name: string; Value: string; Type: RRType }; DomainName: string }> = [];
      while (!validationOptions[0]?.ResourceRecord?.Value) {
        const describeCertificateCommand = new DescribeCertificateCommand({
          CertificateArn: certificateArn,
        });
        const describeCertificateResponse = await acmClient.send(describeCertificateCommand);
        validationOptions = describeCertificateResponse.Certificate?.DomainValidationOptions || [];
        console.log('Validation Options:', validationOptions);
        if (!validationOptions[0]?.ResourceRecord?.Value) await sleep(5000);
      }

      const route53Client = await assumeCrossAccountRole(crossAccountRoleArn);

      // Fetch all Hosted Zones
      const listHostedZonesCommand = new ListHostedZonesCommand({});
      const hostedZonesResponse = await route53Client.send(listHostedZonesCommand);

      // Helper function to find the correct hosted zone
      const findHostedZoneId = (domain: string): string | null => {
        const domainWithDot = `${domain}.`;
        const hostedZone = hostedZonesResponse.HostedZones?.find(zone => domainWithDot.endsWith(zone.Name));
        return hostedZone ? hostedZone.Id : null;
      };

      // Create or update DNS records for validation
      for (const validation of validationOptions) {
        const validationRecord = validation.ResourceRecord!;
        const domainNameToCheck = validation.DomainName;

        console.log(`Validation Record for ${domainNameToCheck}: `, validationRecord);

        const hostedZoneId = findHostedZoneId(domainNameToCheck);

        if (!hostedZoneId) {
          console.warn(`Hosted zone not found for domain: ${domainNameToCheck}. Please update DNS manually.`);
          continue;
        }

        console.log(`Hosted zone ID for ${domainNameToCheck}: ${hostedZoneId}`);

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
                  ResourceRecords: [
                    {
                      Value: validationRecord.Value,
                    },
                  ],
                },
              },
            ],
          },
        };

        const changeResourceRecordSetsCommand = new ChangeResourceRecordSetsCommand(changeResourceRecordSetsParams);
        await route53Client.send(changeResourceRecordSetsCommand);
        console.log(`DNS validation record created/updated for ${validation.DomainName}`);
      }

      const finalStatus = await waitForCertificateValidation(certificateArn);

      if (finalStatus !== 'ISSUED') {
        console.log('Certificate issuance timed out. Current status:', finalStatus);
      }

      return {
        PhysicalResourceId: certificateArn,
        Data: {
          CertificateArn: certificateArn,
          OldCertificateArn: oldCertificateArn || 'N/A',  // Use 'N/A' if oldCertificateArn is undefined
          CertificateStatus: finalStatus,
        },
      };
    } else if (requestType === 'Delete') {
      // Delete the certificate
      const certificateArn = event.PhysicalResourceId!;
      const deleteCertificateCommand = new DeleteCertificateCommand({ CertificateArn: certificateArn });
      await acmClient.send(deleteCertificateCommand);
      console.log('Deleted Certificate ARN:', certificateArn);

      return {
        PhysicalResourceId: certificateArn,
      };
    }
  } catch (error) {
    console.error('Error managing certificate or DNS record: ', error);
    throw error; 
  }
};