# Free hosting option for Spatial Vision Tech

This folder contains a no-Firebase version of the student portal that runs entirely in the browser using localStorage.

## Why this is useful

This is a practical free alternative if you want to avoid Firebase billing. It works on:

- GitHub Pages
- Cloudflare Pages
- Netlify

## Included pages

- register.html — student registration and ₹100 payment submission
- student.html — student login, fee payment, receipts
- admin.html — admin login, approval, portal access, temporary passwords
- storage.js — localStorage-based data layer

## Default admin login

- Email: admin@spatialvisiontech.in
- Password: Admin@123456

## Deployment

1. Upload the entire free-stack folder to any static host.
2. Point the host to the folder as the public root.
3. Open the register page to create a student account.

## Note

This is a free static implementation. It is not a replacement for enterprise-grade authentication, email delivery, or production data persistence. It is best for a low-cost or no-cost deployment.
