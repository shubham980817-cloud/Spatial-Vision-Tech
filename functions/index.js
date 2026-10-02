const admin = require('firebase-admin');
const { google } = require('googleapis');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const nodemailer = require('nodemailer');

admin.initializeApp();

const ADMIN_EMAIL = 'admin@spatialvisiontech.in';
const SMTP_HOST = defineSecret('SMTP_HOST');
const SMTP_PORT = defineSecret('SMTP_PORT');
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const SMTP_FROM = defineSecret('SMTP_FROM');
const SMTP_SECRETS = [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM];
const spreadsheetId = () => process.env.GOOGLE_SHEET_ID;
let sheetsClientPromise;

async function getSheetsClient() {
  if (!spreadsheetId()) {
    throw new Error('Missing sheets.id Firebase runtime configuration.');
  }

  if (!sheetsClientPromise) {
    sheetsClientPromise = google.auth.getClient({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    }).then(auth => google.sheets({ version: 'v4', auth }));
  }

  return sheetsClientPromise;
}

async function ensureSheet(sheets, title, headers) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: 'sheets.properties.title'
  });
  const titles = (spreadsheet.data.sheets || []).map(sheet => sheet.properties.title);

  if (!titles.includes(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
}

async function appendRow(title, headers, row) {
  const sheets = await getSheetsClient();
  await ensureSheet(sheets, title, headers);
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${title}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

function json(value) {
  return JSON.stringify(value || {});
}

exports.setStudentPassword = onCall(async request => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in as an administrator to continue.');
  }

  const adminEmail = request.auth.token.email;
  if (typeof adminEmail !== 'string' || adminEmail.toLowerCase() !== ADMIN_EMAIL || request.auth.token.email_verified !== true) {
    throw new HttpsError('permission-denied', 'Only the verified designated administrator can set student passwords.');
  }

  const { studentUid, password } = request.data || {};
  if (typeof studentUid !== 'string' || !studentUid || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new HttpsError('invalid-argument', 'Provide a student account and a password between 12 and 128 characters.');
  }

  const studentSnapshot = await admin.firestore().collection('students').doc(studentUid).get();
  if (!studentSnapshot.exists) {
    throw new HttpsError('not-found', 'Student record not found.');
  }

  const student = studentSnapshot.data();
  const studentUser = await admin.auth().getUser(studentUid);
  if (typeof student.email !== 'string' || studentUser.email?.toLowerCase() !== student.email.toLowerCase()) {
    throw new HttpsError('failed-precondition', 'Student record does not match its Firebase account.');
  }

  await admin.auth().updateUser(studentUid, { password });
  return { success: true };
});

exports.notifyStudentMilestones = onDocumentUpdated({
  document: 'students/{studentId}',
  secrets: SMTP_SECRETS,
  retry: true
}, async event => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const registrationApproved = before.approvalStatus !== 'Approved'
    && after.approvalStatus === 'Approved'
    && after.preRegistrationPaid === true;
  const portalAccessGranted = before.grantedAccess !== true && after.grantedAccess === true;

  if (!registrationApproved && !portalAccessGranted) return;
  if (typeof after.email !== 'string' || !after.email.trim()) {
    throw new Error(`Student ${event.params.studentId} has no email address for milestone notification.`);
  }

  const port = Number(SMTP_PORT.value());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid port number.');
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
  });
  const messages = [];

  if (registrationApproved) {
    messages.push({
      subject: 'INR 100 registration payment verified',
      text: `Hello ${after.name || 'Student'},\n\nYour INR 100 pre-registration payment has been verified and your registration is approved. You can sign in to your Spatial Vision Tech student account. Portal access is granted separately; we will email you again when it is enabled.`
    });
  }

  if (portalAccessGranted) {
    messages.push({
      subject: 'Spatial Vision Tech Student Portal access granted',
      text: `Hello ${after.name || 'Student'},\n\nYour Student Portal access has been granted. Sign in to the Spatial Vision Tech Student Portal using your registered email address and password.`
    });
  }

  await Promise.all(messages.map(message => transporter.sendMail({
    from: SMTP_FROM.value(),
    to: after.email.trim(),
    subject: message.subject,
    text: message.text
  })));
});

exports.exportRegistration = onDocumentCreated('students/{studentId}', async event => {
    const snapshot = event.data;
    const student = snapshot.data();
    await appendRow('Registrations', [
      'Recorded At', 'Student ID', 'Firebase UID', 'Name', 'Email', 'Phone',
      'Course', 'Registration Date', 'Approval Status', 'Registration Payment Status',
      'Registration UTR'
    ], [
      new Date().toISOString(), student.studentId || '', student.uid || event.params.studentId,
      student.name || '', student.email || '', student.phone || '', student.course || '',
      student.regDate || '', student.approvalStatus || '', student.regPaymentStatus || '',
      student.regUtr || ''
    ]);
  });

exports.exportStudentUpdates = onDocumentUpdated('students/{studentId}', async event => {
    const change = event.data;
    const before = change.before.data();
    const after = change.after.data();
    const tasks = [];
    const oldFees = before.feeHistory || [];
    const newFees = after.feeHistory || [];
    const oldAttempts = before.testAttempts || [];
    const newAttempts = after.testAttempts || [];

    newFees.slice(oldFees.length).forEach(fee => {
      tasks.push(appendRow('Payments', [
        'Recorded At', 'Student ID', 'Name', 'Email', 'Course', 'Receipt Number',
        'Fee Type', 'Amount', 'UTR', 'Status', 'Payment Date', 'Verified At'
      ], [
        new Date().toISOString(), after.studentId || event.params.studentId, after.name || '',
        after.email || '', after.course || '', fee.receiptNo || '', fee.type || '', fee.amount || '',
        fee.utr || '', fee.status || 'Recorded', fee.date || '', fee.verifiedAt || ''
      ]));
    });

    newAttempts.slice(oldAttempts.length).forEach(attempt => {
      tasks.push(appendRow('Performance', [
        'Recorded At', 'Student ID', 'Name', 'Email', 'Course', 'Score', 'Completed At', 'Answers'
      ], [
        new Date().toISOString(), after.studentId || event.params.studentId, after.name || '',
        after.email || '', after.course || '', attempt.score ?? '', attempt.completedAt || '', json(attempt.answers)
      ]));
    });

    await Promise.all(tasks);
  });

exports.exportEnquiry = onDocumentCreated('enquiries/{enquiryId}', async event => {
    const snapshot = event.data;
    const enquiry = snapshot.data();
    await appendRow('Enquiries', [
      'Recorded At', 'Enquiry ID', 'Name', 'Email', 'Phone', 'Message'
    ], [
      enquiry.createdAt || new Date().toISOString(), event.params.enquiryId,
      enquiry.name || '', enquiry.email || '', enquiry.phone || '', enquiry.message || ''
    ]);
  });
