import * as cdk from 'aws-cdk-lib';
import { Stack, CfnOutput, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { IStage } from '../model';

/**
 * Props for the WebsiteStack, extending the standard CDK StackProps
 * and including a custom stage property.
 */
interface WebsiteStackProps extends cdk.StackProps {
  stage: IStage;
}

/**
 * WebsiteStack class for creating and managing the infrastructure
 * for a static website hosted on AWS.
 */
export class WebsiteStack extends Stack {
  constructor(scope: Construct, id: string, props: WebsiteStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // Create S3 buckets for website content and logs
    const websiteBucketServerLogs = this.createLogBucket('WebsiteBucketServerLogs', `${stage.DOMAIN_NAME}-access-logs`);
    const websiteBucket = this.createWebsiteBucket(stage.DOMAIN_NAME, websiteBucketServerLogs);
    const bucketCloudfrontLogs = this.createLogBucket('BucketCloudfrontLogs', `${stage.DOMAIN_NAME}-cloudfront-logs`, websiteBucketServerLogs);

    // Create and validate ACM certificate for HTTPS
    const customCertificate = this.createAndValidateCertificate(stage);

    // Create CloudFront Function for IP restriction (only for dev stage)
    let ipRestrictionFunction: cloudfront.Function | undefined;
    if (stage.STAGE_NAME === 'dev') {
      ipRestrictionFunction = this.createIpRestrictionFunction(
        stage
      );
    }

    // Create CloudFront distribution
    const distribution = this.createCloudFrontDistribution(
      websiteBucket,
      bucketCloudfrontLogs,
      customCertificate,
      stage,
      ipRestrictionFunction
    );

    // Deploy website content to the S3 bucket
    this.deployWebsiteContent(websiteBucket,distribution);

    // Manage DNS records for the website
    this.manageDNSRecords(distribution, stage);

    // Output important resource information
    this.outputResources(websiteBucketServerLogs, websiteBucket, bucketCloudfrontLogs, distribution);
  }

  /**
   * Creates an S3 bucket configured for logging purposes.
   * @param id - The logical ID of the bucket in the stack
   * @param bucketName - The name of the S3 bucket
   * @param serverAccessLogsBucket - Optional: A bucket to store access logs for this bucket
   * @returns An S3 Bucket instance
   */
  private createLogBucket(id: string, bucketName: string, serverAccessLogsBucket?: s3.IBucket): s3.Bucket {
    return new s3.Bucket(this, id, {
      bucketName,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy: RemovalPolicy.DESTROY,
      serverAccessLogsBucket,
      serverAccessLogsPrefix: serverAccessLogsBucket ? id : undefined,
    });
  }

  /**
   * Creates an S3 bucket configured to host the website content.
   * @param bucketName - The name of the S3 bucket
   * @param serverAccessLogsBucket - A bucket to store access logs for this bucket
   * @returns An S3 Bucket instance
   */
  private createWebsiteBucket(bucketName: string, serverAccessLogsBucket: s3.IBucket): s3.Bucket {
    return new s3.Bucket(this, 'WebsiteBucket', {
      bucketName,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      serverAccessLogsBucket,
      serverAccessLogsPrefix: 'Website',
    });
  }

  /**
   * Deploys the website content from the local 'dist' directory to the S3 bucket.
   * @param websiteBucket - The S3 bucket to deploy the content to
   */
  private deployWebsiteContent(
    websiteBucket: s3.IBucket,
    distribution: cloudfront.Distribution
  ): void {
    new s3deploy.BucketDeployment(this, 'BucketDeployment', {
      destinationBucket: websiteBucket,
      sources: [s3deploy.Source.asset(path.resolve(__dirname, '../../dist'))],
      distribution,
      distributionPaths: ['/*'],
    });
  }

  /**
   * Creates an IAM role for Lambda functions with necessary permissions.
   * @param id - The logical ID of the role in the stack
   * @param description - A description for the IAM role
   * @returns An IAM Role instance
   */
  private createLambdaRole(id: string, description: string): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description,
    });

    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    
    return role;
  }

  /**
   * Creates and validates an ACM certificate for the website's domain.
   * @param stage - The deployment stage configuration
   * @returns An ACM Certificate instance
   */
  private createAndValidateCertificate(stage: IStage): acm.ICertificate {
    // Create a custom IAM role for the Lambda function
    const lambdaRole = this.createLambdaRole('LambdaCustomRoleCertificateValidation', 'Custom role for Lambda with cross-account permissions to DNS account');
    
    // Add permissions to assume the cross-account role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [stage.CROSS_ACCOUNT_ROLE_ARN],
    }));

    // Add permissions to manage ACM certificates
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['acm:RequestCertificate', 'acm:DescribeCertificate', 'acm:DeleteCertificate'],
      resources: ['*'],
    }));

    // Create the Lambda function for certificate management
    const certificateLambda = new NodejsFunction(this, 'CertificateLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../functions/dnscertificatevalidation.ts'),
      role: lambdaRole,
      timeout: Duration.seconds(90),
    });

    // Create a custom resource provider using the Lambda function
    const certificateProvider = new customResources.Provider(this, 'CertificateProvider', {
      onEventHandler: certificateLambda,
    });

    // Create a custom resource to manage the ACM certificate
    const certificate = new cdk.CustomResource(this, 'CertificateCustomResource', {
      serviceToken: certificateProvider.serviceToken,
      properties: {
        CloudfrontCertificateRegion: stage.CLOUDFRONT_CERTIFICATE_REGION,
        CrossAccountRoleArn: stage.CROSS_ACCOUNT_ROLE_ARN,
        DomainName: stage.DOMAIN_NAME,
        SubjectAlternativeNames: stage.ALTERNATE_DOMAIN_NAME,
      },
    });

    // Output the certificate ARN
    const certificateArn = certificate.getAttString('CertificateArn');
    new CfnOutput(this, 'CertificateArn', { value: certificateArn });
    new CfnOutput(this, 'OldCertificateArn', { 
      value: certificate.getAttString('OldCertificateArn'),
      description: 'The ARN of the old certificate (N/A if no old certificate exists)',
    });

    return acm.Certificate.fromCertificateArn(this, 'CustomCertificate', certificateArn);
  }

  private createIpRestrictionFunction(
    stage: IStage
  ): cloudfront.Function {
    const functionCode = `
      function handler(event) {
          var allowedIPs = ${JSON.stringify(stage.DEV_ALLOWED_IP)};
          var clientIP = event.viewer.ip;

          // Log the client's IP address
          // console.log("Client IP Address: " + clientIP);

          // Check if the client's IP address is in the allowed list
          if (allowedIPs.indexOf(clientIP) === -1) {
              // If IP is not allowed, return a 403 Forbidden response
              return {
                  statusCode: 403,
                  statusDescription: 'Forbidden',
                  headers: {
                      'content-type': { value: 'text/plain' }
                  },
                  body: 'Access denied.'
              };
          }

          // If IP is allowed, continue with the request
          return event.request;
      }
    `;

    return new cloudfront.Function(this, 'IpRestrictionFunction', {
      code: cloudfront.FunctionCode.fromInline(functionCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
  }

  /**
   * Creates a CloudFront distribution for the website.
   * @param websiteBucket - The S3 bucket containing the website content
   * @param logBucket - The S3 bucket for CloudFront logs
   * @param certificate - The ACM certificate for HTTPS
   * @param stage - The deployment stage configuration
   * @returns A CloudFront Distribution instance
   */
  private createCloudFrontDistribution(
    websiteBucket: s3.IBucket,
    logBucket: s3.IBucket,
    certificate: acm.ICertificate,
    stage: IStage,
    ipRestrictionFunction?: cloudfront.Function
  ): cloudfront.Distribution {
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        compress: true,
        functionAssociations: ipRestrictionFunction
          ? [
              {
                function: ipRestrictionFunction,
                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              },
            ]
          : undefined,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/index.html',
        },
      ],
      logBucket,
      logFilePrefix: 'cdn/',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      domainNames: [stage.DOMAIN_NAME, ...stage.ALTERNATE_DOMAIN_NAME],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
    });

    return distribution;
  }

  /**
   * Manages DNS records for the website using a custom Lambda function.
   * @param distribution - The CloudFront distribution
   * @param stage - The deployment stage configuration
   */
  private manageDNSRecords(distribution: cloudfront.Distribution, stage: IStage): void {
    // Create a custom IAM role for the Lambda function
    const lambdaRole = this.createLambdaRole('DNSRecordsLambdaExecutionRole', 'Custom role for Lambda with cross-account permissions to DNS account');
    
    // Add permissions to assume the cross-account role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [stage.CROSS_ACCOUNT_ROLE_ARN],
    }));

    // Create the Lambda function for DNS record management
    const dnsRecordsLambda = new NodejsFunction(this, 'DNSRecordsLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../functions/crossaccountdnsrecords.ts'),
      role: lambdaRole,
      timeout: Duration.seconds(90),
    });

    // Create a custom resource provider using the Lambda function
    const dnsRecordsProvider = new customResources.Provider(this, 'DNSRecordsProvider', {
      onEventHandler: dnsRecordsLambda,
    });

    // Create a custom resource to manage DNS records
    new cdk.CustomResource(this, 'DNSRecordsCustomResource', {
      serviceToken: dnsRecordsProvider.serviceToken,
      properties: {
        CloudfrontURL: distribution.domainName,
        CrossAccountRoleArn: stage.CROSS_ACCOUNT_ROLE_ARN,
        DomainName: stage.DOMAIN_NAME,
        SubjectAlternativeNames: stage.ALTERNATE_DOMAIN_NAME,
      },
    });
  }

  /**
   * Outputs important resource information as CloudFormation outputs.
   * @param websiteBucketServerLogs - The S3 bucket for website server logs
   * @param websiteBucket - The S3 bucket containing the website content
   * @param bucketCloudfrontLogs - The S3 bucket for CloudFront logs
   * @param distribution - The CloudFront distribution
   */
  private outputResources(
    websiteBucketServerLogs: s3.IBucket,
    websiteBucket: s3.IBucket,
    bucketCloudfrontLogs: s3.IBucket,
    distribution: cloudfront.Distribution
  ): void {
    new CfnOutput(this, 'WebsiteBucketServerLogsName', { value: websiteBucketServerLogs.bucketName });
    new CfnOutput(this, 'WebsiteBucketName', { value: websiteBucket.bucketName });
    new CfnOutput(this, 'BucketCloudfrontLogsName', { value: bucketCloudfrontLogs.bucketName });
    new CfnOutput(this, 'DistributionURL', { value: `https://${distribution.domainName}` });
  }
}