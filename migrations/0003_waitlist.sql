-- Sign-ups from the landing page's "Get your URL" form. Nothing is sent automatically.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  libraries TEXT,
  lang TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
