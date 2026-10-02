# Spatial Vision Tech

## PhonePe / UPI payment setup

The site uses a PhonePe-compatible UPI QR for the ₹100 pre-registration fee, ₹4,900 final registration fee, and each course installment. Students submit the UPI transaction ID after payment, receive a downloadable receipt marked as pending verification, and admin verifies the transaction before approval.

Registration is staged: students first submit ₹100 for pre-registration. After admin approval, they can submit the remaining ₹4,900 final registration fee. Admin can set each student's finalized fee, verify submitted payments individually, and certificates unlock only when verified payments reach that finalized fee.

The ₹100 UPI transaction ID is submitted for manual admin verification; entering a UTR does not automatically prove payment. After the admin verifies and approves the registration, the student receives an email. A separate email is sent when portal access is granted.

Update the UPI ID and QR URLs in `register.html` and `student.html` if your payment account changes. Deploy the static site with:

```bash
firebase deploy --only hosting
```

## Google Sheets data export

The Firebase backend exports registrations, verified payment submissions, performance results, and contact enquiries to separate tabs in one Google Sheet.

1. Create a Google Sheet in the `spatialvisiontech` Google account and copy its ID from the URL.
2. Enable the Google Sheets API in the Google Cloud project `spatial-vision-tech`.
3. Create `functions/.env` from `functions/.env.example` and set `GOOGLE_SHEET_ID` to the copied Sheet ID.
4. Share the Sheet with the Firebase App Engine service account, usually `spatial-vision-tech@appspot.gserviceaccount.com`, as Editor. The exact account is shown in Firebase Console under Project settings > Service accounts.
5. Make sure the Firestore rules allow signed-in registration/student writes and public creation of valid `enquiries` records. The enquiry form now saves to Firestore before opening the visitor's email app.
6. Install and deploy the backend and hosting:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,hosting
```

The backend creates `Registrations`, `Payments`, `Performance`, and `Enquiries` tabs automatically the first time data is received. Google Sheets can download the workbook as `.xlsx` at any time.

## Student email notifications

`notifyStudentRegistration` sends a confirmation when the registration record is created. `notifyStudentMilestones` sends separate notices after the ₹100 payment is verified and registration approved, and when portal access is granted. These messages use SMTP. Choose a provider that permits sending from your verified sender address, then set these Firebase Secrets (enter each value at the CLI prompt; do not commit SMTP credentials):

```bash
firebase functions:secrets:set SMTP_HOST
firebase functions:secrets:set SMTP_PORT
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
firebase functions:secrets:set SMTP_FROM
```

`SMTP_FROM` should be the sender address/name verified with that provider, for example `Spatial Vision Tech <admin@spatialvisiontech.in>`. Configure SPF/DKIM for the sender domain with the provider. Gmail addresses are valid recipients without an allowlist; `gmail.com` is not a website authorized domain and should not be added under Firebase Authentication > Authorized domains. If you use Gmail SMTP as the sender, use `smtp.gmail.com`, the Gmail account as `SMTP_USER`, and a Google App Password as `SMTP_PASS` (not the account password). Then deploy:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions:notifyStudentRegistration,functions:notifyStudentMilestones,hosting
```

Password-reset emails still use Firebase Authentication's built-in `sendPasswordResetEmail` flow and its Authentication > Templates > Password reset configuration. This message is addressed to the student's registered email; Gmail recipients need no domain allowlist. The SMTP secrets above do not change Firebase's built-in password-reset sender.

## Student password resets

Password reset requests are sent to the email address entered by the student. They are not sent to the administrator unless that address is also the student's Firebase Authentication email. Firebase uses the project's configured password-reset email template and default sender; the admin address is not automatically the sender.

If a student does not receive the link, confirm the exact email on their Firebase Authentication user, check spam/junk, then review Authentication > Templates > Password reset in Firebase Console for `spatial-vision-tech`. Confirm Authentication > Sign-in method has Email/Password enabled and that the site's hosting domain is listed under Authentication > Settings > Authorized domains. Firebase may show a generic success message even when no user exists for the entered address.

Admins can set a temporary password from the student row in `admin.html`. The signed-in account must be the verified `admin@spatialvisiontech.in` Firebase Auth user; confirm its email is marked verified in Firebase Console > Authentication > Users. Passwords must be 12-128 characters and should be shared with the student through a secure channel. Deploy the callable function and hosting update with:

```bash
firebase deploy --only functions:setStudentPassword,hosting
```