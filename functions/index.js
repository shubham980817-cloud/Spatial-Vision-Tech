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

function createSmtpTransport() {
  const port = Number(SMTP_PORT.value());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid port number.');
  }

  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
  });
}

function sendStudentEmail(student, subject, text) {
  if (typeof student.email !== 'string' || !student.email.trim()) {
    throw new Error('Student record has no email address for notification.');
  }

  return createSmtpTransport().sendMail({
    from: SMTP_FROM.value(),
    to: student.email.trim(),
    subject,
    text
  });
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
  if (typeof student.email !== 'string' || !student.email.trim()) {
    throw new HttpsError('failed-precondition', 'Student record has no registered email address.');
  }

  let studentUser;
  try {
    studentUser = await admin.auth().getUser(student.uid || studentUid);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') {
      console.error('Unable to look up student Auth account:', error.code || error.message);
      throw new HttpsError('internal', `Unable to look up the student Auth account (${error.code || 'unknown'}).`);
    }

    try {
      studentUser = await admin.auth().getUserByEmail(student.email.trim());
    } catch (emailError) {
      if (emailError.code === 'auth/user-not-found') {
        throw new HttpsError('not-found', 'No Firebase Authentication account matches this student email.');
      }
      console.error('Unable to find student Auth account by email:', emailError.code || emailError.message);
      throw new HttpsError('internal', `Unable to look up the student Auth account by email (${emailError.code || 'unknown'}).`);
    }
  }

  if (studentUser.email?.toLowerCase() !== student.email.trim().toLowerCase()) {
    throw new HttpsError('failed-precondition', 'Student record does not match its Firebase account.');
  }

  try {
    await admin.auth().updateUser(studentUser.uid, { password });
  } catch (error) {
    console.error('Unable to update student Auth password:', error.code || error.message);
    if (error.code === 'auth/invalid-password') {
      throw new HttpsError('invalid-argument', 'Firebase rejected this password. Choose a stronger password and try again.');
    }
    throw new HttpsError('internal', `Firebase could not update this password (${error.code || 'unknown'}).`);
  }
  return { success: true };
});

exports.notifyStudentRegistration = onDocumentCreated({
  document: 'students/{studentId}',
  secrets: SMTP_SECRETS,
  retry: true
}, async event => {
  const student = event.data.data();
  await sendStudentEmail(
    student,
    'Spatial Vision Tech registration received',
    `Hello ${student.name || 'Student'},\n\nWe received your registration for ${student.course || 'the BIM course'} and your ₹100 pre-registration payment submission. An administrator will verify the UPI transaction. We will email you after your registration is approved.`
  );
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

  await Promise.all(messages.map(message => sendStudentEmail(after, message.subject, message.text)));
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
