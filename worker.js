const ADMIN_EMAIL = 'admin@spatialvisiontech.in';
const SESSION_COOKIE = 'svt_session';
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 600000;
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,12}$/;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const encoder = new TextEncoder();

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function fail(message, status = 400) {
  return response({ error: message }, status);
}

function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(env, value) {
  if (typeof env.PASSWORD_PEPPER !== 'string' || env.PASSWORD_PEPPER.length < 32) {
    throw new Error('PASSWORD_PEPPER must be configured as a secret with at least 32 characters.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.PASSWORD_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordSalt(email, env) {
  return encodeBase64((await hmac(env, `salt:${email}`)).slice(0, 16));
}

function isValidVerifier(value) {
  try {
    return typeof value === 'string' && decodeBase64(value).length === 32;
  } catch {
    return false;
  }
}

function isValidPassword(value) {
  return typeof value === 'string' && PASSWORD_PATTERN.test(value);
}

async function hashPasswordVerifier(verifier, env) {
  if (!isValidVerifier(verifier)) throw new Error('Password verifier is invalid.');
  return bytesToHex(await hmac(env, `password:${verifier}`));
}

function secureStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function encodeBase64(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodeBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const item = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}

function cookieHeader(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 1024 * 1024) throw new Error('Request body is too large.');
  return request.json();
}

async function requireUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const session = await env.DB.prepare(`
    SELECT users.id, users.email, users.role, users.created_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(await digest(token), new Date().toISOString()).first();
  return session || null;
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!user) return { error: fail('Sign in to continue.', 401) };
  if (user.role !== 'admin') return { error: fail('Administrator access is required.', 403) };
  return { user };
}

async function sendEmail(env, to, subject, text) {
  if (!env.EMAIL || !env.MAIL_FROM) throw new Error('Cloudflare Email Service is not configured.');
  if (typeof to !== 'string' || !to.trim()) throw new Error('Email recipient is missing.');
  await env.EMAIL.send({
    from: { email: env.MAIL_FROM, name: 'Spatial Vision Tech' },
    to,
    subject,
    text
  });
}

function studentSummary(student) {
  return [
    `Name: ${student.name || 'Not provided'}`,
    `Student ID: ${student.studentId || 'Not assigned'}`,
    `Email: ${student.email || 'Not provided'}`,
    `Phone: ${student.phone || 'Not provided'}`,
    `Course: ${student.course || 'Not provided'}`
  ].join('\n');
}

async function attemptEmails(env, messages) {
  const outcomes = await Promise.allSettled(messages.map(message =>
    sendEmail(env, message.to, message.subject, message.text)
  ));
  const failures = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'fulfilled') return [];
    console.error('Email notification delivery failed:', messages[index].subject, outcome.reason);
    return [messages[index].to];
  });
  return failures;
}

async function rateLimit(env, key, limit, periodSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (key, window_started_at, count)
    VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_started_at <= ? THEN 1
        ELSE rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN rate_limits.window_started_at <= ? THEN excluded.window_started_at
        ELSE rate_limits.window_started_at
      END
    RETURNING count
  `).bind(key, now, now - periodSeconds, now - periodSeconds).first();
  return row.count <= limit;
}

function safeCollectionName(value) {
  return new Set(['students', 'practiceTests', 'enquiries']).has(value);
}

function parseData(row) {
  return row ? JSON.parse(row.data) : null;
}

function publicPracticeTest(test) {
  return {
    title: test.title,
    active: test.active !== false,
    updatedAt: test.updatedAt || null,
    questions: (Array.isArray(test.questions) ? test.questions : []).map(({ id, text, options }) => ({ id, text, options }))
  };
}

function validPracticeTest(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 160) return false;
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 100) return false;
  const ids = new Set();
  return input.questions.every(question => {
    if (!question || typeof question.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(question.id) ||
        ids.has(question.id) || typeof question.text !== 'string' || !question.text.trim() || question.text.length > 1000 ||
        !question.options || ['a', 'b', 'c'].some(key => typeof question.options[key] !== 'string' ||
          !question.options[key].trim() || question.options[key].length > 500) ||
        !['a', 'b', 'c'].includes(question.correct)) return false;
    ids.add(question.id);
    return true;
  });
}

async function handlePracticeTests(request, env, pathname) {
  if (pathname === '/api/practice-tests' && request.method === 'GET') {
    const user = await requireUser(request, env);
    if (!user) return fail('Sign in to access practice tests.', 401);
    const rows = await env.DB.prepare('SELECT id, data FROM documents WHERE collection = ? ORDER BY created_at DESC')
      .bind('practiceTests').all();
    const documents = rows.results
      .map(row => ({ id: row.id, data: parseData(row) }))
      .filter(document => document.data && (user.role === 'admin' || document.data.active !== false))
      .map(document => ({ ...document, data: user.role === 'admin' ? document.data : publicPracticeTest(document.data) }));
    return response({ documents });
  }

  if (pathname === '/api/practice-tests/attempts' && request.method === 'GET') {
    const user = await requireUser(request, env);
    if (!user) return fail('Sign in to access test history.', 401);
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const statement = user.role === 'admin'
        ? env.DB.prepare(`
            SELECT attempts.*, students.data AS student_data
            FROM practice_attempts AS attempts
            LEFT JOIN documents AS students
              ON students.collection = 'students' AND students.id = attempts.student_id
            ORDER BY attempts.created_at DESC, attempts.id DESC
            LIMIT 500 OFFSET ?
          `).bind(offset)
        : env.DB.prepare(`
            SELECT id, student_id, test_id, test_title, score, correct_count, question_count, created_at
            FROM practice_attempts WHERE student_id = ? ORDER BY created_at DESC, id DESC LIMIT 500 OFFSET ?
          `).bind(user.id, offset);
      const page = await statement.all();
      rows.push(...page.results);
      if (page.results.length < 500) break;
    }
    const attempts = rows.map(row => {
      const attempt = {
        id: row.id,
        testId: row.test_id,
        title: row.test_title,
        score: row.score,
        correct: row.correct_count,
        total: row.question_count,
        date: row.created_at
      };
      if (user.role === 'admin') {
        const student = row.student_data ? JSON.parse(row.student_data) : {};
        attempt.studentId = row.student_id;
        attempt.studentName = student.name || student.email || 'Deleted student';
        attempt.studentEmail = student.email || '';
        attempt.answers = JSON.parse(row.answers);
        attempt.testSnapshot = JSON.parse(row.test_snapshot);
      }
      return attempt;
    });
    return response({ attempts });
  }

  const attemptMatch = /^\/api\/practice-tests\/([a-zA-Z0-9_-]{1,100})\/attempts$/.exec(pathname);
  if (attemptMatch && request.method === 'POST') {
    const user = await requireUser(request, env);
    if (!user) return fail('Sign in to submit a test.', 401);
    if (user.role !== 'student') return fail('Only student accounts can submit practice tests.', 403);
    const testRow = await env.DB.prepare('SELECT data FROM documents WHERE collection = ? AND id = ?')
      .bind('practiceTests', attemptMatch[1]).first();
    const test = parseData(testRow);
    if (!test || test.active === false || !validPracticeTest(test)) return fail('This test is unavailable.', 404);
    const input = await readJson(request);
    const answers = input.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) ||
        Object.keys(answers).length !== test.questions.length) return fail('Answer every question before submitting.');
    let correctCount = 0;
    const normalizedAnswers = [];
    for (const question of test.questions) {
      const selected = answers[question.id];
      if (!['a', 'b', 'c'].includes(selected)) return fail('Provide one valid answer for every question.');
      if (selected === question.correct) correctCount += 1;
      normalizedAnswers.push({ questionId: question.id, selected });
    }
    const createdAt = new Date().toISOString();
    const attempt = {
      id: crypto.randomUUID(),
      studentId: user.id,
      testId: attemptMatch[1],
      testTitle: test.title.trim(),
      score: Math.round((correctCount / test.questions.length) * 100),
      correctCount,
      questionCount: test.questions.length,
      answers: normalizedAnswers,
      testSnapshot: test.questions,
      createdAt
    };
    await env.DB.prepare(`
      INSERT INTO practice_attempts
        (id, student_id, test_id, test_title, score, correct_count, question_count, answers, test_snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      attempt.id,
      attempt.studentId,
      attempt.testId,
      attempt.testTitle,
      attempt.score,
      attempt.correctCount,
      attempt.questionCount,
      JSON.stringify(attempt.answers),
      JSON.stringify(attempt.testSnapshot),
      attempt.createdAt
    ).run();
    return response({
      attempt: {
        id: attempt.id,
        testId: attempt.testId,
        title: attempt.testTitle,
        score: attempt.score,
        correct: attempt.correctCount,
        total: attempt.questionCount,
        date: attempt.createdAt
      }
    }, 201);
  }

  const adminTestMatch = /^\/api\/practice-tests\/([a-zA-Z0-9_-]{1,100})$/.exec(pathname);
  if (adminTestMatch && request.method === 'PUT') {
    const access = await requireAdmin(request, env);
    if (access.error) return access.error;
    const input = await readJson(request);
    const test = input.test;
    if (!validPracticeTest(test) || (test.active !== undefined && typeof test.active !== 'boolean')) {
      return fail('Provide a title and 1–100 complete questions with a correct answer for each.');
    }
    const existing = await env.DB.prepare('SELECT created_at FROM documents WHERE collection = ? AND id = ?')
      .bind('practiceTests', adminTestMatch[1]).first();
    const now = new Date().toISOString();
    const data = {
      title: test.title.trim(),
      questions: test.questions.map(question => ({
        id: question.id,
        text: question.text.trim(),
        options: {
          a: question.options.a.trim(),
          b: question.options.b.trim(),
          c: question.options.c.trim()
        },
        correct: question.correct
      })),
      active: test.active !== false,
      updatedAt: now
    };
    await env.DB.prepare(`
      INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind('practiceTests', adminTestMatch[1], JSON.stringify(data), existing?.created_at || now, now).run();
    return response({ id: adminTestMatch[1], data });
  }

  return null;
}

async function handleAdminExport(request, env, pathname) {
  if (pathname !== '/api/admin/export' || request.method !== 'GET') return null;
  const access = await requireAdmin(request, env);
  if (access.error) return access.error;
  const documents = {};
  for (const collection of ['students', 'practiceTests', 'enquiries']) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await env.DB.prepare(`
        SELECT id, data, created_at, updated_at FROM documents
        WHERE collection = ? ORDER BY id LIMIT 500 OFFSET ?
      `).bind(collection, offset).all();
      rows.push(...page.results.map(row => ({
        id: row.id,
        data: parseData(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })));
      if (page.results.length < 500) break;
    }
    documents[collection] = rows;
  }
  const practiceAttempts = [];
  for (let offset = 0; ; offset += 500) {
    const page = await env.DB.prepare(`
      SELECT id, student_id, test_id, test_title, score, correct_count, question_count,
        answers, test_snapshot, created_at
      FROM practice_attempts ORDER BY created_at, id LIMIT 500 OFFSET ?
    `).bind(offset).all();
    practiceAttempts.push(...page.results.map(row => ({
      id: row.id,
      studentId: row.student_id,
      testId: row.test_id,
      testTitle: row.test_title,
      score: row.score,
      correct: row.correct_count,
      total: row.question_count,
      answers: JSON.parse(row.answers),
      testSnapshot: JSON.parse(row.test_snapshot),
      createdAt: row.created_at
    })));
    if (page.results.length < 500) break;
  }
  return response({
    exportedAt: new Date().toISOString(),
    documents,
    practiceAttempts
  }, 200, {
    'content-disposition': 'attachment; filename="spatial-vision-tech-export.json"',
    'cache-control': 'no-store'
  });
}

async function notifyStudentDocumentChange(env, previous, student, studentId) {
  const messages = [];
  if (!previous) {
    messages.push({
      to: student.email,
      subject: 'Your Spatial Vision Tech registration was received',
      text: `Hello ${student.name || 'student'},\n\nYour registration for ${student.course || 'your selected course'} has been received. No pre-registration payment is required. The administration team will review your application.\n\nStudent ID: ${student.studentId || studentId}\n\n${studentSummary(student)}`
    }, {
      to: ADMIN_EMAIL,
      subject: `New student registration: ${student.name || student.email || studentId}`,
      text: `A student registration is waiting for review. No pre-registration payment is required.\n\n${studentSummary(student)}`
    });
    return attemptEmails(env, messages);
  }

  const oldFees = Array.isArray(previous.feeHistory) ? previous.feeHistory : [];
  const newFees = Array.isArray(student.feeHistory) ? student.feeHistory : [];
  newFees.slice(oldFees.length).forEach(fee => {
    messages.push({
      to: student.email,
      subject: `Payment submission received: ${fee.receiptNo || fee.type || 'course fee'}`,
      text: `Hello ${student.name || 'student'},\n\nWe received your payment submission. It is pending verification.\n\nReceipt: ${fee.receiptNo || 'Not provided'}\nFee: ${fee.type || 'Course fee'}\nAmount: ₹${fee.amount || '0'}\nStatus: ${fee.status || 'Submitted - Pending Verification'}\n\n${studentSummary(student)}`
    }, {
      to: ADMIN_EMAIL,
      subject: `Payment submitted by ${student.name || student.email || studentId}`,
      text: `A student payment is waiting for verification.\n\nReceipt: ${fee.receiptNo || 'Not provided'}\nFee: ${fee.type || 'Course fee'}\nAmount: ₹${fee.amount || '0'}\nUTR: ${fee.utr || 'Not provided'}\n\n${studentSummary(student)}`
    });
  });

  newFees.forEach((fee, index) => {
    if (fee.status === 'Paid' && oldFees[index]?.status !== 'Paid') {
      messages.push({
        to: student.email,
        subject: `Payment verified: ${fee.receiptNo || fee.type || 'course fee'}`,
        text: `Hello ${student.name || 'student'},\n\nYour payment has been verified.\n\nReceipt: ${fee.receiptNo || 'Not provided'}\nFee: ${fee.type || 'Course fee'}\nAmount: ₹${fee.amount || '0'}\nVerified at: ${fee.verifiedAt || new Date().toISOString()}\n\n${studentSummary(student)}`
      });
    }
  });

  if (previous.approvalStatus !== student.approvalStatus && student.approvalStatus === 'Approved') {
    messages.push({
      to: student.email,
      subject: 'Your Spatial Vision Tech registration is approved',
      text: `Hello ${student.name || 'student'},\n\nYour registration has been approved. Sign in to the Student Portal to continue with your course.\n\n${studentSummary(student)}`
    });
  }

  if (previous.grantedAccess !== student.grantedAccess && student.grantedAccess === true) {
    messages.push({
      to: student.email,
      subject: 'Your Spatial Vision Tech Student Portal access is active',
      text: `Hello ${student.name || 'student'},\n\nYour Student Portal access has been granted. You can now sign in and access your student dashboard.\n\n${studentSummary(student)}`
    });
  }

  if (previous.approvalRequestAt !== student.approvalRequestAt && student.approvalRequestAt) {
    messages.push({
      to: ADMIN_EMAIL,
      subject: `Student requested an approval review: ${student.name || student.email || studentId}`,
      text: `A student has requested an approval review.\n\nRequest time: ${student.approvalRequestAt}\nRegistration approval status: ${student.approvalStatus || 'Pending'}\nPortal access: ${student.grantedAccess === true ? 'Granted' : 'Not granted'}\n\n${studentSummary(student)}`
    });
  }

  return attemptEmails(env, messages);
}

function mergeValue(current, incoming) {
  if (incoming && typeof incoming === 'object' && Array.isArray(incoming.__arrayUnion)) {
    const values = Array.isArray(current) ? current.slice() : [];
    incoming.__arrayUnion.forEach(item => {
      if (!values.some(value => JSON.stringify(value) === JSON.stringify(item))) values.push(item);
    });
    return values;
  }
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    return { ...(current && typeof current === 'object' ? current : {}), ...incoming };
  }
  return incoming;
}

async function handleAuth(request, env, pathname, url) {
  if (pathname === '/api/auth/password-salt' && request.method === 'GET') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
    if (typeof env.PASSWORD_PEPPER !== 'string' || env.PASSWORD_PEPPER.length < 32) {
      return fail('Account password service is not configured. Set the PASSWORD_PEPPER Worker secret and check Worker logs.', 503);
    }
    return response({ salt: await passwordSalt(email, env), iterations: PASSWORD_ITERATIONS });
  }

  if (pathname === '/api/auth/register' && request.method === 'POST') {
    const input = await readJson(request);
    const email = String(input.email || '').trim().toLowerCase();
    const verifier = input.passwordVerifier;
    const profile = input.profile || {};
    const name = String(profile.name || '').trim().slice(0, 200);
    const phone = String(profile.phone || '').trim().slice(0, 50);
    const course = String(profile.course || '').trim().slice(0, 200);
    const allowedCourses = new Set([
      'Pre-Course Orientation',
      'Studio 01: Revit Fundamentals',
      'Studio 02: Advanced Modelling',
      'Studio 03: Delivery & Coordination',
      'Autodesk Revit: Structural Modeling Masterclass',
      'Advanced BIM: Coordination & Clash Detection'
    ]);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
    if (email === ADMIN_EMAIL) return fail('The administrator account is reserved for initial setup.', 403);
    if (!isValidPassword(input.password)) return fail('Password must be 8–12 characters and include a letter, a number, and a symbol.');
    if (!isValidVerifier(verifier)) return fail('Password credentials are invalid.');
    if (typeof env.PASSWORD_PEPPER !== 'string' || env.PASSWORD_PEPPER.length < 32) {
      return fail('Account password service is not configured. Set the PASSWORD_PEPPER Worker secret and check Worker logs.', 503);
    }
    if (!name || !phone || !allowedCourses.has(course)) {
      return fail('Provide your name, phone number, and select a valid course.');
    }
    if (!await rateLimit(env, `register:${request.headers.get('CF-Connecting-IP') || 'unknown'}`, 8, 3600)) {
      return fail('Too many registration attempts. Please try again later.', 429);
    }
    const userId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const student = {
      uid: userId,
      studentId: `SVT/${new Date().getFullYear()}/${userId.slice(0, 6).toUpperCase()}`,
      name,
      email,
      phone,
      course,
      regDate: createdAt,
      approvalStatus: 'Pending',
      grantedAccess: false,
      finalizedFee: 4900,
      feeHistory: [],
      testAttempts: []
    };
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, email, await hashPasswordVerifier(verifier, env), 'student', createdAt),
        env.DB.prepare('INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind('students', userId, JSON.stringify(student), createdAt, createdAt),
        env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
          .bind(await digest(token), userId, expiresAt)
      ]);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return fail('An account already exists for this email address.', 409);
      throw error;
    }

    const failures = await notifyStudentDocumentChange(env, null, student, userId);
    return response({
      user: { uid: userId, email },
      student,
      notificationWarning: failures.length ? 'Registration saved, but one or more notification emails could not be delivered.' : null
    }, 201, {
      'set-cookie': cookieHeader(request, token, SESSION_DAYS * 86400)
    });
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    const input = await readJson(request);
    const email = String(input.email || '').trim().toLowerCase();
    const verifier = input.passwordVerifier;
    if (!isValidVerifier(verifier)) return fail('Incorrect email or password.', 401);
    if (!await rateLimit(env, `login:${request.headers.get('CF-Connecting-IP') || 'unknown'}`, 20, 900)) {
      return fail('Too many sign-in attempts. Please try again later.', 429);
    }
    const user = await env.DB.prepare('SELECT id, email, password_hash, role FROM users WHERE email = ?')
      .bind(email).first();
    const passwordHash = await hashPasswordVerifier(verifier, env);
    if (!user || !secureStringEqual(passwordHash, user.password_hash)) return fail('Incorrect email or password.', 401);

    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await digest(token), user.id, expiresAt).run();
    return response({ user: { uid: user.id, email: user.email, role: user.role } }, 200, {
      'set-cookie': cookieHeader(request, token, SESSION_DAYS * 86400)
    });
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(token)).run();
    return response({ success: true }, 200, { 'set-cookie': cookieHeader(request, '', 0) });
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await requireUser(request, env);
    return user
      ? response({ user: { uid: user.id, email: user.email, role: user.role } })
      : fail('Sign in to continue.', 401);
  }

  if (pathname === '/api/auth/reset' && request.method === 'POST') {
    const input = await readJson(request);
    const email = String(input.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
    if (!await rateLimit(env, `reset:${request.headers.get('CF-Connecting-IP') || 'unknown'}`, 20, 3600)) {
      return fail('Too many reset attempts. Please wait and try again.', 429);
    }
    const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
    const isAdminAccount = email === ADMIN_EMAIL;
    if (!user && isAdminAccount) {
      return fail('The Cloudflare administrator account has not been initialized. Complete setup at admin-setup.html before requesting a reset.', 404);
    }
    const resetRecipient = isAdminAccount
      ? typeof env.ADMIN_RESET_RECIPIENT === 'string' ? env.ADMIN_RESET_RECIPIENT.trim() : ''
      : email;
    if (isAdminAccount && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resetRecipient)) {
      return fail('Admin password reset is not configured. Set ADMIN_RESET_RECIPIENT to a verified Cloudflare Email Routing destination address.', 503);
    }
    if (user) {
      const token = randomToken();
      const tokenHash = await digest(token);
      await env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .bind(tokenHash, user.id, new Date(Date.now() + 3600000).toISOString()).run();
      const resetUrl = new URL('/reset-password.html', env.SITE_URL || new URL(request.url).origin);
      resetUrl.searchParams.set('token', token);
      const failures = await attemptEmails(env, [{
        to: resetRecipient,
        subject: 'Reset your Spatial Vision Tech password',
        text: `Hello,\n\nUse the following one-time link to reset your password within one hour:\n${resetUrl.href}\n\nIf you did not request this, you can ignore this email.`
      }]);
      if (failures.length) {
        await env.DB.prepare('DELETE FROM password_resets WHERE token_hash = ?').bind(tokenHash).run();
        if (isAdminAccount) {
          return fail('Cloudflare could not deliver the administrator reset email. Verify ADMIN_RESET_RECIPIENT is a verified Email Routing destination and check Email Service onboarding, the allowed sender, MAIL_FROM, and Worker logs.', 503);
        }
      }
    }
    return response({ success: true, message: 'If an account exists for this email, a reset link will arrive shortly.' });
  }

  if (pathname === '/api/auth/reset/salt' && request.method === 'GET') {
    const token = String(url.searchParams.get('token') || '');
    const reset = await env.DB.prepare(`
      SELECT users.email FROM password_resets
      JOIN users ON users.id = password_resets.user_id
      WHERE password_resets.token_hash = ? AND password_resets.expires_at > ?
    `).bind(await digest(token), new Date().toISOString()).first();
    if (!reset) return fail('This reset link is invalid or has expired.', 400);
    return response({ salt: await passwordSalt(reset.email, env), iterations: PASSWORD_ITERATIONS });
  }

  if (pathname === '/api/auth/reset/confirm' && request.method === 'POST') {
    const input = await readJson(request);
    const token = String(input.token || '');
    const verifier = input.passwordVerifier;
    if (!isValidPassword(input.password)) return fail('Password must be 8–12 characters and include a letter, a number, and a symbol.');
    if (!isValidVerifier(verifier)) return fail('Password credentials are invalid.');
    const reset = await env.DB.prepare('SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?')
      .bind(await digest(token), new Date().toISOString()).first();
    if (!reset) return fail('This reset link is invalid or has expired.', 400);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPasswordVerifier(verifier, env), reset.user_id),
      env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(reset.user_id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(reset.user_id)
    ]);
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(reset.user_id).first();
    const failures = await attemptEmails(env, [{
      to: user.email,
      subject: 'Your Spatial Vision Tech password was changed',
      text: 'Your password was changed successfully. If you did not make this change, contact Spatial Vision Tech support immediately.'
    }]);
    return response({
      success: true,
      notificationWarning: failures.length ? 'Password changed, but the confirmation email could not be delivered.' : null
    });
  }

  return null;
}

async function handleAdminSetup(request, env, pathname) {
  if (pathname === '/api/setup/admin' && request.method === 'POST') {
    const input = await readJson(request);
    if (!env.ADMIN_BOOTSTRAP_TOKEN || input.setupToken !== env.ADMIN_BOOTSTRAP_TOKEN) {
      return fail('Invalid administrator setup token.', 403);
    }
    const adminCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").first();
    if (adminCount.count > 0) return fail('The administrator account has already been initialized.', 409);
    const verifier = input.passwordVerifier;
    if (!isValidPassword(input.password)) return fail('Password must be 8–12 characters and include a letter, a number, and a symbol.');
    if (!isValidVerifier(verifier)) return fail('Password credentials are invalid.');
    const userId = crypto.randomUUID();
    try {
      await env.DB.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, ADMIN_EMAIL, await hashPasswordVerifier(verifier, env), 'admin', new Date().toISOString()).run();
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return fail('The administrator email is already registered.', 409);
      throw error;
    }
    return response({ success: true });
  }
  return null;
}

async function handleStudentFiles(request, env, pathname) {
  const match = /^\/api\/students\/([^/]+)\/files$/.exec(pathname);
  if (!match || request.method !== 'POST') return null;
  const user = await requireUser(request, env);
  if (!user) return fail('Sign in to upload a file.', 401);
  if (user.role !== 'admin' && user.id !== match[1]) return fail('You can only upload files to your own student account.', 403);

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size < 1) return fail('Choose a file to upload.');
  if (file.size > MAX_UPLOAD_BYTES) return fail('Files must be 10 MB or smaller.');
  if (!ALLOWED_UPLOAD_TYPES.has(file.type)) return fail('Upload a PDF, image, or Word document.');

  const student = await env.DB.prepare('SELECT data FROM documents WHERE collection = ? AND id = ?')
    .bind('students', match[1]).first();
  if (!student) return fail('Student record not found.', 404);
  const studentData = parseData(student);
  const fileId = crypto.randomUUID();
  const key = `students/${match[1]}/${fileId}/${file.name.replace(/[^\w.-]/g, '_')}`;
  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { studentUid: match[1], uploadedBy: user.id }
  });
  try {
    await env.DB.prepare('INSERT INTO student_files (id, student_id, object_key, filename, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(fileId, match[1], key, file.name, file.type, file.size, new Date().toISOString()).run();
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }

  const details = `${studentSummary(studentData)}\nFile: ${file.name}\nSize: ${file.size.toLocaleString('en-IN')} bytes`;
  const failures = await attemptEmails(env, [
    { to: studentData.email, subject: 'Your file upload was received', text: `Hello ${studentData.name || 'student'},\n\nYour file upload has been received.\n\n${details}` },
    { to: ADMIN_EMAIL, subject: `File uploaded by ${studentData.name || studentData.email}`, text: `A student uploaded a file for review.\n\n${details}` }
  ]);
  return response({
    file: { id: fileId, name: file.name, size: file.size, contentType: file.type, createdAt: new Date().toISOString() },
    notificationWarning: failures.length ? 'File saved, but one or more notification emails could not be delivered.' : null
  }, 201);
}

async function handleCollections(request, env, pathname, url) {
  const match = /^\/api\/collections\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  const [, collection, documentId] = match;
  if (!safeCollectionName(collection)) return fail('Unknown collection.', 404);
  const user = await requireUser(request, env);
  const isAdmin = user?.role === 'admin';

  if (collection === 'practiceTests' && request.method === 'GET' && !user) {
    return fail('Sign in to access practice tests.', 401);
  }
  if (collection === 'students') {
    if (!user) return fail('Sign in to access student records.', 401);
    if (!isAdmin && documentId && documentId !== user.id) return fail('You can only access your own student record.', 403);
  }
  if (collection === 'practiceTests' && request.method !== 'GET' && !isAdmin) {
    return fail('Administrator access is required.', 403);
  }
  if (collection === 'enquiries' && request.method !== 'POST') return fail('Unknown collection.', 404);

  if (request.method === 'GET' && documentId) {
    const row = await env.DB.prepare('SELECT id, data FROM documents WHERE collection = ? AND id = ?')
      .bind(collection, documentId).first();
    const data = parseData(row);
    if (collection === 'practiceTests' && data?.active === false && !isAdmin) return fail('Record not found.', 404);
    return row
      ? response({ id: row.id, data: collection === 'practiceTests' && !isAdmin ? publicPracticeTest(data) : data })
      : fail('Record not found.', 404);
  }

  if (request.method === 'GET' && !documentId) {
    let statement;
    if (collection === 'students' && !isAdmin) {
      statement = env.DB.prepare('SELECT id, data FROM documents WHERE collection = ? AND id = ?')
        .bind(collection, user.id);
    } else {
      statement = env.DB.prepare('SELECT id, data FROM documents WHERE collection = ? ORDER BY created_at DESC LIMIT 500')
        .bind(collection);
    }
    const results = await statement.all();
    const documents = results.results
      .map(row => ({ id: row.id, data: parseData(row) }))
      .filter(doc => collection !== 'practiceTests' || isAdmin || doc.data?.active !== false)
      .map(doc => ({
        ...doc,
        data: collection === 'practiceTests' && !isAdmin ? publicPracticeTest(doc.data) : doc.data
      }));
    const whereField = url.searchParams.get('whereField');
    const whereValue = url.searchParams.get('whereValue');
    const filtered = whereField ? documents.filter(doc => String(doc.data[whereField] || '').toLowerCase() === String(whereValue || '').toLowerCase()) : documents;
    const orderBy = url.searchParams.get('orderBy');
    const direction = url.searchParams.get('direction') === 'desc' ? -1 : 1;
    if (orderBy) filtered.sort((a, b) => direction * String(a.data[orderBy] || '').localeCompare(String(b.data[orderBy] || '')));
    const limit = Number(url.searchParams.get('limit')) || filtered.length;
    const limited = filtered.slice(0, Math.min(limit, 500));
    return response({ documents: limited });
  }

  if (request.method === 'POST' && collection === 'enquiries') {
    const input = await readJson(request);
    const name = String(input.name || '').trim().slice(0, 200);
    const email = String(input.email || '').trim().toLowerCase().slice(0, 254);
    const phone = String(input.phone || '').trim().slice(0, 50);
    const message = String(input.message || '').trim().slice(0, 5000);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) return fail('Enter your name, a valid email, and a message.');
    if (!await rateLimit(env, `contact:${request.headers.get('CF-Connecting-IP') || 'unknown'}`, 10, 3600)) {
      return fail('Too many messages. Please try again later.', 429);
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const enquiry = { name, email, phone, message, createdAt };
    await env.DB.prepare('INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind('enquiries', id, JSON.stringify(enquiry), createdAt, createdAt).run();
    const failures = await attemptEmails(env, [{
      to: ADMIN_EMAIL,
      subject: `Website contact from ${name}`,
      text: `A new website contact message was received.\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\nReceived: ${createdAt}\n\nMessage:\n${message}`
    }]);
    return response({ id, data: enquiry, notificationWarning: failures.length ? 'Message saved, but the admin notification email could not be delivered.' : null }, 201);
  }

  if ((request.method === 'PUT' || request.method === 'DELETE') && !documentId) {
    return fail('A record ID is required.', 400);
  }

  if (request.method === 'PUT') {
    const input = await readJson(request);
    const currentRow = await env.DB.prepare('SELECT data, created_at FROM documents WHERE collection = ? AND id = ?')
      .bind(collection, documentId).first();
    const previous = parseData(currentRow);
    if (collection === 'students') {
      if (!isAdmin && !previous && documentId !== user.id) return fail('You can only create your own student record.', 403);
      if (!isAdmin && previous) {
        const allowedFields = new Set(['feeHistory', 'approvalRequestAt']);
        if (Object.keys(input.data || {}).some(key => !allowedFields.has(key))) return fail('This account cannot change the requested student fields.', 403);
      }
    }

    let next;
    let updates = input.data;
    if (input.mode === 'set') {
      if (collection === 'students' && !isAdmin && !previous) {
        return fail('Student records must be created through the registration form.', 403);
      }
      next = input.data;
    } else if (input.mode === 'update') {
      if (!previous) return fail('Record not found.', 404);
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return fail('Record updates must be an object.');
      if (collection === 'students' && !isAdmin) {
        updates = { ...updates };
        if (Object.hasOwn(updates, 'feeHistory')) {
          const fees = updates.feeHistory && updates.feeHistory.__arrayUnion;
          if (!Array.isArray(fees) || !fees.length || fees.length > 5) return fail('Payment submissions must be appended as new fee records.');
          const normalizedFees = [];
          for (const fee of fees) {
            if (!fee || typeof fee !== 'object') return fail('Provide a valid payment record.');
            const amount = Number(fee.amount);
            if (!Number.isFinite(amount) || amount <= 0 || amount > 500000 ||
                typeof fee.type !== 'string' || !fee.type.trim() || typeof fee.utr !== 'string' || !fee.utr.trim()) {
              return fail('Provide a valid payment amount, fee type, and transaction reference.');
            }
            normalizedFees.push({
              receiptNo: String(fee.receiptNo || '').slice(0, 80),
              type: fee.type.trim().slice(0, 120),
              amount: String(amount),
              utr: fee.utr.trim().slice(0, 120),
              status: 'Submitted - Pending Verification',
              date: new Date().toISOString()
            });
          }
          updates.feeHistory = { __arrayUnion: normalizedFees };
        }
        if (Object.hasOwn(updates, 'approvalRequestAt')) {
          if (!await rateLimit(env, `approval:${documentId}`, 1, 86400)) {
            return fail('You have already requested an approval review recently.', 429);
          }
          updates.approvalRequestAt = new Date().toISOString();
        }
      }
      next = { ...previous };
      Object.entries(updates || {}).forEach(([key, value]) => {
        next[key] = mergeValue(next[key], value);
      });
    } else {
      return fail('Invalid record operation.');
    }

    if (!next || typeof next !== 'object' || Array.isArray(next)) return fail('Record data must be an object.');
    if (collection === 'practiceTests' &&
        (!validPracticeTest(next) || (next.active !== undefined && typeof next.active !== 'boolean'))) {
      return fail('Provide a title and 1–100 complete questions with a correct answer for each.');
    }
    if (collection === 'students' && !isAdmin && next.email?.toLowerCase() !== user.email.toLowerCase()) {
      return fail('Student record email must match the signed-in account.', 403);
    }
    if (collection === 'students' && !isAdmin && next.uid !== user.id) return fail('Student record ID does not match your account.', 403);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO documents (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind(collection, documentId, JSON.stringify(next), currentRow?.created_at || now, now).run();

    let notificationWarning = null;
    if (collection === 'students' && (!previous || JSON.stringify(previous) !== JSON.stringify(next))) {
      const failures = await notifyStudentDocumentChange(env, previous, next, documentId);
      if (failures.length) notificationWarning = 'Record saved, but one or more notification emails could not be delivered.';
    }
    return response({ id: documentId, data: next, notificationWarning });
  }

  if (request.method === 'DELETE') {
    if (!isAdmin || collection !== 'students') return fail('Administrator access is required.', 403);
    let cursor;
    do {
      const page = await env.FILES.list({ prefix: `students/${documentId}/`, cursor });
      if (page.objects.length) await env.FILES.delete(page.objects.map(object => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM documents WHERE collection = ? AND id = ?').bind(collection, documentId),
      env.DB.prepare('DELETE FROM student_files WHERE student_id = ?').bind(documentId),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(documentId)
    ]);
    return response({ success: true });
  }

  return fail('Method not allowed.', 405);
}

async function handleAdminCallable(request, env, pathname) {
  const saltMatch = /^\/api\/admin\/students\/([^/]+)\/password-salt$/.exec(pathname);
  if (saltMatch && request.method === 'GET') {
    const access = await requireAdmin(request, env);
    if (access.error) return access.error;
    const record = await env.DB.prepare('SELECT data FROM documents WHERE collection = ? AND id = ?')
      .bind('students', saltMatch[1]).first();
    if (!record) return fail('Student record not found.', 404);
    const student = parseData(record);
    return response({ salt: await passwordSalt(student.email, env), iterations: PASSWORD_ITERATIONS });
  }

  const match = /^\/api\/admin\/students\/([^/]+)\/password$/.exec(pathname);
  if (!match || request.method !== 'POST') return null;
  const access = await requireAdmin(request, env);
  if (access.error) return access.error;
  const input = await readJson(request);
  const verifier = input.passwordVerifier;
  if (!isValidPassword(input.password)) return fail('Password must be 8–12 characters and include a letter, a number, and a symbol.');
  if (!isValidVerifier(verifier)) return fail('Password credentials are invalid.');
  const studentId = match[1];
  const studentRow = await env.DB.prepare('SELECT data FROM documents WHERE collection = ? AND id = ?')
    .bind('students', studentId).first();
  if (!studentRow) return fail('Student record not found.', 404);
  const student = parseData(studentRow);
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(studentId).first();
  if (!user || user.email !== student.email) return fail('Student record does not match an account.', 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPasswordVerifier(verifier, env), studentId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(studentId)
  ]);
  const failures = await attemptEmails(env, [{
    to: user.email,
    subject: 'Your Spatial Vision Tech password was changed',
    text: 'An administrator changed your password. If you did not expect this, use the Student Portal password-reset link or contact the administration team.'
  }]);
  return response({ success: true, notificationWarning: failures.length ? 'Password changed, but the confirmation email could not be delivered.' : null });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return fail('Cross-origin requests are not allowed.', 403);
    try {
      const authResponse = await handleAuth(request, env, url.pathname, url);
      if (authResponse) return authResponse;
      const setupResponse = await handleAdminSetup(request, env, url.pathname);
      if (setupResponse) return setupResponse;
      const fileResponse = await handleStudentFiles(request, env, url.pathname);
      if (fileResponse) return fileResponse;
      const adminResponse = await handleAdminCallable(request, env, url.pathname);
      if (adminResponse) return adminResponse;
      const practiceResponse = await handlePracticeTests(request, env, url.pathname);
      if (practiceResponse) return practiceResponse;
      const exportResponse = await handleAdminExport(request, env, url.pathname);
      if (exportResponse) return exportResponse;
      const collectionResponse = await handleCollections(request, env, url.pathname, url);
      if (collectionResponse) return collectionResponse;
      return fail('Not found.', 404);
    } catch (error) {
      console.error('Cloudflare API request failed:', error);
      return fail('The request could not be completed. Please try again.', 500);
    }
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch: handleRequest
};
