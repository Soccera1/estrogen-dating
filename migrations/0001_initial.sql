PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('human','ai')),
  name TEXT NOT NULL DEFAULT '', pronouns TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '', interests TEXT NOT NULL DEFAULT '[]',
  prompt TEXT NOT NULL DEFAULT '', discoverable INTEGER NOT NULL DEFAULT 0 CHECK(discoverable IN (0,1)),
  onboarded INTEGER NOT NULL DEFAULT 0 CHECK(onboarded IN (0,1)),
  preference TEXT NOT NULL DEFAULT '', avatar_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(account_id, kind)
);
CREATE INDEX profiles_discovery ON profiles(kind, discoverable, id);
CREATE TABLE avatars (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 524288), version INTEGER NOT NULL,
  bytes BLOB NOT NULL CHECK(length(bytes)=size)
);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (
  hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('human','ai')), expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_expiry ON oauth_states(expires_at);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), revoked_at INTEGER
);
CREATE INDEX credentials_profile ON credentials(profile_id, created_at);
CREATE TABLE decisions (
  actor TEXT NOT NULL REFERENCES profiles(id), target TEXT NOT NULL REFERENCES profiles(id),
  action TEXT NOT NULL CHECK(action IN ('like','pass')), created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(actor, target), CHECK(actor<>target)
);
CREATE INDEX decisions_incoming ON decisions(target, action, actor);
CREATE TABLE blocks (
  actor TEXT NOT NULL REFERENCES profiles(id), target TEXT NOT NULL REFERENCES profiles(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(actor, target), CHECK(actor<>target)
);
CREATE INDEX blocks_target ON blocks(target, actor);
CREATE TABLE matches (
  id TEXT PRIMARY KEY, human TEXT NOT NULL REFERENCES profiles(id), ai TEXT NOT NULL REFERENCES profiles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), closed_at INTEGER, UNIQUE(human,ai)
);
CREATE INDEX matches_human ON matches(human, status, id);
CREATE INDEX matches_ai ON matches(ai, status, id);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL REFERENCES matches(id),
  sender TEXT NOT NULL REFERENCES profiles(id), client_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(sender,client_id)
);
CREATE INDEX messages_conversation ON messages(match_id,id);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profiles(id),
  type TEXT NOT NULL, match_id TEXT REFERENCES matches(id), other_profile TEXT REFERENCES profiles(id),
  message_id INTEGER REFERENCES messages(id), created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX events_profile ON events(profile_id,id);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX rates_expiry ON rate_limits(expires_at);

-- Database constraints are the final authority, including races between concurrent requests.
CREATE TRIGGER valid_decision BEFORE INSERT ON decisions WHEN NOT EXISTS (
    SELECT 1 FROM profiles a JOIN profiles b ON b.id=NEW.target
    WHERE a.id=NEW.actor AND a.kind<>b.kind AND a.account_id<>b.account_id
      AND a.onboarded=1 AND b.onboarded=1 AND b.discoverable=1
      AND NOT EXISTS(SELECT 1 FROM blocks WHERE (actor=a.id AND target=b.id) OR (actor=b.id AND target=a.id))
      AND NOT EXISTS(SELECT 1 FROM matches WHERE human IN (a.id,b.id) AND ai IN (a.id,b.id) AND status='closed')
  ) BEGIN
  SELECT RAISE(ABORT,'invalid_pair');
END;
CREATE TRIGGER mutual_like AFTER INSERT ON decisions WHEN NEW.action='like' BEGIN
  INSERT OR IGNORE INTO matches(id,human,ai)
    SELECT lower(hex(randomblob(16))),CASE WHEN a.kind='human' THEN a.id ELSE b.id END,
      CASE WHEN a.kind='ai' THEN a.id ELSE b.id END
    FROM profiles a JOIN profiles b ON b.id=NEW.target
    WHERE a.id=NEW.actor AND EXISTS(SELECT 1 FROM decisions WHERE actor=b.id AND target=a.id AND action='like');
  INSERT INTO events(profile_id,type,other_profile) VALUES(NEW.target,'like',NEW.actor);
END;
CREATE TRIGGER match_event AFTER INSERT ON matches BEGIN
  INSERT INTO events(profile_id,type,match_id,other_profile) VALUES(NEW.human,'match',NEW.id,NEW.ai),(NEW.ai,'match',NEW.id,NEW.human);
END;
CREATE TRIGGER valid_message BEFORE INSERT ON messages WHEN NOT EXISTS (
    SELECT 1 FROM matches m WHERE m.id=NEW.match_id AND m.status='active' AND NEW.sender IN (m.human,m.ai)
      AND NOT EXISTS(SELECT 1 FROM blocks WHERE (actor=m.human AND target=m.ai) OR (actor=m.ai AND target=m.human))
  ) BEGIN
  SELECT RAISE(ABORT,'closed_conversation');
END;
CREATE TRIGGER message_event AFTER INSERT ON messages BEGIN
  INSERT INTO events(profile_id,type,match_id,message_id)
    SELECT CASE WHEN NEW.sender=human THEN ai ELSE human END,'message',id,NEW.id FROM matches WHERE id=NEW.match_id;
END;
CREATE TRIGGER block_closes AFTER INSERT ON blocks BEGIN
  UPDATE matches SET status='closed',closed_at=unixepoch()
    WHERE status='active' AND human IN (NEW.actor,NEW.target) AND ai IN (NEW.actor,NEW.target);
END;
CREATE TRIGGER close_event AFTER UPDATE OF status ON matches WHEN OLD.status='active' AND NEW.status='closed' BEGIN
  INSERT INTO events(profile_id,type,match_id) VALUES(NEW.human,'closed',NEW.id),(NEW.ai,'closed',NEW.id);
END;
