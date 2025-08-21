# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is Eric Bellavance's personal portfolio website built as a static site deployed on AWS using AWS CDK for Infrastructure as Code (IaC). The project creates a CloudFront distribution serving content from S3 with ACM certificates and custom DNS management across multiple AWS accounts.

## Architecture

### Multi-Account AWS Structure

- **DNS Account**: Manages Route 53 hosted zones
- **DEV Account**: Development environment deployment
- **PROD Account**: Production environment deployment

### Key Infrastructure Components

- **S3 Buckets**: Website content storage and access logging
- **CloudFront**: CDN with custom SSL certificates and optional IP restriction for dev
- **ACM Certificates**: SSL/TLS certificates with DNS validation
- **Lambda Functions**: Custom resources for cross-account DNS management and certificate validation
- **Route 53**: DNS records managed via cross-account IAM roles

### Code Structure

```
src/
├── infra/              # AWS CDK infrastructure code
│   ├── main.ts         # CDK app entry point
│   ├── constants.ts    # Environment configuration and stage management
│   ├── model.ts        # TypeScript interfaces and types
│   └── stacks/
│       └── WebsiteStack.ts  # Main infrastructure stack
├── functions/          # Lambda functions for custom resources
│   ├── crossaccountdnsrecords.ts    # DNS record management
│   └── dnscertificatevalidation.ts  # ACM certificate handling
└── dist/               # Static website content (HTML, CSS, images)
```

## Environment Configuration

Configuration is managed through environment variables and the `constants.ts` file:

- **Stage-based configuration**: Uses `dev` and `prod` stages
- **Cross-account IAM roles**: Required for DNS and certificate operations
- **IP restriction**: Development environment supports IP allowlisting via CloudFront functions

### Required Environment Variables

```
CROSS_ACCOUNT_ROLE_ARN=arn:aws:iam::DNS_ACCOUNT:role/CrossAccountRole
DNS_ACCOUNT=123456789012
DEV_ACCOUNT_NUMBER=111111111111
PROD_ACCOUNT_NUMBER=222222222222
DEV_ALLOWED_IPS=1.2.3.4,5.6.7.8  # For dev environment only
```

## Development Commands

### Linting and Code Quality

```bash
npm run lint                    # Run all linting (ESLint + Prettier + CDK synth)
npm run lint:eslint             # ESLint only
npm run lint:prettier           # Prettier check only
npm run lint:ts                 # TypeScript type checking
npm run lint:fix                # Fix ESLint and Prettier issues
```

### CDK Operations

```bash
npm run synth:dev               # Synthesize CloudFormation for dev
npm run synth:prod              # Synthesize CloudFormation for prod
npm run diff:dev                # Show diff for dev environment
npm run diff:prod               # Show diff for prod environment
npm run deploy:dev              # Deploy to dev environment
npm run deploy:prod             # Deploy to prod environment
npm run destroy:dev             # Destroy dev environment
npm run destroy:prod            # Destroy prod environment
```

### Formatting

```bash
npm run format                  # Format code with Prettier
```

## Deployment Process

### Branch Strategy

- `main`: Production deployments (auto-deploy via GitHub Actions)
- `develop`: Development deployments (auto-deploy via GitHub Actions)
- `feature/*`: Feature branches (merge to develop)
- `hotfix/*`: Emergency fixes (can merge directly to main)

### Automated CI/CD

- **PR Checks**: Linting and validation on all PRs
- **Dev Deployment**: Auto-deploy when pushing to `develop` branch
- **Prod Deployment**: Auto-deploy when merging to `main` branch
- **Branch Protection**: Only `develop` and `hotfix/*` branches can merge to `main`

## Custom Resources

### Certificate Management (`dnscertificatevalidation.ts`)

- Requests ACM certificates with DNS validation
- Creates Route 53 validation records in the DNS account
- Handles certificate lifecycle (create, update, delete)
- Manages cross-account Route 53 permissions via STS assume role

### DNS Record Management (`crossaccountdnsrecords.ts`)

- Creates A and AAAA records pointing to CloudFront distribution
- Manages both primary domain and alternate domain names
- Uses cross-account IAM roles to write to DNS account Route 53

## Testing

Currently uses basic linting and TypeScript compilation checks. No unit tests are configured - the `npm test` command will exit with an error.

## Cross-Account Permissions

The DNS account role requires these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["route53:ChangeResourceRecordSets", "route53:ListHostedZones", "route53:ListHostedZonesByName"],
      "Resource": "*"
    }
  ]
}
```

Trust relationship allows dev and prod accounts to assume the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["arn:aws:iam::DEV_ACCOUNT:root", "arn:aws:iam::PROD_ACCOUNT:root"]
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```
