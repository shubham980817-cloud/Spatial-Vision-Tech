# Spatial Vision Tech

The site uses Cloudflare Workers for its API, D1 for accounts and application data, R2 for student uploads, and Cloudflare Email Service for transactional email.

## Cloudflare setup and Git deployment

1. Install the project dependencies with `npm install`.
2. If they do not already exist, create the D1 database and R2 bucket:

   ```bash
   npx wrangler d1 create spatial-vision-tech
   npx wrangler r2 bucket create spatial-vision-tech-files
   ```

3. Copy the D1 database ID returned by Wrangler into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.
4. In the Cloudflare dashboard, onboard and verify `spatialvisiontech.in` with Email Service. The sender `admin@spatialvisiontech.in` must be allowed by the Worker binding. Configure the domain's required DNS records before expecting delivery.
5. In the Cloudflare dashboard, open the Worker named `admin` and set the `PASSWORD_PEPPER` secret (at least 32 random characters) and the one-time `ADMIN_BOOTSTRAP_TOKEN` secret under **Settings > Variables and Secrets**. Keep `PASSWORD_PEPPER` configured; losing it prevents password verification.
6. Apply the database schema when setting up a new database or when deploying new migrations:

   ```bash
   npm run db:migrate:remote
   ```

7. Connect the existing `admin` Worker to this Git repository in the Cloudflare dashboard: **Workers & Pages > admin > Settings > Builds > Connect**. Select the `main` production branch, set the root directory to `.`, leave the build command empty, and use `npx wrangler deploy` as the deploy command. The Worker name must match the `name` in `wrangler.jsonc`. Cloudflare Workers Builds then deploys commits from the selected branch; do not run a local deploy command.
8. The Wrangler configuration routes `spatialvisiontech.in/*` to the Worker. Confirm the domain is active in this Cloudflare zone before enabling the Git build. Before enabling preview deployments, configure separate preview bindings and data so previews do not use production resources.
9. Open `https://<your-site>/admin-setup.html` and create the first administrator using the setup token and a new password of at least 16 characters. After successful setup, remove the `ADMIN_BOOTSTRAP_TOKEN` secret in **Settings > Variables and Secrets**.

The Worker serves the static site and `/api/*` from the same origin. Update `SITE_URL` in `wrangler.jsonc` if the site will use a different public URL; it is used to build password reset links. Change `MAIL_FROM` and the Email Service sender allowlist together if the notification address changes.

## Application notifications

- A new registration sends a confirmation to the student and a review notice to `admin@spatialvisiontech.in`.
- Submitted course payments notify both the student and admin; admin verification sends a separate confirmation to the student.
- Uploading a PDF, image, or Word document from the student portal saves it to R2 and emails both the student and admin. Uploads are limited to 10 MB.
- Password reset requests send a one-hour reset link. Successful resets also send a password-changed confirmation.
- Contact form submissions and student approval-review requests notify the admin.
- Registration approval and Student Portal access grants notify the student.

Email is sent through the Cloudflare Email Service binding. Delivery requires an onboarded sender domain; configuring the binding alone is not sufficient.

Passwords are PBKDF2-derived in the browser before reaching the Worker so registration and sign-in can operate within Cloudflare Workers Free CPU limits. The Worker uses `PASSWORD_PEPPER` to protect stored verifiers.

## Student registrations and payments

The registration page records the ₹100 pre-registration payment for administrator review. After approval, students can submit course-fee installments from their portal. Admin verifies each transaction in the admin portal. Certificate eligibility continues to depend on verified payments reaching the finalized course fee.

Update the UPI ID and QR URLs in `register.html` and `student.html` if your payment account changes.

## Fresh backend

The D1 database starts with no application accounts or records. Students must register and choose a password. The first administrator account must be created with the one-time setup procedure above.

Run locally with `npm run db:migrate:local` followed by `npm run dev`. Local development does not deliver production notification emails.
