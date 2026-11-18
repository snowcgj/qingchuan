CREATE TABLE rooms (
  id TEXT PRIMARY KEY NOT NULL,
  receiver TEXT NOT NULL,
  sender TEXT NOT NULL,
  offer TEXT,
  answer TEXT,
  claimed INTEGER DEFAULT 0 NOT NULL,
  expires INTEGER NOT NULL,
  creator TEXT NOT NULL
);
