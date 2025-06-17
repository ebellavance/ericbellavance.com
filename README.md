# Eric Bellavance's Personal Website

[![PR Checks](https://github.com/ebellavance/ericbellavance.com/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/ebellavance/ericbellavance.com/actions/workflows/pr-checks.yml)

Personal website and portfolio of Eric Bellavance. This is a static website deployed using AWS CloudFront, S3, and ACM Certificate with DNS validation.

## Development Workflow

### Branching Strategy

- `main` - Production-ready code (deploys to production)
- `develop` - Integration branch for development (deploys to dev environment)
- `feature/*` - Feature branches (created from `develop`)

### Development Process

1. Create a feature branch from `develop`:

   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit them:

   ```bash
   git add .
   git commit -m "feat: Add new feature"
   ```

3. Push your changes and create a pull request:

   ```bash
   git push origin feature/your-feature-name
   # Then create a PR from feature/your-feature-name to develop
   ```

4. After code review, merge the PR to `develop`

   - This will trigger automated tests and deploy to the development environment

5. When ready to release, create a PR from `develop` to `main`
   - This will trigger a production deployment after merging

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- AWS CLI configured with appropriate credentials

### Local Development

1. Clone the repository:

   ```bash
   git clone git@github.com:ebellavance/ericbellavance.com.git
   cd ericbellavance.com
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

### Testing

Run the test suite:

```bash
npm test
```

### Building for Production

```bash
npm run build
```

This will create a production-ready build in the `build` directory.

## Infrastructure

### AWS Account Structure

This project uses multiple AWS accounts:

- **DNS account**: Manages Route 53 hosted zones
- **DEV account**: Hosts the development environment
- **PROD account**: Hosts the production environment

### Deployment

Deployment is handled automatically via GitHub Actions:

- Pushes to `develop` branch deploy to the DEV environment
- Merges to `main` branch deploy to PRODUCTION

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Development Workflow

### Branching Strategy

- `main` - Production-ready code
- `develop` - Integration branch for development
- `feature/*` - Feature branches (created from `develop`)

### Development Process

1. Create a feature branch from `develop`:

   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit them:

   ```bash
   git add .
   git commit -m "feat: Add new feature"
   ```

3. Push your changes and create a pull request:

   ```bash
   git push origin feature/your-feature-name
   # Then create a PR from feature/your-feature-name to develop
   ```

4. After code review, merge the PR to `develop`

   - This will trigger automated tests and deploy to the development environment

5. When ready to release, create a PR from `develop` to `main`
   - After merging to `main`, this will trigger a production deployment

## Infrastructure

### AWS Account Structure

This project uses 3 AWS accounts:

- DNS account
- DEV account
- PROD account

This example use 3 accounts:

- DNS account
- DEV account
- PROD account

## Before deploying

- Create a role in your DNS account who will be assumed by lambda functions of custom resources
- Update the constants.ts file with your informations before deploying

## Permission needed for the role in the DNS account

Adjust the permission for your needs if you want a more restricitve one.

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

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["arn:aws:iam::111111111111:root", "arn:aws:iam::222222222222:root"]
      },
      "Action": "sts:AssumeRole",
      "Condition": {}
    }
  ]
}
```

### dnscertificatevalidation

AWS Lambda function that manages SSL/TLS certificates using Amazon Certificate Manager (ACM) and Amazon Route 53.

**Imports:**
The code starts by importing necessary modules from AWS SDK v3 for interacting with ACM, Route 53, and STS (Security Token Service).

**Interface Definitions:**
It defines TypeScript interfaces for ResourceProperties and Event, which structure the input data for the Lambda function.

**Main Functions:**

- **requestCertificate:**
  Requests a new SSL/TLS certificate from ACM.

- **waitForCertificateValidation:**
  Polls the ACM service to check if a certificate has been issued.

- **assumeCrossAccountRole:**
  Assumes an IAM role in another AWS account to access Route 53.

**Lambda Handler:**
The exports.handler function is the main entry point for the Lambda. It handles three types of events:

- **Create:**
  Requests a new certificate
  Creates DNS validation records in Route 53
  Waits for the certificate to be issued

- **Update:**
  Checks if the domain or alternative names have changed.
  If changed, requests a new certificate and deletes the old one
  Updates DNS validation records
  Waits for the new certificate to be issued

- **Delete:**
  Deletes the specified certificate

**Certificate Validation Process:**
After requesting a certificate, it fetches the validation records from ACM
It then finds the correct Route 53 hosted zone for each domain
Creates or updates CNAME records in Route 53 for domain validation
Waits for the certificate to be fully validated and issued

**Error Handling:**
The code includes try-catch blocks to handle and log errors during the process.
