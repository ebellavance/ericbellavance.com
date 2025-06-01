import { Route53Client, ListHostedZonesCommand, ChangeResourceRecordSetsCommand, ChangeResourceRecordSetsCommandInput, RRType } from '@aws-sdk/client-route-53';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

// Define types for event and resource properties
interface ResourceProperties {
  CloudfrontURL: string;
  CrossAccountRoleArn: string;
  DomainName: string;
  SubjectAlternativeNames?: string[];
}

interface Event {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: ResourceProperties;
  PhysicalResourceId?: string;
}

// Initialize STS client
let stsClient: STSClient;

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
      CloudfrontURL: cloudfrontUrl,
    } = event.ResourceProperties;

    // Initialize the client
    stsClient = new STSClient({});

    if (requestType === 'Create' || requestType === 'Update') {
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

      // Create or update A records for the domain and SANs
      const domains = [domainName, ...(Array.isArray(subjectAlternativeNames) ? subjectAlternativeNames : [])];
      const createdRecords: string[] = [];

      for (const domain of domains) {
        const hostedZoneId = findHostedZoneId(domain);

        if (!hostedZoneId) {
          console.warn(`Hosted zone not found for domain: ${domain}. Please update DNS manually.`);
          continue;
        }

        console.log(`Hosted zone ID for ${domain}: ${hostedZoneId}`);

        const changeResourceRecordSetsParams: ChangeResourceRecordSetsCommandInput = {
          HostedZoneId: hostedZoneId,
          ChangeBatch: {
            Changes: [
              {
                Action: 'UPSERT',
                ResourceRecordSet: {
                  Name: domain,
                  Type: 'A',
                  AliasTarget: {
                    HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront's hosted zone ID
                    DNSName: cloudfrontUrl,
                    EvaluateTargetHealth: false
                  },
                },
              },
            ],
          },
        };

        const changeResourceRecordSetsCommand = new ChangeResourceRecordSetsCommand(changeResourceRecordSetsParams);
        await route53Client.send(changeResourceRecordSetsCommand);
        console.log(`A record created/updated for ${domain} pointing to ${cloudfrontUrl}`);
        createdRecords.push(domain);
      }

      return {
        PhysicalResourceId: domainName,
        Data: {
          Message: `DNS records created/updated for: ${createdRecords.join(', ')}`,
        },
      };
    } else if (requestType === 'Delete') {
      // For delete, you might want to remove the DNS records
      // This is optional and depends on your use case
      console.log('Delete request received. No action taken on DNS records.');

      return {
        PhysicalResourceId: domainName,
      };
    }
  } catch (error) {
    console.error('Error managing DNS records: ', error);
    throw error; 
  }
};