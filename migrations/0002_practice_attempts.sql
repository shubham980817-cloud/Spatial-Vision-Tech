CREATE TABLE IF NOT EXISTS practice_attempts (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL,
  test_title TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  correct_count INTEGER NOT NULL,
  question_count INTEGER NOT NULL CHECK (question_count > 0),
  answers TEXT NOT NULL CHECK (json_valid(answers)),
  test_snapshot TEXT NOT NULL CHECK (json_valid(test_snapshot)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS practice_attempts_student_created_idx
  ON practice_attempts(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS practice_attempts_test_created_idx
  ON practice_attempts(test_id, created_at DESC);

INSERT OR IGNORE INTO documents (collection, id, data, created_at, updated_at)
SELECT
  'practiceTests',
  'bim-foundations',
  json_object(
    'title', 'BIM Foundations Test',
    'active', json('true'),
    'questions', json('[{"id":"q1","text":"What does BIM primarily manage?","options":{"a":"Only 2D drawings","b":"Information connected to a digital building model","c":"Site attendance only"},"correct":"b"},{"id":"q2","text":"Which workflow is most associated with Navisworks?","options":{"a":"Clash detection and coordination","b":"Payroll processing","c":"Email marketing"},"correct":"a"},{"id":"q3","text":"What is a Revit family?","options":{"a":"A project invoice","b":"A reusable parametric component","c":"A site safety report"},"correct":"b"},{"id":"q4","text":"What does a federated model combine?","options":{"a":"Separate discipline models for coordination","b":"Student passwords","c":"Payment receipts only"},"correct":"a"},{"id":"q5","text":"ISO 19650 is focused on:","options":{"a":"Managing information over an asset lifecycle","b":"Rendering only","c":"Computer hardware repair"},"correct":"a"}]'),
    'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
