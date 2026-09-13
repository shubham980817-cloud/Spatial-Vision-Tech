# Spatial Vision Tech

## Cashfree setup

The site uses Firebase Cloud Functions for Cashfree payments. The browser creates an authenticated order, Cashfree processes the payment, and the signed webhook updates Firestore. Admin approval is still required after the ₹5,000 registration payment is verified.

Install the Firebase CLI, log in, and install the function dependencies:

```bash
cd functions
npm install
cd ..
```

Set the Cashfree credentials as Firebase secrets. Use sandbox credentials while testing:

```bash
firebase functions:secrets:set CASHFREE_CLIENT_ID
firebase functions:secrets:set CASHFREE_CLIENT_SECRET
```

Copy `functions/.env.example` to `functions/.env` and replace `APP_BASE_URL` with the deployed website URL. Keep `functions/.env` private. Then deploy:

```bash
firebase deploy --only functions,hosting
```

In the Cashfree dashboard, configure the webhook endpoint:

```text
https://us-central1-spatial-vision-tech.cloudfunctions.net/cashfreeWebhook
```

Subscribe to order/payment success and failure events. Switch `mode: "sandbox"` to `mode: "production"` in `register.html` and `student.html` only after production credentials and webhook testing are complete.