# aws-event-hub

Serverless QR-code ticketing for a single event. Attendees register on a web form and get a signed QR ticket by email. Volunteers scan tickets at the door with a phone browser, and each ticket can be checked in once.

## Features

- **Registration** (`POST /register`): checks name, email and roll number, saves the attendee in DynamoDB, and emails a QR code as an inline PNG through SES.
- **One ticket per email:** the ticket ID is `sha256(email)` (first 16 hex chars). If someone registers again with the same email, they get their existing ticket again and no duplicate is created.
- **Signed QR codes:** the payload is `<ticketId>.<hmac>`, where `hmac` is HMAC-SHA256 of the ID with `SECRET`, cut to 24 hex chars. The signature is compared in constant time, so forged or damaged codes are rejected.
- **Check-in** (`POST /checkin`): requires the `x-volunteer-pin` header. It sets `checkedInAt` with a conditional write, so a ticket can't be used twice. A repeat scan returns `409` with the original check-in time.
- **Scanner page** (`scan.html`): volunteers enter the PIN, then scan with the rear camera using `html5-qrcode`. The page flashes green or red with the attendee's name and the reason for a rejection, then resumes scanning after 2 seconds.
- **No build step:** the frontend is two static HTML files, and the backend is one Lambda handler.

## Prerequisites

- An AWS account and AWS CLI v2, with permission to manage Lambda, API Gateway (HTTP APIs), DynamoDB, SES and IAM.
- Node.js 18 or newer and npm, to install the one Lambda dependency (`qrcode@^1.5.4`).
- A Lambda runtime of `nodejs18.x` or newer. The handler imports `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` and `@aws-sdk/client-ses` from the AWS SDK v3 that ships with the runtime. They are not listed in `package.json`.
- An email address or domain verified in SES. While SES is in sandbox mode, recipient addresses must be verified too.
- HTTPS hosting for the HTML files. Browsers only allow camera access on HTTPS or `localhost`.

## Quickstart

Replace the `<...>` placeholders. The examples use `ap-south-1`.

```bash
# 1. DynamoDB table (partition key: ticketId, string)
aws dynamodb create-table \
  --table-name event-tickets \
  --attribute-definitions AttributeName=ticketId,AttributeType=S \
  --key-schema AttributeName=ticketId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# 2. Verify the sender address in SES (click the link in the email it sends)
aws ses verify-email-identity --email-address <you@example.com>

# 3. Package the Lambda
cd lambda
npm ci
zip -r ../function.zip index.mjs package.json node_modules
cd ..
```

Create an IAM execution role for the function that has `AWSLambdaBasicExecutionRole` plus this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:<region>:<account-id>:table/event-tickets" },
    { "Effect": "Allow", "Action": "ses:SendRawEmail", "Resource": "*" }
  ]
}
```

```bash
# 4. Create the function
aws lambda create-function \
  --function-name event-hub \
  --runtime nodejs20.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::<account-id>:role/<role-name> \
  --environment "Variables={TABLE=event-tickets,SECRET=<long-random-string>,VOLUNTEER_PIN=<pin>,FROM_EMAIL=<you@example.com>,EVENT_NAME=<Event Name>}"

# 5. HTTP API (payload v2.0, $default route, auto-deployed stage) with CORS
aws apigatewayv2 create-api \
  --name event-hub \
  --protocol-type HTTP \
  --target arn:aws:lambda:<region>:<account-id>:function:event-hub \
  --cors-configuration AllowOrigins='*',AllowMethods=POST,AllowHeaders=content-type,x-volunteer-pin
# Note the ApiEndpoint and ApiId in the output.

# 6. Allow API Gateway to invoke the function
aws lambda add-permission \
  --function-name event-hub \
  --statement-id apigw-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:<region>:<account-id>:<api-id>/*"
```

Then set `API_BASE` in **both** `index.html` and `scan.html` to the `ApiEndpoint` value, and serve the files:

```bash
python3 -m http.server 8000
# http://localhost:8000/index.html  - registration
# http://localhost:8000/scan.html   - volunteer scanner (use an HTTPS host when scanning from a phone)
```

Smoke test:

```bash
curl -X POST <api-endpoint>/register \
  -H 'content-type: application/json' \
  -d '{"name":"Test User","email":"<verified@example.com>","roll":"21BCE0001"}'
```

## Configuration

Lambda environment variables (`lambda/index.mjs`):

| Variable        | Purpose |
|-----------------|---------|
| `TABLE`         | DynamoDB table name. Partition key is `ticketId` (string). |
| `SECRET`        | HMAC key for signing QR payloads. Changing it invalidates every ticket already issued. |
| `VOLUNTEER_PIN` | Shared PIN that must match the `x-volunteer-pin` header on `/checkin`. `scan.html` limits input to 6 characters. |
| `FROM_EMAIL`    | Sender address for ticket emails. Must be verified in SES. |
| `EVENT_NAME`    | Used in the email subject and heading. Defaults to "Event" / "the event". |

Frontend constants:

| File         | Constant     | Purpose |
|--------------|--------------|---------|
| `index.html` | `API_BASE`   | API Gateway base URL (no trailing slash). |
| `index.html` | `API_FIELDS` | Maps form fields to request body keys. Leave as is unless you change the API. |
| `scan.html`  | `API_BASE`   | Same base URL as above. |

API responses are JSON in the form `{ ok, reason?, name? }`:

| Endpoint   | Status codes |
|------------|--------------|
| `register` | `200`, `400` (invalid input), `500` |
| `checkin`  | `200`, `400` (bad signature), `401` (wrong PIN), `404` (unknown ticket), `409` (already checked in), `500` |

Unknown paths return `404`.

## Project structure

```
index.html         Attendee registration form; POSTs to /register
scan.html          Volunteer PIN screen and camera QR scanner; POSTs to /checkin
lambda/
  index.mjs        Lambda handler: routing, registration, SES email with QR, check-in
  package.json     Declares the qrcode dependency (AWS SDK v3 comes from the Lambda runtime)
```

DynamoDB item shape: `{ ticketId, name, email, roll, createdAt, checkedInAt? }`.

Notes:
- The repo has no infrastructure-as-code. Every resource above is created by hand.
- `scan.html` loads `html5-qrcode` from unpkg without a pinned version. Pin it (for example `https://unpkg.com/html5-qrcode@2.3.8`) before using it at a real event.
- When the scanner starts, it validates the PIN by sending a dummy `/checkin` request. Any response other than `401` counts as a valid PIN.

## License / Contributing

The repo has no license file. `lambda/package.json` declares `ISC`, but that covers only the Lambda package. There are no tests or CI. If you open a PR, test it against a deployed stack and describe what you tested.
